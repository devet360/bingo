import { Router } from 'express';
import { WinPattern } from '@prisma/client';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { Errors } from '../lib/errors';
import { prisma } from '../lib/prisma';
import {
  serializeCard,
  serializeClaim,
  serializeRoom,
  serializeRound,
} from '../lib/serializers';
import { authenticate, requireVerifiedPhone } from '../middleware/auth';
import { moneyLimiter } from '../middleware/rateLimit';
import {
  buyCards,
  getRoomByCode,
  getRoundForViewer,
  listMyCards,
  listRooms,
  roomHistory,
  submitClaim,
  verifyRound,
} from '../services/bingo';
import { scopedIdempotencyKey } from '../services/wallet';

const BuyCardsSchema = z.object({
  quantity: z.number().int().min(1).max(4),
  clientSeed: z.string().max(128).optional(),
});

const ClaimSchema = z.object({
  cardId: z.string().uuid(),
  pattern: z.nativeEnum(WinPattern),
});

const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const bingoRouter = Router();

bingoRouter.get(
  '/rooms',
  asyncHandler(async (_req, res) => {
    const rooms = await listRooms();
    res.json({
      data: rooms.map(({ room, round }) => ({
        room: serializeRoom(room),
        round: round
          ? {
              id: round.id,
              roundNumber: round.roundNumber,
              status: round.status,
              cardsSold: round.cardsSold,
              uniquePlayers: round.uniquePlayers,
              prizePool: round.prizePool,
              currentBall: round.currentBall,
              purchaseClosesAt: round.purchaseClosesAt,
            }
          : null,
      })),
    });
  }),
);

bingoRouter.get(
  '/rooms/:code',
  asyncHandler(async (req, res) => {
    const { room, round } = await getRoomByCode(req.params.code);
    const history = await roomHistory(room.id, 5);
    res.json({
      data: {
        room: serializeRoom(room),
        round: round ? serializeRound(round) : null,
        recentRounds: history.map(serializeRound),
      },
    });
  }),
);

bingoRouter.get(
  '/rooms/:code/history',
  asyncHandler(async (req, res) => {
    const { limit } = parse(HistoryQuery, req.query);
    const { room } = await getRoomByCode(req.params.code);
    const history = await roomHistory(room.id, limit);
    res.json({ data: history.map(serializeRound) });
  }),
);

bingoRouter.get(
  '/rounds/:id',
  asyncHandler(async (req, res) => {
    const view = await getRoundForViewer(req.params.id);
    res.json({
      data: {
        round: serializeRound(view.round),
        room: serializeRoom(view.room),
        claimCount: view.claimCount,
      },
    });
  }),
);

bingoRouter.get(
  '/rounds/:id/verify',
  asyncHandler(async (req, res) => {
    const proof = await verifyRound(req.params.id);
    res.json({ data: proof });
  }),
);

bingoRouter.get(
  '/rounds/:id/my-cards',
  authenticate,
  asyncHandler(async (req, res) => {
    const round = await prisma.bingoRound.findUnique({ where: { id: req.params.id } });
    if (!round) throw Errors.notFound('Round');
    const cards = await listMyCards(round.id, req.auth!.userId);
    res.json({ data: cards.map(serializeCard) });
  }),
);

bingoRouter.post(
  '/rooms/:code/cards',
  authenticate,
  requireVerifiedPhone,
  moneyLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(BuyCardsSchema, req.body);
    const result = await buyCards({
      userId: req.auth!.userId,
      roomCode: req.params.code,
      quantity: body.quantity,
      clientSeed: body.clientSeed,
      idempotencyKey: scopedIdempotencyKey(req),
    });
    res.status(result.replayed ? 200 : 201).json({
      data: {
        round: serializeRound(result.round),
        cards: result.cards.map(serializeCard),
      },
      replayed: result.replayed,
    });
  }),
);

bingoRouter.post(
  '/rounds/:id/claims',
  authenticate,
  asyncHandler(async (req, res) => {
    const body = parse(ClaimSchema, req.body);
    const { claim, replayed } = await submitClaim({
      userId: req.auth!.userId,
      roundId: req.params.id,
      cardId: body.cardId,
      pattern: body.pattern,
    });
    res.status(replayed ? 200 : 201).json({ data: serializeClaim(claim), replayed });
  }),
);
