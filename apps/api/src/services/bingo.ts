import { randomUUID } from 'node:crypto';
import {
  NotificationType,
  type BingoCard,
  type BingoRoom,
  type BingoRound,
  type Prisma,
  type RoundStatus,
  type WinPattern,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { isUniqueViolation, runTransaction, withTxRetry } from '../lib/tx';
import { advisoryXactLock } from '../lib/dbLock';
import { postLedger } from './ledger';
import { generateCard } from '../game/cards';
import { completedPatterns, PATTERN_PRIORITY, validateClaim } from '../game/patterns';
import { computeEconomics, splitPrize } from '../game/payout';
import {
  aggregateClientSeed,
  computeSeedHash,
  deriveBallOrder,
  generateServerSeed,
} from '../game/rng';
import {
  cardNumbers,
  parseCardCells,
  VARIANT_RULES,
  type WinPatternName,
} from '../game/types';
import { bingoEvents } from '../realtime/events';

const ACTIVE_ROUND_STATUSES: RoundStatus[] = [
  'WAITING',
  'LOCKED',
  'PLAYING',
  'CLAIM_VERIFICATION',
];

const UNDERFILLED_EXTENSION_MS = 10_000;
const MAX_UNDERFILLED_WAIT_MS = 5 * 60_000;

type ActiveStatus = (typeof ACTIVE_ROUND_STATUSES)[number];

interface PurchaseInput {
  userId: string;
  roomId?: string;
  roomCode?: string;
  quantity: number;
  clientSeed?: string;
  /** Caller-scoped: "<userId>:<client key>". */
  idempotencyKey: string;
}

// ─────────────────────────────── rounds ───────────────────────────────

export async function resolveRoom(input: { roomId?: string; roomCode?: string }): Promise<BingoRoom> {
  const room = input.roomId
    ? await prisma.bingoRoom.findUnique({ where: { id: input.roomId } })
    : input.roomCode
      ? await prisma.bingoRoom.findUnique({ where: { code: input.roomCode } })
      : null;
  if (!room) throw Errors.notFound('Room');
  return room;
}

export async function getActiveRound(roomId: string): Promise<BingoRound | null> {
  return prisma.bingoRound.findFirst({
    where: { roomId, status: { in: ACTIVE_ROUND_STATUSES } },
    orderBy: { roundNumber: 'desc' },
  });
}

/**
 * Creates the next round if the room has none live. Safe under concurrent
 * callers: a room-wide advisory lock plus the one-active-round partial index.
 */
export async function ensureRound(roomId: string): Promise<BingoRound> {
  const existing = await getActiveRound(roomId);
  if (existing) return existing;

  const room = await prisma.bingoRoom.findUnique({ where: { id: roomId } });
  if (!room) throw Errors.notFound('Room');
  if (room.status !== 'OPEN') {
    throw Errors.conflict('This room is not accepting players', 'ROOM_CLOSED');
  }

  try {
    return await withTxRetry(() =>
      runTransaction(async (tx) => {
        await advisoryXactLock(tx, `room:${roomId}`);
        const live = await tx.bingoRound.findFirst({
          where: { roomId, status: { in: ACTIVE_ROUND_STATUSES } },
          orderBy: { roundNumber: 'desc' },
        });
        if (live) return live;

        const last = await tx.bingoRound.findFirst({
          where: { roomId },
          orderBy: { roundNumber: 'desc' },
          select: { roundNumber: true },
        });
        const serverSeed = generateServerSeed();
        return tx.bingoRound.create({
          data: {
            roomId,
            roundNumber: (last?.roundNumber ?? 0) + 1,
            variant: room.variant,
            stakePerCard: room.stakePerCard,
            rakeBps: room.rakeBps,
            allowedPatterns: room.allowedPatterns,
            serverSeed,
            serverSeedHash: computeSeedHash(serverSeed),
            purchaseClosesAt: new Date(Date.now() + room.purchaseWindowSecs * 1_000),
          },
        });
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error, 'roomId')) {
      const live = await getActiveRound(roomId);
      if (live) return live;
    }
    throw error;
  }
}

export interface BuyCardsResult {
  round: BingoRound;
  cards: BingoCard[];
  replayed: boolean;
}

export async function buyCards(input: PurchaseInput): Promise<BuyCardsResult> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 4) {
    throw Errors.badRequest('Buy between 1 and 4 cards', 'INVALID_CARD_COUNT');
  }

  const room = await resolveRoom(input);
  if (room.status !== 'OPEN') {
    throw Errors.conflict('This room is not accepting players', 'ROOM_CLOSED');
  }

  const round = await ensureRound(room.id);
  const cardKeys = Array.from(
    { length: input.quantity },
    (_, index) => `${input.idempotencyKey}:${index}`,
  );

  const already = await prisma.bingoCard.findMany({ where: { idempotencyKey: { in: cardKeys } } });
  if (already.length > 0) {
    return { round: (await prisma.bingoRound.findUnique({ where: { id: round.id } }))!, cards: already, replayed: true };
  }

  const existingCount = await prisma.bingoCard.count({
    where: { roundId: round.id, userId: input.userId },
  });
  assertCardAllowance(existingCount, input.quantity, room.maxCardsPerPlayer);

  const gridSeeds = Array.from({ length: input.quantity }, () => generateCard(room.variant));
  const total = round.stakePerCard * BigInt(input.quantity);
  const clientSeed = input.clientSeed?.trim() ? input.clientSeed.trim().slice(0, 128) : null;

  try {
    const result = await withTxRetry(() =>
      runTransaction(async (tx) => {
        // Room lock orders concurrent purchases; the round lock orders them
        // against lockRound/cancelRound, which would otherwise read cardsSold
        // before an in-flight purchase commits and cancel a sold-out round.
        await advisoryXactLock(tx, `room:${room.id}`);
        await advisoryXactLock(tx, `round:${round.id}`);
        const fresh = await tx.bingoRound.findUnique({ where: { id: round.id } });
        if (!fresh) throw Errors.notFound('Round');
        if (fresh.status !== 'WAITING') {
          throw Errors.conflict('Card sales are closed for this round', 'ROUND_SALES_CLOSED');
        }
        if (fresh.purchaseClosesAt && fresh.purchaseClosesAt.getTime() <= Date.now()) {
          throw Errors.conflict('Card sales are closed for this round', 'ROUND_SALES_CLOSED');
        }

        const replay = await tx.bingoCard.findMany({
          where: { idempotencyKey: { in: cardKeys } },
        });
        if (replay.length > 0) {
          return { cards: replay, round: fresh, replayed: true };
        }

        const owned = await tx.bingoCard.count({
          where: { roundId: fresh.id, userId: input.userId },
        });
        assertCardAllowance(owned, input.quantity, room.maxCardsPerPlayer);

        const economics = computeEconomics(fresh.stakePerCard * BigInt(fresh.cardsSold + input.quantity), fresh.rakeBps);
        const updatedRound = await tx.bingoRound.update({
          where: { id: fresh.id },
          data: {
            cardsSold: { increment: input.quantity },
            grossPot: economics.grossPot,
            rakeAmount: economics.rakeAmount,
            prizePool: economics.prizePool,
            purchaseClosesAt:
              fresh.purchaseClosesAt ?? new Date(Date.now() + room.purchaseWindowSecs * 1_000),
            ...(owned === 0 ? { uniquePlayers: { increment: 1 } } : {}),
          },
        });

        const cardsData = gridSeeds.map((grid, index) => ({
          id: randomUUID(),
          roundId: fresh.id,
          userId: input.userId,
          cardIndex: owned + index,
          stake: fresh.stakePerCard,
          variant: fresh.variant,
          cells: grid as unknown as Prisma.InputJsonValue,
          autoDaub: room.autoDaubEnabled,
          clientSeed,
          idempotencyKey: cardKeys[index]!,
        }));
        await tx.bingoCard.createMany({ data: cardsData });

        await postLedger(tx, {
          idempotencyKey: `card-purchase:${fresh.id}:${input.userId}:${input.idempotencyKey}`,
          kind: 'CARD_PURCHASE',
          refType: 'BingoRound',
          refId: fresh.id,
          memo: `${input.quantity} card(s) in ${room.code} round ${fresh.roundNumber}`,
          instructions: [
            { ownerKind: 'USER', ownerId: input.userId, code: 'AVAILABLE', delta: -total },
            { ownerKind: 'USER', ownerId: input.userId, code: 'LOCKED', delta: total },
          ],
        });

        await tx.wallet.update({
          where: { userId: input.userId },
          data: { lifetimeWagered: { increment: total } },
        });

        const cards = await tx.bingoCard.findMany({
          where: { id: { in: cardsData.map((card) => card.id) } },
          orderBy: { cardIndex: 'asc' },
        });
        return { cards, round: updatedRound, replayed: false };
      }),
    );

    if (!result.replayed) {
      bingoEvents.publish({
        type: 'state',
        roomId: room.id,
        roundId: result.round.id,
        status: result.round.status,
      });
      void emitWallet(input.userId);
    }
    return result;
  } catch (error) {
    if (isUniqueViolation(error, 'idempotencyKey')) {
      const replay = await prisma.bingoCard.findMany({ where: { idempotencyKey: { in: cardKeys } } });
      if (replay.length > 0) {
        const current = await prisma.bingoRound.findUnique({ where: { id: round.id } });
        return { round: current!, cards: replay, replayed: true };
      }
    }
    if (isUniqueViolation(error, 'cardIndex')) {
      throw Errors.conflict('Card slots changed, retry the purchase', 'CARD_SLOTS_BUSY');
    }
    throw error;
  }
}

