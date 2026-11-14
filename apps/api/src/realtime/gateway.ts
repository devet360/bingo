import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { WinPattern } from '@prisma/client';
import { Server } from 'socket.io';
import { z } from 'zod';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/errors';
import { verifyAccessToken } from '../services/jwt';
import {
  buyCards,
  getActiveRound,
  getRoundForViewer,
  resolveRoom,
  submitClaim,
} from '../services/bingo';
import { serializeCard, serializeClaim, serializeRound, serializeRoom, serializeWallet } from '../lib/serializers';
import { bingoEvents, type BingoEvent } from './events';

interface SocketAuth {
  userId: string;
  role: string;
}

type Ack = (response: unknown) => void;

const SubscribeSchema = z
  .object({
    roomId: z.string().uuid().optional(),
    roomCode: z.string().min(1).max(64).optional(),
  })
  .refine((value) => Boolean(value.roomId ?? value.roomCode), {
    message: 'roomId or roomCode is required',
  });

const BuySchema = z.object({
  roomId: z.string().uuid().optional(),
  roomCode: z.string().min(1).max(64).optional(),
  quantity: z.number().int().min(1).max(4),
  clientSeed: z.string().max(128).optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const ClaimSchema = z.object({
  roundId: z.string().uuid(),
  cardId: z.string().uuid(),
  pattern: z.nativeEnum(WinPattern),
});

function failure(error: unknown): { error: { code: string; message: string } } {
  if (error instanceof AppError) {
    return { error: { code: error.code, message: error.message } };
  }
  if (error instanceof z.ZodError) {
    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: error.issues.map((issue) => issue.message).join('; '),
      },
    };
  }
  logger.error({ err: error }, 'socket handler failed');
  return { error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } };
}

function roomChannel(roomId: string): string {
  return `room:${roomId}`;
}

async function broadcast(event: BingoEvent, io: Server): Promise<void> {
  switch (event.type) {
    case 'ball':
      io.to(roomChannel(event.roomId)).emit('ball:drawn', {
        roundId: event.roundId,
        ball: event.ball,
        index: event.index,
        drawnCount: event.drawnCount,
        status: event.status,
      });
      return;

    case 'state': {
      const round = await prisma.bingoRound.findUnique({ where: { id: event.roundId } });
      if (round) io.to(roomChannel(event.roomId)).emit('round:state', serializeRound(round));
      return;
    }

    case 'claiming':
      io.to(roomChannel(event.roomId)).emit('round:claiming', {
        roundId: event.roundId,
        claimsCloseAt: event.claimsCloseAt,
        detectedWinners: event.detectedWinners,
      });
      return;

    case 'settled':
      io.to(roomChannel(event.roomId)).emit('round:settled', {
        roundId: event.roundId,
        winners: event.winners,
        rake: event.rake,
        prizePool: event.prizePool,
        serverSeed: event.serverSeed,
      });
      return;

    case 'cancelled':
      io.to(roomChannel(event.roomId)).emit('round:cancelled', {
        roundId: event.roundId,
        reason: event.reason,
      });
      return;

    case 'wallet':
      io.to(`user:${event.userId}`).emit('wallet:update', event.wallet);
      return;
  }
}

export function createRealtime(server: HttpServer): Server {
  const io = new Server(server, {
    cors: {
      origin: env.corsOrigins.length > 0 ? env.corsOrigins : false,
      credentials: true,
    },
    pingInterval: 20_000,
    pingTimeout: 25_000,
    maxHttpBufferSize: 256 * 1024,
  });

  io.use((socket, next) => {
    const raw = socket.handshake.auth?.token ?? socket.handshake.query.token;
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token || typeof token !== 'string') {
      next(new Error('UNAUTHORIZED'));
      return;
    }
    try {
      const claims = verifyAccessToken(token);
      socket.data.userId = claims.sub;
      socket.data.role = claims.role;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const auth = socket.data as SocketAuth;
    void socket.join(`user:${auth.userId}`);

    socket.on('room:subscribe', async (payload: unknown, ack?: Ack) => {
      try {
        const body = SubscribeSchema.parse(payload);
        const room = await resolveRoom(body);
        const round = await getActiveRound(room.id);
        const cards = round ? await prisma.bingoCard.findMany({ where: { roundId: round.id, userId: auth.userId } }) : [];
        await socket.join(roomChannel(room.id));
        ack?.({
          room: serializeRoom(room),
          round: round ? serializeRound(round) : null,
          myCards: cards.map(serializeCard),
        });
      } catch (error) {
        ack?.(failure(error));
      }
    });

    socket.on('room:unsubscribe', async (payload: unknown, ack?: Ack) => {
      try {
        const body = SubscribeSchema.parse(payload);
        const room = await resolveRoom(body);
        await socket.leave(roomChannel(room.id));
        ack?.({ ok: true });
      } catch (error) {
        ack?.(failure(error));
      }
    });

    socket.on('cards:buy', async (payload: unknown, ack?: Ack) => {
      try {
        const body = BuySchema.parse(payload);
        const result = await buyCards({
          userId: auth.userId,
          roomId: body.roomId,
          roomCode: body.roomCode,
          quantity: body.quantity,
          clientSeed: body.clientSeed,
          idempotencyKey: `${auth.userId}:${body.idempotencyKey ?? randomUUID()}`,
        });
        const wallet = await prisma.wallet.findUnique({ where: { userId: auth.userId } });
        ack?.({
          round: serializeRound(result.round),
          cards: result.cards.map(serializeCard),
          wallet: wallet ? serializeWallet(wallet) : null,
          replayed: result.replayed,
        });
      } catch (error) {
        ack?.(failure(error));
      }
    });

    socket.on('claim:submit', async (payload: unknown, ack?: Ack) => {
      try {
        const body = ClaimSchema.parse(payload);
        const { claim, replayed } = await submitClaim({
          userId: auth.userId,
          roundId: body.roundId,
          cardId: body.cardId,
          pattern: body.pattern,
        });
        ack?.({ claim: serializeClaim(claim), replayed });
      } catch (error) {
        ack?.(failure(error));
      }
    });

    socket.on('round:view', async (payload: unknown, ack?: Ack) => {
      try {
        const body = z.object({ roundId: z.string().uuid() }).parse(payload);
        const view = await getRoundForViewer(body.roundId, auth.userId);
        ack?.({
          round: serializeRound(view.round),
          room: serializeRoom(view.room),
          myCards: view.cards.map(serializeCard),
          claimCount: view.claimCount,
        });
      } catch (error) {
        ack?.(failure(error));
      }
    });

    socket.on('error', (error) => logger.warn({ err: error, userId: auth.userId }, 'socket error'));
  });

  bingoEvents.subscribe((event) => {
    void broadcast(event, io).catch((error) =>
      logger.error({ err: error, event: event.type }, 'socket broadcast failed'),
    );
  });

  return io;
}
