import type { BetRecord } from '../domain/types';
import type { Store } from './store';
import { WalletError, type WalletClient } from './wallet';

export interface RecoveryDeps {
  store: Store;
  wallet: WalletClient;
  /** Timestamp source for repaired rows. Defaults to the real clock. */
  now?: () => Date;
}

export interface RecoverySummary {
  abandonedRoundId: number | null;
  refundedBets: number;
  resolvedIndeterminate: number;
  repairedSettlements: number;
}

/**
 * Boot-time recovery pass, run before the engine's first round.
 *
 * It repairs the three windows persistence-first betting can leave behind:
 * a round interrupted mid-flight (abandoned, its ACTIVE bets refunded), bets
 * whose wallet charge is still ambiguous (replayed with their original txn id),
 * and terminal bets whose outbox reconciliation row was never written.
 *
 * Refunds use only the bet row, never a session lookup: an expired or missing
 * session must not be able to block boot.
 */
export async function runRecovery(deps: RecoveryDeps): Promise<RecoverySummary> {
  const now = deps.now ?? (() => new Date());
  const { store, wallet } = deps;
  const summary: RecoverySummary = {
    abandonedRoundId: null, refundedBets: 0, resolvedIndeterminate: 0, repairedSettlements: 0,
  };

  // Snapshot the orphaned settlements before any repair: a bet this pass
  // cancels without a rollback (the wallet reports it already rolled back) is
  // not an orphan and must not be refunded a second time.
  const orphanedSettlements = await store.listSettledBetsMissingOutbox();

  const unfinished = await store.lastUnfinishedRound();
  if (unfinished !== null) {
    await store.finishRound(unfinished.id, { status: 'ABANDONED', at: now() });
    summary.abandonedRoundId = unfinished.id;
    for (const bet of await store.listBetsForRound(unfinished.id)) {
      if (bet.status !== 'ACTIVE') continue;
      await refundBet(store, bet, now);
      summary.refundedBets += 1;
    }
  }

  // ACTIVE bets belonged to the abandoned round above; only the ambiguous rows
  // are replayed, and each replay is scoped to its own bet row.
  for (const bet of await store.listUnsettledBets()) {
    if (bet.status !== 'UNRESOLVED' && bet.status !== 'PLACING') continue;
    if (await resolveIndeterminate(store, wallet, bet, now)) summary.resolvedIndeterminate += 1;
  }

  for (const bet of orphanedSettlements) {
    if (bet.status === 'CASHED') {
      if (bet.winTxnId === null || bet.payout === null) {
        console.error('recovery: cashed bet without win txn', bet.id);
        continue;
      }
      await store.enqueueOutbox({
        operatorCode: bet.operatorCode, type: 'WIN', txnId: bet.winTxnId,
        sessionToken: bet.sessionToken, amount: bet.payout,
      });
    } else {
      await store.enqueueOutbox({
        operatorCode: bet.operatorCode, type: 'ROLLBACK', txnId: bet.betTxnId,
        sessionToken: bet.sessionToken, amount: bet.stake,
      });
    }
    summary.repairedSettlements += 1;
  }

  return summary;
}

async function refundBet(store: Store, bet: BetRecord, now: () => Date): Promise<void> {
  await store.updateBet(bet.id, { status: 'CANCELLED', settledAt: now() });
  await store.enqueueOutbox({
    operatorCode: bet.operatorCode, type: 'ROLLBACK', txnId: bet.betTxnId,
    sessionToken: bet.sessionToken, amount: bet.stake,
  });
}

async function resolveIndeterminate(store: Store, wallet: WalletClient, bet: BetRecord, now: () => Date): Promise<boolean> {
  try {
    const reply = await wallet.bet({
      sessionToken: bet.sessionToken, txnId: bet.betTxnId,
      amount: bet.stake, roundId: String(bet.roundId),
    });
    // A 2xx that accepts nothing is still ambiguous: leave it for the next boot.
    if (!reply.accepted && !reply.replayed) return false;
    await refundBet(store, bet, now);
    return true;
  } catch (error) {
    if (error instanceof WalletError) {
      if (error.code === 'TRANSACTION_ROLLED_BACK') {
        // The charge landed and was refunded before the restart: no second rollback.
        await store.updateBet(bet.id, { status: 'CANCELLED', settledAt: now() });
        return true;
      }
      if (error.status !== null && error.status >= 400 && error.status < 500) {
        await store.updateBet(bet.id, { status: 'REJECTED', settledAt: now() });
        return true;
      }
    }
    // Transport failures and 5xx leave the row UNRESOLVED; the next boot retries.
    return false;
  }
}