function assertCardAllowance(owned: number, requested: number, max: number): void {
  if (owned + requested > max) {
    throw Errors.conflict(
      `You can hold at most ${max} cards in this round`,
      'CARD_LIMIT_REACHED',
    );
  }
}

export type LockRoundOutcome =
  | { action: 'locked'; round: BingoRound }
  | { action: 'extended'; round: BingoRound }
  | { action: 'cancel'; round: BingoRound; reason: string }
  | { action: 'skipped'; round: BingoRound | null };

/**
 * Closes sales and commits the draw order. Under-filled rounds are extended so
 * early buyers keep their seats; after MAX_UNDERFILLED_WAIT_MS they are refunded.
 */
export async function lockRound(roundId: string): Promise<LockRoundOutcome> {
  const outcome = await withTxRetry(() =>
    runTransaction(async (tx) => {
      await advisoryXactLock(tx, `round:${roundId}`);
      const round = await tx.bingoRound.findUnique({
        where: { id: roundId },
        include: { room: true },
      });
      if (!round) throw Errors.notFound('Round');
      if (round.status !== 'WAITING') return { action: 'skipped' as const, round };

      if (round.cardsSold === 0) {
        const cancelled = await tx.bingoRound.update({
          where: { id: round.id },
          data: { status: 'CANCELLED', completedAt: new Date(), purchaseClosesAt: null },
        });
        return { action: 'cancel' as const, round: cancelled, reason: 'no_players' };
      }

      if (round.uniquePlayers < round.room.minPlayersToStart) {
        const waited = Date.now() - round.createdAt.getTime();
        if (waited >= MAX_UNDERFILLED_WAIT_MS) {
          return { action: 'cancel' as const, round, reason: 'underfilled' };
        }
        const extended = await tx.bingoRound.update({
          where: { id: round.id },
          data: {
            purchaseClosesAt: new Date(Date.now() + UNDERFILLED_EXTENSION_MS),
          },
        });
        return { action: 'extended' as const, round: extended };
      }

      const seedRows = await tx.bingoCard.findMany({
        where: { roundId: round.id, clientSeed: { not: null } },
        select: { userId: true, clientSeed: true },
        orderBy: { purchasedAt: 'asc' },
      });
      const perUser = new Map<string, string>();
      for (const row of seedRows) {
        if (row.clientSeed && !perUser.has(row.userId)) perUser.set(row.userId, row.clientSeed);
      }
      const seeds = [...perUser.values()];
      const clientSeed = aggregateClientSeed(seeds);
      const ballOrder = deriveBallOrder({
        serverSeed: round.serverSeed,
        clientSeed,
        nonce: round.nonce,
        ballMax: VARIANT_RULES[round.variant].ballMax,
      });

      const locked = await tx.bingoRound.update({
        where: { id: round.id },
        data: {
          status: 'LOCKED',
          startedAt: new Date(),
          clientSeed,
          clientSeedCount: seeds.length,
          ballOrder,
        },
      });
      return { action: 'locked' as const, round: locked };
    }),
  );

  if (outcome.round && (outcome.action === 'locked' || outcome.action === 'extended')) {
    bingoEvents.publish({
      type: 'state',
      roomId: outcome.round.roomId,
      roundId: outcome.round.id,
      status: outcome.round.status,
    });
  }
  if (outcome.action === 'cancel' && outcome.round) {
    await cancelRound(outcome.round.id, outcome.reason);
  }
  return outcome;
}

