import { randomUUID } from 'node:crypto';
import { payoutFor } from '../domain/money';
import type { BetRecord, RoundRecord, SessionRecord } from '../domain/types';
import type { EngineLimits, RoundBetManager } from './roundEngine';
import type { Store } from './store';
import { WalletError, type MovementReply, type WalletClient } from './wallet';

export interface BetManagerDeps {
  store: Store;
  wallet: WalletClient;
  limits: EngineLimits;
  /** Timestamp source for persisted rows. Defaults to the real clock. */
  now?: () => Date;
  /** Transaction id source. Defaults to `randomUUID`. */
  newId?: () => string;
}

type Panel = 0 | 1;

/**
 * Bet state machine.
 *
 * Persistence-first like the engine: the bet row exists (PLACING) before the
 * wallet is asked to charge, and every terminal state is committed before the
 * outbox row that reconciles it. Money is bigint minor units throughout; only
 * `payoutFor` turns a multiplier into an amount, and it never uses floats.
 */
export class BetManager implements RoundBetManager {
  private readonly store: Store;
  private readonly wallet: WalletClient;
  private readonly limits: EngineLimits;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: BetManagerDeps) {
    this.store = deps.store;
    this.wallet = deps.wallet;
    this.limits = deps.limits;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  async place(input: {
    round: RoundRecord;
    session: SessionRecord;
    panel: Panel;
    stake: bigint;
    autoCashout: number | null;
  }): Promise<BetRecord> {
    const { round, session, panel, stake, autoCashout } = input;
    // The engine can still hand us a round during the CRASHED cooldown, so the
    // phase gate is authoritative here, not the caller.
    if (round.status !== 'BETTING') throw new Error('Betting is closed');
    if (stake < this.limits.minStake || stake > this.limits.maxStake) {
      throw new Error('Stake outside limits');
    }
    if (autoCashout !== null && autoCashout < 1) throw new Error('Invalid auto cashout');

    const existing = await this.store.getBet(round.id, session.token, panel);
    if (existing) return existing; // idempotent frame replay
    if ((await this.store.listBetsForRound(round.id)).length >= this.limits.maxBetsPerRound) {
      throw new Error('Round bet limit reached');
    }

    const bet = await this.store.insertBet({
      roundId: round.id,
      operatorCode: session.operatorCode,
      sessionToken: session.token,
      panel,
      stake,
      autoCashout,
      status: 'PLACING',
      cashoutMultiplier: null,
      payout: null,
      betTxnId: this.newId(),
      winTxnId: null,
    });

    let reply: MovementReply;
    try {
      reply = await this.wallet.bet({
        sessionToken: session.token,
        txnId: bet.betTxnId,
        amount: stake,
        roundId: String(round.id),
      });
    } catch (error) {
      // Only a 4xx is a definitive rejection. A timeout (status null), a
      // malformed 2xx or an unparseable 5xx may mean the charge landed, so the
      // bet stays UNRESOLVED for recovery to replay or roll back.
      await this.store.updateBet(bet.id, { status: this.failureStatus(error) });
      throw error;
    }

    await this.store.updateBet(bet.id, { status: 'ACTIVE' });
    if (reply.balance !== null) await this.store.setSessionBalance(session.token, reply.balance);
    return { ...bet, status: 'ACTIVE' };
  }

  async cancel(input: { round: RoundRecord; session: SessionRecord; panel: Panel }): Promise<void> {
    const { round, session, panel } = input;
    if (round.status !== 'BETTING') throw new Error('Betting is closed');
    const bet = await this.store.getBet(round.id, session.token, panel);
    if (bet === null || bet.status !== 'ACTIVE') throw new Error('No active bet for this round');

    await this.store.updateBet(bet.id, { status: 'CANCELLED', settledAt: this.now() });
    // Roll back the exact charge: the placement's own txn id and stake.
    await this.store.enqueueOutbox({
      operatorCode: session.operatorCode,
      type: 'ROLLBACK',
      txnId: bet.betTxnId,
      sessionToken: session.token,
      amount: bet.stake,
    });
  }

  async cashout(input: {
    round: RoundRecord;
    session: SessionRecord;
    panel: Panel;
    multiplier: number;
  }): Promise<void> {
    const { round, session, panel, multiplier } = input;
    if (round.status !== 'FLYING') throw new Error('Round is not flying');
    const bet = await this.store.getBet(round.id, session.token, panel);
    if (bet === null || bet.status !== 'ACTIVE') throw new Error('No active bet for this round');
    await this.settleWin(bet, multiplier, session);
  }

  /**
   * Sweeps the round's ACTIVE bets that opted into an auto cashout and settles
   * every one whose target has been reached below the crash point. Runs on each
   * FLYING tick, crash tick included, so the sweep must be idempotent: only an
   * ACTIVE bet is ever settled, so a second pass pays nothing.
   */
  async processAutoCashouts(input: {
    round: RoundRecord;
    multiplier: number;
    elapsedMs: number;
  }): Promise<void> {
    const { round, multiplier } = input;
    if (round.status !== 'FLYING') throw new Error('Round is not flying');
    const crashPoint = round.crashPoint;
    // Without a committed crash point there is nothing safe to compare against.
    if (crashPoint === null) return;
    // At or above the crash point the round is over: an auto cashout may no
    // longer fire, even if its target was crossed earlier.
    if (multiplier >= crashPoint) return;

    const bets = await this.store.listBetsForRound(round.id);
    for (const listed of bets) {
      if (listed.status !== 'ACTIVE') continue;
      const target = listed.autoCashout;
      if (target === null || target > multiplier || target >= crashPoint) continue;

      const session = await this.store.getSession(listed.sessionToken);
      if (session === null) {
        // Never guess limits: an unknown session is left for boot recovery.
        console.error('auto cashout skipped: session not found', listed.id);
        continue;
      }
      // Re-read so a manual cashout that landed while we awaited cannot pay twice.
      const bet = await this.store.getBet(round.id, listed.sessionToken, listed.panel);
      if (bet === null || bet.status !== 'ACTIVE') continue;

      await this.settleWin(bet, target, session);
    }
  }

  async settleRound(input: { round: RoundRecord; maxWin: bigint }): Promise<void> {
    const { round } = input;
    const settledAt = this.now();
    const bets = await this.store.listBetsForRound(round.id);
    for (const bet of bets) {
      // PLACING and UNRESOLVED belong to boot recovery, CASHED/CANCELLED are
      // already terminal: only a leftover ACTIVE bet lost the round.
      if (bet.status !== 'ACTIVE') continue;
      await this.store.updateBet(bet.id, { status: 'LOST', settledAt });
    }
  }

  private async settleWin(bet: BetRecord, multiplier: number, session: SessionRecord): Promise<void> {
    const payout = payoutFor(bet.stake, multiplier, session.maxWin);
    const winTxnId = this.newId();
    await this.store.updateBet(bet.id, {
      status: 'CASHED',
      cashoutMultiplier: multiplier,
      payout,
      winTxnId,
      settledAt: this.now(),
    });
    await this.store.enqueueOutbox({
      operatorCode: session.operatorCode,
      type: 'WIN',
      txnId: winTxnId,
      sessionToken: session.token,
      amount: payout,
    });
  }

  private failureStatus(error: unknown): 'REJECTED' | 'UNRESOLVED' {
    if (error instanceof WalletError && error.status !== null && error.status >= 400 && error.status < 500) {
      return 'REJECTED';
    }
    return 'UNRESOLVED';
  }
}
