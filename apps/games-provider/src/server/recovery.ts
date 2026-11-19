import type { BetRecord } from '../domain/types';
import { OperatorError, type OperatorWallets } from './operatorRegistry';
import type { Store } from './store';
import { WalletError, type WalletClient } from './wallet';

export interface RecoveryDeps {
  store: Store;
  /** Each bet's replay goes to the wallet of the operator that owns it. */
  wallets: OperatorWallets;
  /** Timestamp source for repaired rows. Defaults to the real clock. */
  now?: () => Date;
}

export interface RecoverySummary {
  abandonedRoundIds: number[];
  refundedBets: number;
  lostBets: number;
  resolvedIndeterminate: number;
  repairedSettlements: number;
}

/**
 * Boot-time recovery pass, run before the engine's first round.
 *
 * It repairs the three windows persistence-first betting can leave behind:
 * rounds interrupted mid-flight (abandoned, their ACTIVE bets refunded), bets
 * whose wallet charge is still ambiguous (replayed with their original txn id),
 * and terminal bets whose outbox reconciliation row was never written.
 *
 * Refunds use only the bet row, never a session lookup: an expired or missing
 * session must not be able to block boot.
 */
export async function runRecovery(deps: RecoveryDeps): Promise<RecoverySummary> {
  const now = deps.now ?? (() => new Date());
  const { store, wallets } = deps;
  const summary: RecoverySummary = {
    abandonedRoundIds: [], refundedBets: 0, lostBets: 0, resolvedIndeterminate: 0, repairedSettlements: 0,
  };

  // Snapshot the orphaned settlements before any repair: a bet this pass
  // cancels without a rollback (the wallet reports it already rolled back) is
  // not an orphan and must not be refunded a second time.
  const orphanedSettlements = await store.listSettledBetsMissingOutbox();

  // Abandon every unfinished round (normally at most one; the loop heals a
  // previous pass that died before it recorded the abandonment).
  for (let round = await store.lastUnfinishedRound(); round !== null; round = await store.lastUnfinishedRound()) {
    await store.finishRound(round.id, { status: 'ABANDONED', at: now() });
    summary.abandonedRoundIds.push(round.id);
  }

  for (const bet of await store.listUnsettledBets()) {
    if (bet.status === 'ACTIVE') {
      // A crash between `finishRound(ABANDONED)` and this refund (or a crash
      // before settleRound swept a CRASHED round) leaves the bet ACTIVE; the
      // round's status, not the previous pass's progress, decides its fate.
      const round = await store.getRound(bet.roundId);
      if (round !== null && round.status === 'CRASHED') {
        await store.updateBet(bet.id, { status: 'LOST', settledAt: now() });
        summary.lostBets += 1;
      } else {
        // Abandoned or unknown round: the stake was charged and there is no
        // outcome, so refund it.
        await refundBet(store, bet, now);
        summary.refundedBets += 1;
      }
      continue;
    }
    if (await resolveIndeterminate(store, wallets, bet, now)) summary.resolvedIndeterminate += 1;
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

/** Runtime counterpart of boot recovery for bets stranded by a flaky wallet. */
export const RECONCILE_INTERVAL_MS = 60_000;

/**
 * Replays bets whose placement is still ambiguous. Only UNRESOLVED rows are
 * touched: ACTIVE belongs to the live engine, PLACING to an in-flight
 * placement, and boot recovery owns everything else.
 */
export async function reconcileUnresolvedBets(deps: RecoveryDeps): Promise<number> {
  const now = deps.now ?? (() => new Date());
  let resolved = 0;
  for (const bet of await deps.store.listUnsettledBets()) {
    if (bet.status !== 'UNRESOLVED') continue;
    if (await resolveIndeterminate(deps.store, deps.wallets, bet, now)) resolved += 1;
  }
  return resolved;
}

async function refundBet(store: Store, bet: BetRecord, now: () => Date): Promise<void> {
  await store.updateBet(bet.id, { status: 'CANCELLED', settledAt: now() });
  await store.enqueueOutbox({
    operatorCode: bet.operatorCode, type: 'ROLLBACK', txnId: bet.betTxnId,
    sessionToken: bet.sessionToken, amount: bet.stake,
  });
}

async function resolveIndeterminate(
  store: Store,
  wallets: OperatorWallets,
  bet: BetRecord,
  now: () => Date,
): Promise<boolean> {
  let wallet: WalletClient;
  try {
    wallet = await wallets.walletFor(bet.operatorCode);
  } catch (error) {
    // An operator that cannot be resolved right now (missing row, no secret) is
    // not a verdict on the bet: leave it UNRESOLVED for the next pass. Name the
    // tenant and the bet so the stuck replay is traceable — never the secret.
    if (error instanceof OperatorError) {
      console.error('recovery: operator unresolved, bet left UNRESOLVED', {
        operatorCode: bet.operatorCode, betId: bet.id,
      });
      return false;
    }
    throw error;
  }
  try {
    const reply = await wallet.bet({
      sessionToken: bet.sessionToken, txnId: bet.betTxnId,
      amount: bet.stake, roundId: String(bet.roundId),
    });
    // A 2xx that accepts nothing is still ambiguous: leave it for the next boot.
    if (!reply.accepted && !reply.replayed) return false;
    // An indeterminate placement never joined the round (the player was shown a
    // failure), so the round outcome must not decide it: refund, not LOST.
    await refundBet(store, bet, now);
    return true;
  } catch (error) {
    if (error instanceof WalletError) {
      // Only a 4xx status is definitive, whatever code the body carries.
      const isClientError = error.status !== null && error.status >= 400 && error.status < 500;
      if (isClientError && error.code === 'TRANSACTION_ROLLED_BACK') {
        // The charge landed and was refunded before the restart: cancel it and
        // leave a SENT tombstone so later boots do not mistake the CANCELLED bet
        // for an orphan and fabricate a delivery.
        await store.updateBet(bet.id, { status: 'CANCELLED', settledAt: now() });
        const row = await store.enqueueOutbox({
          operatorCode: bet.operatorCode, type: 'ROLLBACK', txnId: bet.betTxnId,
          sessionToken: bet.sessionToken, amount: bet.stake,
        });
        if (row !== null) await store.markOutbox(row.id, 'SENT', 'ALREADY_ROLLED_BACK');
        return true;
      }
      if (isClientError) {
        await store.updateBet(bet.id, { status: 'REJECTED', settledAt: now() });
        return true;
      }
    }
    // Transport failures and 5xx leave the row UNRESOLVED; the next boot retries.
    return false;
  }
}