export interface DrawnBall {
  action: 'drawn';
  round: BingoRound;
  ball: number;
  index: number;
  winners: Array<{ cardId: string; userId: string; pattern: WinPatternName }>;
}

export type DrawOutcome =
  | DrawnBall
  | { action: 'exhausted'; round: BingoRound }
  | { action: 'skipped'; round: BingoRound };

/**
 * Draws the next ball from the committed order and, if that ball completes an
 * allowed pattern on any active card, pauses the draw and opens the claim window.
 */
export async function drawBall(roundId: string): Promise<DrawOutcome> {
  const outcome = await withTxRetry(() =>
    runTransaction(async (tx) => {
      await advisoryXactLock(tx, `round:${roundId}`);
      const round = await tx.bingoRound.findUnique({
        where: { id: roundId },
        include: { room: true },
      });
      if (!round) throw Errors.notFound('Round');
      if (round.status !== 'PLAYING' && round.status !== 'LOCKED') {
        return { action: 'skipped' as const, round };
      }

      const index = round.drawnBalls.length;
      if (index >= round.ballOrder.length) return { action: 'exhausted' as const, round };

      const ball = round.ballOrder[index]!;
      const now = new Date();
      const drawn = await tx.bingoRound.update({
        where: { id: round.id },
        data: {
          status: 'PLAYING',
          startedAt: round.startedAt ?? now,
          lastDrawAt: now,
          currentBall: ball,
          drawnBalls: { push: ball },
        },
      });

      const cards = await tx.bingoCard.findMany({
        where: { roundId, status: 'ACTIVE' },
      });
      const allowed = drawn.allowedPatterns as WinPatternName[];
      const winners = cards.flatMap((card) => {
        const patterns = completedPatterns(parseCardCells(card.cells), drawn.drawnBalls, allowed);
        return patterns.length > 0
          ? [{ cardId: card.id, userId: card.userId, pattern: patterns[0]! }]
          : [];
      });

      if (winners.length === 0) {
        return { action: 'drawn' as const, round: drawn, ball, index, winners };
      }

      const closeAt = new Date(now.getTime() + round.room.claimWindowSecs * 1_000);
      const claiming = await tx.bingoRound.update({
        where: { id: round.id },
        data: { status: 'CLAIM_VERIFICATION', claimsOpenAt: now, claimsCloseAt: closeAt },
      });

      if (round.room.autoDaubEnabled) {
        const existing = await tx.bingoClaim.findMany({
          where: { roundId, cardId: { in: winners.map((winner) => winner.cardId) } },
          select: { cardId: true },
        });
        const claimed = new Set(existing.map((claim) => claim.cardId));
        const autoClaims = winners.filter((winner) => !claimed.has(winner.cardId));
        if (autoClaims.length > 0) {
          await tx.bingoClaim.createMany({
            data: autoClaims.map((winner) => ({
              roundId,
              cardId: winner.cardId,
              userId: winner.userId,
              pattern: winner.pattern as WinPattern,
              status: 'VALID' as const,
              drawnSnapshot: claiming.drawnBalls,
              validatedAt: now,
              rejectionReason: 'SERVER_DETECTED',
            })),
          });
        }
      }

      return {
        action: 'drawn' as const,
        round: claiming,
        ball,
        index,
        winners,
      };
    }),
  );

  if (outcome.action === 'drawn') {
    bingoEvents.publish({
      type: 'ball',
      roomId: outcome.round.roomId,
      roundId: outcome.round.id,
      ball: outcome.ball,
      index: outcome.index,
      drawnCount: outcome.index + 1,
      status: outcome.round.status,
    });
    if (outcome.winners.length > 0) {
      bingoEvents.publish({
        type: 'claiming',
        roomId: outcome.round.roomId,
        roundId: outcome.round.id,
        claimsCloseAt: outcome.round.claimsCloseAt!,
        detectedWinners: outcome.winners.length,
      });
    }
  }
  return outcome;
}

