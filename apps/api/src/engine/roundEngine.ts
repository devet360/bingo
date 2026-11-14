import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { AppError } from '../lib/errors';
import {
  cancelRound,
  drawBall,
  ensureRound,
  lockRound,
  settleRound,
} from '../services/bingo';

type RoundWithRoom = Prisma.BingoRoundGetPayload<{ include: { room: true } }>;

const ACTIVE_STATUSES = ['WAITING', 'LOCKED', 'PLAYING', 'CLAIM_VERIFICATION'] as const;
const MIN_DELAY_MS = 20;
const MAX_DELAY_MS = 5_000;
const DISCOVERY_INTERVAL_MS = 30_000;

function clampDelay(ms: number): number {
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(ms)));
}

/**
 * One timer per open room. Every transition is also guarded in the database
 * (advisory lock + status predicate), so a second instance cannot double-draw;
 * this loop only decides *when* to attempt the transition.
 */
export class RoundEngine {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly busy = new Set<string>();
  private discovery: NodeJS.Timeout | null = null;
  private stopped = true;

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.discover();
    this.discovery = setInterval(() => void this.discover(), DISCOVERY_INTERVAL_MS);
    this.discovery.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.discovery) clearInterval(this.discovery);
    this.discovery = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Called on boot and every 30s so rooms created after start are picked up. */
  async discover(): Promise<void> {
    try {
      const rooms = await prisma.bingoRoom.findMany({
        where: { status: 'OPEN' },
        select: { id: true },
      });
      for (const room of rooms) this.track(room.id);
    } catch (error) {
      logger.warn({ err: error }, 'bingo engine discovery failed; retrying');
    }
  }

  private track(roomId: string): void {
    if (this.stopped || this.timers.has(roomId)) return;
    this.schedule(roomId, 0);
  }

  private schedule(roomId: string, delayMs: number): void {
    if (this.stopped) return;
    const current = this.timers.get(roomId);
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      this.timers.delete(roomId);
      void this.tick(roomId);
    }, clampDelay(delayMs));
    timer.unref();
    this.timers.set(roomId, timer);
  }

  private async tick(roomId: string): Promise<void> {
    if (this.stopped || this.busy.has(roomId)) return;
    this.busy.add(roomId);
    let delay = 1_000;
    let untrack = false;
    try {
      const round = await prisma.bingoRound.findFirst({
        where: { roomId, status: { in: [...ACTIVE_STATUSES] } },
        include: { room: true },
        orderBy: { roundNumber: 'desc' },
      });
      if (round) {
        delay = await this.advance(round);
      } else {
        await ensureRound(roomId);
        delay = 250;
      }
    } catch (error) {
      if (error instanceof AppError && (error.code === 'ROOM_CLOSED' || error.code === 'NOT_FOUND')) {
        untrack = true;
      } else {
        logger.error({ err: error, roomId }, 'bingo engine tick failed');
      }
    } finally {
      this.busy.delete(roomId);
      if (!untrack) this.schedule(roomId, delay);
      else this.timers.delete(roomId);
    }
  }

  private async advance(round: RoundWithRoom): Promise<number> {
    const now = Date.now();
    switch (round.status) {
      case 'WAITING': {
        const deadline =
          (round.purchaseClosesAt?.getTime() ??
            round.createdAt.getTime() + round.room.purchaseWindowSecs * 1_000);
        if (now < deadline) return deadline - now;

        const outcome = await lockRound(round.id);
        if (outcome.action === 'extended' && outcome.round.purchaseClosesAt) {
          return outcome.round.purchaseClosesAt.getTime() - Date.now();
        }
        // Idle rooms cycle rounds lazily instead of churning a row every window.
        return outcome.action === 'cancel' ? 2_000 : 50;
      }

      case 'LOCKED': {
        const deadline = (round.startedAt?.getTime() ?? now) + round.room.lockWindowSecs * 1_000;
        if (now < deadline) return deadline - now;
        await drawBall(round.id);
        return 20;
      }

      case 'PLAYING': {
        const deadline = (round.lastDrawAt?.getTime() ?? now) + round.room.drawIntervalMs;
        if (now < deadline) return deadline - now;
        const outcome = await drawBall(round.id);
        if (outcome.action === 'exhausted') {
          await cancelRound(round.id, 'ball_pool_exhausted');
          return 200;
        }
        if (outcome.action === 'skipped') return 100;
        return round.room.drawIntervalMs;
      }

      case 'CLAIM_VERIFICATION': {
        const deadline = round.claimsCloseAt?.getTime() ?? now;
        if (now < deadline) return deadline - now;
        const outcome = await settleRound(round.id);
        if (outcome.action === 'skipped') {
          // Claim window elapsed but nothing was payable: refund rather than strand stakes.
          await cancelRound(round.id, 'no_valid_winner');
          return 200;
        }
        return 250;
      }

      default:
        return 1_000;
    }
  }
}

export const roundEngine = new RoundEngine();
