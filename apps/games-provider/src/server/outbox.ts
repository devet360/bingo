import type { OutboxRecord } from '../domain/types';
import type { Store } from './store';
import { WalletError, type MovementReply, type WalletClient } from './wallet';

export interface OutboxWorkerDeps {
  store: Store;
  wallet: WalletClient;
}

export interface DrainSummary {
  sent: number;
  retried: number;
  capped: number;
  dead: number;
}

/** Rows claimed per tick. One drain is a small batch, not a table sweep. */
const CLAIM_LIMIT = 20;
/** Retry ceiling: the backoff doubles from 1s and never exceeds 60s. */
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_CAP_EXPONENT = 6;
/**
 * A live but unusable session gets exactly one replay before the row is
 * abandoned. `attempts` counts retry rounds and only `rescheduleOutbox`
 * increments it, so `attempts === 1` at claim time means this is the retry.
 */
const SESSION_RETRY_LIMIT = 1;

/**
 * Durable delivery of win/rollback movements.
 *
 * The outbox row was committed with the bet, so this worker only classifies
 * bingo's answer: a 2xx is `SENT`, a cap breach is `CAP_REJECTED`, a dead
 * session or a rolled-back debit gets one replay before `DEAD`, and everything
 * indeterminate (timeout, 5xx, malformed 2xx, unknown 4xx) stays `PENDING` with
 * exponential backoff. Rows are drained sequentially so the wallet call order
 * bingo sees is deterministic.
 *
 * `attempts` is read from the claimed snapshot; only `rescheduleOutbox`
 * increments it, so the backoff schedule is 1s, 2s, 4s ... 60s.
 */
export class OutboxWorker {
  private readonly store: Store;
  private readonly wallet: WalletClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: OutboxWorkerDeps) {
    this.store = deps.store;
    this.wallet = deps.wallet;
  }

  async drainOnce(now: Date): Promise<DrainSummary> {
    const summary: DrainSummary = { sent: 0, retried: 0, capped: 0, dead: 0 };
    const due = await this.store.claimDueOutbox(now, CLAIM_LIMIT);
    for (const row of due) {
      await this.deliver(row, now, summary);
    }
    return summary;
  }

  /**
   * Drains on a fixed interval. A tick that fires while the previous drain is
   * still in flight is skipped rather than queued, so a slow wallet cannot
   * build up overlapping drains.
   */
  start(intervalMs: number): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  /** Clears the timer. Safe to call twice, or without a prior `start`. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.drainOnce(new Date());
    } catch (error) {
      // A drain failure must never surface as an unhandled rejection; the rows
      // are still PENDING and the next tick retries them.
      console.error('outbox drain failed', error);
    } finally {
      this.running = false;
    }
  }

  private async deliver(row: OutboxRecord, now: Date, summary: DrainSummary): Promise<void> {
    const input = {
      sessionToken: row.sessionToken,
      txnId: row.txnId,
      amount: row.amount,
      roundId: '',
    };

    let reply: MovementReply;
    try {
      reply = row.type === 'WIN' ? await this.wallet.win(input) : await this.wallet.rollback(input);
    } catch (error) {
      await this.classifyFailure(row, now, summary, error);
      return;
    }

    // A resolved reply is not automatically a delivery: bingo answers 2xx with
    // `accepted:false` when it declined the movement (e.g. a currency mismatch
    // caught after parsing). Only an accepted or replayed movement is SENT.
    if (!reply.accepted && !reply.replayed) {
      await this.retry(row, now, summary, 'NOT_ACCEPTED');
      return;
    }

    if (reply.balance !== null) await this.store.setSessionBalance(row.sessionToken, reply.balance);
    await this.store.markOutbox(row.id, 'SENT');
    summary.sent += 1;
  }

  private async classifyFailure(
    row: OutboxRecord,
    now: Date,
    summary: DrainSummary,
    error: unknown,
  ): Promise<void> {
    const walletError = error instanceof WalletError ? error : null;
    const code = walletError === null ? 'UNKNOWN' : walletError.code;
    const status = walletError?.status ?? null;
    const isClientError = status !== null && status >= 400 && status < 500;

    // Locally clamped payouts should make this unreachable; when it does happen
    // there is no point replaying a deterministic refusal.
    if (code === 'WIN_LIMIT_EXCEEDED') {
      await this.store.markOutbox(row.id, 'CAP_REJECTED', code);
      summary.capped += 1;
      return;
    }

    // A closed session or a rolled-back debit may be transient on bingo's side
    // (a rollback racing the win), so it gets exactly one replay. A DEAD row is
    // the audit trail when it still fails.
    if (isClientError && (code === 'SESSION_CLOSED' || code === 'TRANSACTION_ROLLED_BACK')) {
      await this.settleOrRetry(row, now, summary, code);
      return;
    }

    // 404 on a rollback means the original transaction never applied: there is
    // nothing to refund, and after one replay the row is audited as DEAD.
    if (row.type === 'ROLLBACK' && status === 404 && code === 'NOT_FOUND') {
      await this.settleOrRetry(row, now, summary, code);
      return;
    }

    await this.retry(row, now, summary, code);
  }

  /** One replay, then DEAD: `attempts` was incremented by the previous retry. */
  private async settleOrRetry(
    row: OutboxRecord,
    now: Date,
    summary: DrainSummary,
    code: string,
  ): Promise<void> {
    if (row.attempts < SESSION_RETRY_LIMIT) {
      await this.retry(row, now, summary, code);
      return;
    }
    await this.store.markOutbox(row.id, 'DEAD', code);
    summary.dead += 1;
  }

  private async retry(row: OutboxRecord, now: Date, summary: DrainSummary, code: string): Promise<void> {
    const delayMs = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(row.attempts, BACKOFF_CAP_EXPONENT));
    await this.store.rescheduleOutbox(row.id, new Date(now.getTime() + delayMs), code);
    summary.retried += 1;
  }
}