export async function submitClaim(input: {
  userId: string;
  roundId: string;
  cardId: string;
  pattern: WinPattern;
}) {
  return withTxRetry(() =>
    runTransaction(async (tx) => {
      await advisoryXactLock(tx, `round:${input.roundId}`);
      const round = await tx.bingoRound.findUnique({ where: { id: input.roundId } });
      if (!round) throw Errors.notFound('Round');
      if (round.status !== 'CLAIM_VERIFICATION') {
        throw Errors.conflict('This round is not accepting claims', 'CLAIMS_CLOSED');
      }
      if (!round.claimsCloseAt || round.claimsCloseAt.getTime() <= Date.now()) {
        throw Errors.conflict('The claim window has closed', 'CLAIMS_CLOSED');
      }

      const card = await tx.bingoCard.findFirst({
        where: { id: input.cardId, roundId: round.id, userId: input.userId },
      });
      if (!card) throw Errors.notFound('Card');
      if (card.status !== 'ACTIVE') {
        throw Errors.conflict('This card has already been settled', 'CARD_SETTLED');
      }

      const existing = await tx.bingoClaim.findFirst({
        where: { cardId: card.id, status: { in: ['PENDING', 'VALID'] } },
        orderBy: { claimedAt: 'desc' },
      });
      if (existing) return { claim: existing, replayed: true };

      const verdict = validateClaim(
        parseCardCells(card.cells),
        round.drawnBalls,
        input.pattern as WinPatternName,
        round.allowedPatterns as WinPatternName[],
      );
      const claim = await tx.bingoClaim.create({
        data: {
          roundId: round.id,
          cardId: card.id,
          userId: input.userId,
          pattern: input.pattern,
          status: verdict.valid ? 'VALID' : 'INVALID',
          drawnSnapshot: round.drawnBalls,
          rejectionReason: verdict.reason ?? null,
          validatedAt: new Date(),
        },
      });
      return { claim, replayed: false };
    }),
  );
}

export interface SettlementSummary {
  roundId: string;
  status: RoundStatus;
  winnerCount: number;
  winners: Array<{ userId: string; cardId: string; pattern: WinPatternName; payout: bigint }>;
  rakeAmount: bigint;
  prizePool: bigint;
}

export type SettleOutcome =
  | { action: 'settled'; summary: SettlementSummary }
  | { action: 'cancelled'; roundId: string; reason: string }
  | { action: 'skipped'; roundId: string };

export async function settleRound(roundId: string): Promise<SettleOutcome> {
  const outcome = await withTxRetry(() =>
    runTransaction(async (tx) => {
      await advisoryXactLock(tx, `round:${roundId}`);
      const round = await tx.bingoRound.findUnique({
        where: { id: roundId },
        include: { cards: true, room: true },
      });
      if (!round) throw Errors.notFound('Round');
      if (round.status !== 'CLAIM_VERIFICATION') {
        return { action: 'skipped' as const, roundId };
      }
      if (!round.claimsCloseAt || round.claimsCloseAt.getTime() > Date.now()) {
        return { action: 'skipped' as const, roundId };
      }

      const activeCards = round.cards.filter((card) => card.status === 'ACTIVE');
      if (activeCards.length === 0) {
        await tx.bingoRound.update({
          where: { id: roundId },
          data: { status: 'CANCELLED', completedAt: new Date(), seedRevealedAt: new Date() },
        });
        return { action: 'cancelled' as const, roundId, reason: 'no_cards' };
      }

      const allowed = round.allowedPatterns as WinPatternName[];
      const winnersByCard = new Map<string, { card: BingoCard; pattern: WinPatternName }>();

      const validClaims = await tx.bingoClaim.findMany({
        where: { roundId, status: 'VALID' },
        orderBy: { claimedAt: 'asc' },
      });
      for (const claim of validClaims) {
        const card = activeCards.find((candidate) => candidate.id === claim.cardId);
        if (card && !winnersByCard.has(card.id)) {
          winnersByCard.set(card.id, { card, pattern: claim.pattern as WinPatternName });
        }
      }

      // Claims are optional UX: the server remains the source of truth.
      if (winnersByCard.size === 0) {
        for (const card of activeCards) {
          const patterns = completedPatterns(parseCardCells(card.cells), round.drawnBalls, allowed);
          if (patterns.length > 0) winnersByCard.set(card.id, { card, pattern: patterns[0]! });
        }
      }

      if (winnersByCard.size === 0) {
        return { action: 'skipped' as const, roundId };
      }

      const winners = [...winnersByCard.values()];
      const grossPot = activeCards.reduce((sum, card) => sum + card.stake, 0n);
      const economics = computeEconomics(grossPot, round.rakeBps);
      const payouts = splitPrize(economics.prizePool, winners.length);

      await postLedger(tx, {
        idempotencyKey: `round-payout:${roundId}`,
        kind: 'ROUND_PAYOUT',
        refType: 'BingoRound',
        refId: roundId,
        memo: `Payout for ${round.room.code} round ${round.roundNumber}`,
        instructions: [
          ...activeCards.map((card) => ({
            ownerKind: 'USER' as const,
            ownerId: card.userId,
            code: 'LOCKED' as const,
            delta: -card.stake,
          })),
          ...winners.map((winner, index) => ({
            ownerKind: 'USER' as const,
            ownerId: winner.card.userId,
            code: 'AVAILABLE' as const,
            delta: payouts[index]!,
          })),
          {
            ownerKind: 'PLATFORM' as const,
            ownerId: 'platform',
            code: 'RAKE' as const,
            delta: economics.rakeAmount,
          },
        ],
      });

      const winningPattern =
        [...winners]
          .map((winner) => winner.pattern)
          .sort(
            (a, b) => PATTERN_PRIORITY.indexOf(a) - PATTERN_PRIORITY.indexOf(b),
          )[0] ?? null;

      await tx.roundWinner.createMany({
        data: winners.map((winner, index) => ({
          roundId,
          cardId: winner.card.id,
          userId: winner.card.userId,
          pattern: winner.pattern as WinPattern,
          payout: payouts[index]!,
          isSplitPot: winners.length > 1,
        })),
      });

      for (const [index, winner] of winners.entries()) {
        const card = winner.card;
        await tx.bingoCard.update({
          where: { id: card.id },
          data: {
            status: 'WON',
            wonPattern: winner.pattern as WinPattern,
            markedNumbers: cardNumbers(parseCardCells(card.cells)).filter((number) =>
              round.drawnBalls.includes(number),
            ),
          },
        });
        const payout = payouts[index]!;
        await tx.wallet.update({
          where: { userId: card.userId },
          data: { lifetimeWon: { increment: payout } },
        });
      }

      const winnerIds = new Set(winners.map((winner) => winner.card.id));
      const losers = activeCards.filter((card) => !winnerIds.has(card.id));
      if (losers.length > 0) {
        await tx.bingoCard.updateMany({
          where: { id: { in: losers.map((card) => card.id) } },
          data: { status: 'LOST' },
        });
      }

      const completed = await tx.bingoRound.update({
        where: { id: roundId },
        data: {
          status: 'COMPLETED',
          winningPattern,
          grossPot: economics.grossPot,
          rakeAmount: economics.rakeAmount,
          prizePool: economics.prizePool,
          completedAt: new Date(),
          seedRevealedAt: new Date(),
        },
      });

      const winnerIdsByUser = new Map<string, bigint>();
      winners.forEach((winner, index) => {
        winnerIdsByUser.set(
          winner.card.userId,
          (winnerIdsByUser.get(winner.card.userId) ?? 0n) + payouts[index]!,
        );
      });
      const participantIds = new Set(activeCards.map((card) => card.userId));
      await tx.notification.createMany({
        data: [...participantIds].map((userId) => {
          const payout = winnerIdsByUser.get(userId);
          return {
            userId,
            type: NotificationType.ROUND_RESULT,
            title: payout ? 'Bingo! You won' : 'Round finished',
            body: payout
              ? `You won ${payout} credits in ${round.room.name}.`
              : `Round ${round.roundNumber} in ${round.room.name} has finished.`,
            data: {
              roundId,
              roomId: round.roomId,
              payout: payout?.toString() ?? '0',
            },
          };
        }),
      });

      return {
        action: 'settled' as const,
        summary: {
          roundId,
          status: completed.status,
          winnerCount: winners.length,
          winners: winners.map((winner, index) => ({
            userId: winner.card.userId,
            cardId: winner.card.id,
            pattern: winner.pattern,
            payout: payouts[index]!,
          })),
          rakeAmount: economics.rakeAmount,
          prizePool: economics.prizePool,
        },
      };
    }),
  );

  if (outcome.action === 'settled') {
    const { summary } = outcome;
    const finished = await prisma.bingoRound.findUnique({
      where: { id: roundId },
      select: { roomId: true, serverSeed: true },
    });
    bingoEvents.publish({
      type: 'settled',
      roomId: finished!.roomId,
      roundId,
      winners: summary.winners.map((winner) => ({
        userId: winner.userId,
        cardId: winner.cardId,
        pattern: winner.pattern,
        payout: winner.payout.toString(),
      })),
      rake: summary.rakeAmount.toString(),
      prizePool: summary.prizePool.toString(),
      serverSeed: finished!.serverSeed,
    });
    for (const userId of new Set(summary.winners.map((winner) => winner.userId))) {
      void emitWallet(userId);
    }
  }
  if (outcome.action === 'cancelled') {
    await emitCancelled(roundId, outcome.reason);
  }
  return outcome;
}

export async function cancelRound(roundId: string, reason: string): Promise<void> {
  const outcome = await withTxRetry(() =>
    runTransaction(async (tx) => {
      await advisoryXactLock(tx, `round:${roundId}`);
      const round = await tx.bingoRound.findUnique({
        where: { id: roundId },
        include: { cards: true },
      });
      if (!round) throw Errors.notFound('Round');
      if (round.status === 'COMPLETED' || round.status === 'CANCELLED') {
        return { refunded: false, roomId: round.roomId };
      }

      const cards = round.cards.filter((card) => card.status === 'ACTIVE');
      if (cards.length > 0) {
        await postLedger(tx, {
          idempotencyKey: `round-refund:${roundId}`,
          kind: 'ROUND_REFUND',
          refType: 'BingoRound',
          refId: roundId,
          memo: `Round cancelled (${reason})`,
          instructions: cards.flatMap((card) => [
            { ownerKind: 'USER' as const, ownerId: card.userId, code: 'LOCKED' as const, delta: -card.stake },
            { ownerKind: 'USER' as const, ownerId: card.userId, code: 'AVAILABLE' as const, delta: card.stake },
          ]),
        });
        await tx.bingoCard.updateMany({
          where: { id: { in: cards.map((card) => card.id) } },
          data: { status: 'REFUNDED' },
        });
        await tx.notification.createMany({
          data: [...new Set(cards.map((card) => card.userId))].map((userId) => ({
            userId,
            type: NotificationType.ROUND_RESULT,
            title: 'Round cancelled',
            body: 'Your stake was returned to your balance.',
            data: { roundId, reason },
          })),
        });
      }

      await tx.bingoRound.update({
        where: { id: roundId },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
          seedRevealedAt: new Date(),
          purchaseClosesAt: null,
        },
      });
      return { refunded: cards.length > 0, roomId: round.roomId, userIds: [...new Set(cards.map((card) => card.userId))] };
    }),
  );

  await emitCancelled(roundId, reason);
  if ('userIds' in outcome && outcome.userIds) {
    for (const userId of outcome.userIds) void emitWallet(userId);
  }
}

async function emitCancelled(roundId: string, reason: string): Promise<void> {
  const round = await prisma.bingoRound.findUnique({
    where: { id: roundId },
    select: { roomId: true },
  });
  if (!round) return;
  bingoEvents.publish({ type: 'cancelled', roomId: round.roomId, roundId, reason });
}

async function emitWallet(userId: string): Promise<void> {
  try {
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return;
    bingoEvents.publish({
      type: 'wallet',
      userId,
      wallet: {
        available: wallet.available.toString(),
        escrow: wallet.escrow.toString(),
        locked: wallet.locked.toString(),
      },
    });
  } catch {
    // Wallet broadcasts are advisory; a missed update is repaired on next fetch.
  }
}

// ─────────────────────────────── reads ───────────────────────────────

export async function listRooms() {
  const rooms = await prisma.bingoRoom.findMany({
    where: { status: { not: 'CLOSED' } },
    orderBy: [{ variant: 'asc' }, { stakePerCard: 'asc' }],
  });
  const active = await prisma.bingoRound.findMany({
    where: { status: { in: ACTIVE_ROUND_STATUSES }, roomId: { in: rooms.map((room) => room.id) } },
    select: {
      id: true,
      roomId: true,
      roundNumber: true,
      status: true,
      cardsSold: true,
      uniquePlayers: true,
      prizePool: true,
      currentBall: true,
      purchaseClosesAt: true,
    },
  });
  const byRoom = new Map(active.map((round) => [round.roomId, round]));
  return rooms.map((room) => ({ room, round: byRoom.get(room.id) ?? null }));
}

export async function getRoomByCode(code: string) {
  const room = await prisma.bingoRoom.findUnique({ where: { code } });
  if (!room) throw Errors.notFound('Room');
  const round = await getActiveRound(room.id);
  return { room, round };
}

export async function getRoundForViewer(roundId: string, viewerId?: string) {
  const round = await prisma.bingoRound.findUnique({
    where: { id: roundId },
    include: { room: true },
  });
  if (!round) throw Errors.notFound('Round');
  const claimCount = await prisma.bingoClaim.count({ where: { roundId } });
  const cards = viewerId
    ? await prisma.bingoCard.findMany({
        where: { roundId, userId: viewerId },
        orderBy: { cardIndex: 'asc' },
      })
    : [];
  return { round, room: round.room, cards, claimCount };
}

export async function listMyCards(roundId: string, userId: string) {
  return prisma.bingoCard.findMany({
    where: { roundId, userId },
    orderBy: { cardIndex: 'asc' },
  });
}

export async function roomHistory(roomId: string, limit = 20) {
  return prisma.bingoRound.findMany({
    where: { roomId, status: { in: ['COMPLETED', 'CANCELLED'] } },
    orderBy: { roundNumber: 'desc' },
    take: limit,
  });
}

export async function verifyRound(roundId: string) {
  const round = await prisma.bingoRound.findUnique({
    where: { id: roundId },
    include: { cards: { select: { userId: true, clientSeed: true, purchasedAt: true } } },
  });
  if (!round) throw Errors.notFound('Round');
  if (round.status !== 'COMPLETED' && round.status !== 'CANCELLED') {
    throw Errors.conflict('Seeds are revealed once the round is finished', 'ROUND_NOT_SETTLED');
  }
  const recomputed = deriveBallOrder({
    serverSeed: round.serverSeed,
    clientSeed: round.clientSeed,
    nonce: round.nonce,
    ballMax: VARIANT_RULES[round.variant].ballMax,
  });
  const committed = round.ballOrder.length > 0;
  const matches =
    !committed || recomputed.every((ball, index) => ball === round.ballOrder[index]);
  return {
    roundId: round.id,
    variant: round.variant,
    rngVersion: round.rngVersion,
    serverSeed: round.serverSeed,
    serverSeedHash: round.serverSeedHash,
    seedHashMatches: computeSeedHash(round.serverSeed) === round.serverSeedHash,
    clientSeed: round.clientSeed,
    clientSeedCount: round.clientSeedCount,
    clientSeeds: round.cards
      .filter((card) => card.clientSeed)
      .sort((a, b) => a.purchasedAt.getTime() - b.purchasedAt.getTime())
      .map((card) => ({ userId: card.userId, clientSeed: card.clientSeed })),
    nonce: round.nonce,
    ballOrder: round.ballOrder,
    recomputedBallOrder: recomputed,
    committed,
    matches,
    drawnBalls: round.drawnBalls,
    alreadyDrawnMatch:
      !committed || round.drawnBalls.every((ball, index) => ball === recomputed[index]),
    status: round.status,
  };
}

