import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileUnresolvedBets, runRecovery } from '../src/server/recovery';
import {
  WalletError,
  type MovementInput,
  type MovementReply,
  type WalletClient,
} from '../src/server/wallet';
import { createMemoryStore, type MemoryStore } from '../src/test/memoryStore';
import type { BetStatus } from '../src/domain/types';

const AT = new Date(Date.UTC(2026, 0, 1));
const now = () => new Date(Date.UTC(2026, 0, 2));
const OPERATOR = 'bingo251';

const token = (n: number) => `11111111-1111-4111-8111-1111111111${String(n).padStart(2, '0')}`;
const txn = (n: number) => `22222222-2222-4222-8222-2222222222${String(n).padStart(2, '0')}`;

function fixture(walletOverrides: Partial<WalletClient> = {}) {
  const store = createMemoryStore({ now: () => new Date(AT) });
  const replays: MovementInput[] = [];
  const wallet: WalletClient = {
    balance: async () => { throw new Error('unused'); },
    bet: async (input) => {
      replays.push(input);
      return { accepted: true, replayed: false, balance: null } satisfies MovementReply;
    },
    win: async () => { throw new Error('unused'); },
    rollback: async () => { throw new Error('unused'); },
    ...walletOverrides,
  };
  return { store, wallet, replays };
}

interface BetSeed {
  roundId: number;
  sessionToken: string;
  panel?: 0 | 1;
  stake: bigint;
  status: BetStatus;
  betTxnId: string;
  winTxnId?: string | null;
  payout?: bigint | null;
  cashoutMultiplier?: number | null;
}

function seedBet(store: MemoryStore, seed: BetSeed) {
  return store.insertBet({
    roundId: seed.roundId,
    operatorCode: OPERATOR,
    sessionToken: seed.sessionToken,
    panel: seed.panel ?? 0,
    stake: seed.stake,
    autoCashout: null,
    status: seed.status,
    cashoutMultiplier: seed.cashoutMultiplier ?? null,
    payout: seed.payout ?? null,
    betTxnId: seed.betTxnId,
    winTxnId: seed.winTxnId ?? null,
  });
}

/**
 * The interrupted boot from the brief: one FLYING round holding two ACTIVE
 * bets, a settled win, an orphaned window (row missing), an orphaned rollback,
 * and one indeterminate charge.
 */
async function seedInterruptedBoot(store: MemoryStore) {
  const round = await store.createRound({ serverSeed: 'seed', serverSeedHash: 'hash', startedAt: AT });
  await store.startFlight(round.id, { crashPoint: 2.5, clientSeedComposite: 'composite', at: AT });

  const activeA = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 1_000n, status: 'ACTIVE', betTxnId: txn(1),
  });
  const activeB = await seedBet(store, {
    roundId: round.id, sessionToken: token(2), stake: 2_000n, status: 'ACTIVE', betTxnId: txn(2),
  });
  const cashedSettled = await seedBet(store, {
    roundId: round.id, sessionToken: token(3), stake: 500n, status: 'CASHED',
    cashoutMultiplier: 2.5, payout: 1_250n, betTxnId: txn(3), winTxnId: txn(4),
  });
  const settledWin = await store.enqueueOutbox({
    operatorCode: OPERATOR, type: 'WIN', txnId: txn(4), sessionToken: token(3), amount: 1_250n,
  });
  assert.ok(settledWin);
  const cashedOrphan = await seedBet(store, {
    roundId: round.id, sessionToken: token(4), stake: 400n, status: 'CASHED',
    cashoutMultiplier: 2.25, payout: 900n, betTxnId: txn(5), winTxnId: txn(6),
  });
  const cancelledOrphan = await seedBet(store, {
    roundId: round.id, sessionToken: token(5), stake: 300n, status: 'CANCELLED', betTxnId: txn(7),
  });
  const unresolved = await seedBet(store, {
    roundId: round.id, sessionToken: token(6), stake: 600n, status: 'UNRESOLVED', betTxnId: txn(8),
  });

  return { round, activeA, activeB, cashedSettled, cashedOrphan, cancelledOrphan, unresolved, settledWin };
}

const betByTxn = (store: MemoryStore, betTxnId: string) =>
  store.dump().bets.find((bet) => bet.betTxnId === betTxnId)!;
const outboxFor = (store: MemoryStore, type: 'WIN' | 'ROLLBACK', txnId: string) =>
  store.dump().outbox.filter((row) => row.type === type && row.txnId === txnId);

test('boot recovery abandons the round, refunds ACTIVE bets, resolves the indeterminate charge and repairs settlements', async () => {
  const { store, wallet, replays } = fixture();
  const seeded = await seedInterruptedBoot(store);

  const summary = await runRecovery({ store, wallet, now });

  assert.deepEqual(summary, {
    abandonedRoundIds: [seeded.round.id],
    refundedBets: 2,
    lostBets: 0,
    resolvedIndeterminate: 1,
    repairedSettlements: 2,
  });

  const round = await store.getRound(seeded.round.id);
  assert.equal(round!.status, 'ABANDONED');
  assert.equal(round!.crashedAt?.getTime(), now().getTime());

  // Both ACTIVE bets are refunded with their own placement txn id and stake.
  for (const [bet, stake] of [
    [seeded.activeA, 1_000n],
    [seeded.activeB, 2_000n],
  ] as const) {
    const cancelled = betByTxn(store, bet.betTxnId);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.settledAt?.getTime(), now().getTime());
    const rows = outboxFor(store, 'ROLLBACK', bet.betTxnId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.amount, stake);
    assert.equal(rows[0]!.sessionToken, bet.sessionToken);
    assert.equal(rows[0]!.operatorCode, OPERATOR);
  }

  // The already-written win row is neither touched nor duplicated.
  const settledWins = outboxFor(store, 'WIN', seeded.cashedSettled.winTxnId!);
  assert.equal(settledWins.length, 1);
  assert.equal(settledWins[0]!.id, seeded.settledWin.id);
  assert.equal(settledWins[0]!.amount, 1_250n);

  // The orphaned CASHED bet gets its win row back.
  const repairedWins = outboxFor(store, 'WIN', seeded.cashedOrphan.winTxnId!);
  assert.equal(repairedWins.length, 1);
  assert.equal(repairedWins[0]!.amount, 900n);
  assert.equal(repairedWins[0]!.sessionToken, seeded.cashedOrphan.sessionToken);

  // The orphaned CANCELLED bet gets its rollback row back.
  const repairedRollbacks = outboxFor(store, 'ROLLBACK', seeded.cancelledOrphan.betTxnId);
  assert.equal(repairedRollbacks.length, 1);
  assert.equal(repairedRollbacks[0]!.amount, 300n);

  // The UNRESOLVED charge is replayed with the original txn id, then refunded.
  assert.equal(replays.length, 1);
  assert.equal(replays[0]!.txnId, seeded.unresolved.betTxnId);
  assert.equal(replays[0]!.amount, 600n);
  assert.equal(replays[0]!.sessionToken, seeded.unresolved.sessionToken);
  assert.equal(replays[0]!.roundId, String(seeded.round.id));
  const resolved = betByTxn(store, seeded.unresolved.betTxnId);
  assert.equal(resolved.status, 'CANCELLED');
  assert.equal(resolved.settledAt?.getTime(), now().getTime());
  assert.equal(outboxFor(store, 'ROLLBACK', seeded.unresolved.betTxnId).length, 1);

  assert.equal(store.dump().outbox.length, 6);
});

test('a replayed placement that is accepted is refunded and counted', async () => {
  const { store, wallet } = fixture();
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  const placing = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 750n, status: 'PLACING', betTxnId: txn(1),
  });

  const summary = await runRecovery({ store, wallet, now });

  assert.equal(summary.resolvedIndeterminate, 1);
  assert.equal(summary.refundedBets, 0);
  assert.equal(summary.lostBets, 0);
  assert.equal(summary.repairedSettlements, 0);
  const resolved = betByTxn(store, placing.betTxnId);
  assert.equal(resolved.status, 'CANCELLED');
  assert.equal(resolved.settledAt?.getTime(), now().getTime());
  const rows = outboxFor(store, 'ROLLBACK', placing.betTxnId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.amount, 750n);
});

test('a placement the wallet reports as replayed is refunded and counted', async () => {
  const { store, wallet } = fixture({
    bet: async () => ({ accepted: false, replayed: true, balance: null }) satisfies MovementReply,
  });
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  const unresolved = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 800n, status: 'UNRESOLVED', betTxnId: txn(1),
  });

  const summary = await runRecovery({ store, wallet, now });

  assert.equal(summary.resolvedIndeterminate, 1);
  assert.equal(betByTxn(store, unresolved.betTxnId).status, 'CANCELLED');
  const rows = outboxFor(store, 'ROLLBACK', unresolved.betTxnId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.amount, 800n);
});

test('a 2xx that accepts nothing leaves the bet UNRESOLVED and uncounted', async () => {
  const { store, wallet } = fixture({
    bet: async () => ({ accepted: false, replayed: false, balance: null }) satisfies MovementReply,
  });
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  const unresolved = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 800n, status: 'UNRESOLVED', betTxnId: txn(1),
  });

  const summary = await runRecovery({ store, wallet, now });

  assert.equal(summary.resolvedIndeterminate, 0);
  const bet = betByTxn(store, unresolved.betTxnId);
  assert.equal(bet.status, 'UNRESOLVED');
  assert.equal(bet.settledAt, null);
  assert.equal(store.dump().outbox.length, 0);
});

test('a 5xx on the replay leaves the bet UNRESOLVED and uncounted', async () => {
  const { store, wallet } = fixture({
    bet: async () => { throw new WalletError(500, 'WALLET_HTTP_ERROR', 'boom'); },
  });
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  const unresolved = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 800n, status: 'UNRESOLVED', betTxnId: txn(1),
  });

  const summary = await runRecovery({ store, wallet, now });

  assert.equal(summary.resolvedIndeterminate, 0);
  const bet = betByTxn(store, unresolved.betTxnId);
  assert.equal(bet.status, 'UNRESOLVED');
  assert.equal(bet.settledAt, null);
  assert.equal(store.dump().outbox.length, 0);
});

test('an ACTIVE bet in an already-ABANDONED round is refunded without re-abandoning the round', async () => {
  const { store, wallet } = fixture();
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  // A previous pass died between `finishRound(ABANDONED)` and the refund loop.
  await store.finishRound(round.id, { status: 'ABANDONED', at: AT });
  const leftover = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 900n, status: 'ACTIVE', betTxnId: txn(1),
  });

  const summary = await runRecovery({ store, wallet, now });

  assert.deepEqual(summary.abandonedRoundIds, []);
  assert.equal(summary.refundedBets, 1);
  assert.equal(summary.lostBets, 0);
  assert.equal((await store.getRound(round.id))!.crashedAt?.getTime(), AT.getTime());
  const cancelled = betByTxn(store, leftover.betTxnId);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.settledAt?.getTime(), now().getTime());
  const rows = outboxFor(store, 'ROLLBACK', leftover.betTxnId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.amount, 900n);
});

test('an ACTIVE bet in a CRASHED round is lost, not refunded', async () => {
  const { store, wallet } = fixture();
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  await store.startFlight(round.id, { crashPoint: 1.5, clientSeedComposite: 'composite', at: AT });
  // A crash before settleRound swept the round leaves the bet ACTIVE.
  await store.finishRound(round.id, { status: 'CRASHED', at: AT });
  const leftover = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 700n, status: 'ACTIVE', betTxnId: txn(1),
  });

  const summary = await runRecovery({ store, wallet, now });

  assert.equal(summary.lostBets, 1);
  assert.equal(summary.refundedBets, 0);
  assert.deepEqual(summary.abandonedRoundIds, []);
  const lost = betByTxn(store, leftover.betTxnId);
  assert.equal(lost.status, 'LOST');
  assert.equal(lost.settledAt?.getTime(), now().getTime());
  assert.equal(store.dump().outbox.length, 0);
});

test('a 5xx carrying TRANSACTION_ROLLED_BACK is not definitive and leaves the bet UNRESOLVED', async () => {
  const { store, wallet } = fixture({
    bet: async () => { throw new WalletError(500, 'TRANSACTION_ROLLED_BACK', 'upstream mislabelled'); },
  });
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  const unresolved = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 800n, status: 'UNRESOLVED', betTxnId: txn(1),
  });

  const summary = await runRecovery({ store, wallet, now });

  assert.equal(summary.resolvedIndeterminate, 0);
  const bet = betByTxn(store, unresolved.betTxnId);
  assert.equal(bet.status, 'UNRESOLVED');
  assert.equal(bet.settledAt, null);
  assert.equal(store.dump().outbox.length, 0);
});

test('a 409 TRANSACTION_ROLLED_BACK tombstones the rollback so the next pass is a no-op', async () => {
  const { store, wallet } = fixture({
    bet: async () => { throw new WalletError(409, 'TRANSACTION_ROLLED_BACK', 'already refunded'); },
  });
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  const unresolved = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 800n, status: 'UNRESOLVED', betTxnId: txn(1),
  });

  const summary = await runRecovery({ store, wallet, now });

  assert.equal(summary.resolvedIndeterminate, 1);
  assert.equal(summary.repairedSettlements, 0);
  assert.equal(betByTxn(store, unresolved.betTxnId).status, 'CANCELLED');

  // bingo already applied that rollback: the row is a marker, never delivered.
  const rows = outboxFor(store, 'ROLLBACK', unresolved.betTxnId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'SENT');
  assert.equal(rows[0]!.lastError, 'ALREADY_ROLLED_BACK');
  assert.equal(rows[0]!.amount, 800n);

  const second = await runRecovery({ store, wallet, now });

  assert.equal(second.repairedSettlements, 0);
  assert.equal(outboxFor(store, 'ROLLBACK', unresolved.betTxnId).length, 1);
  assert.equal(store.dump().outbox.length, 1);
});

test('any other 4xx rejects the bet without a rollback', async () => {
  const { store, wallet } = fixture({
    bet: async () => { throw new WalletError(409, 'SESSION_CLOSED', 'session closed'); },
  });
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  const unresolved = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 800n, status: 'UNRESOLVED', betTxnId: txn(1),
  });

  const summary = await runRecovery({ store, wallet, now });

  assert.equal(summary.resolvedIndeterminate, 1);
  const bet = betByTxn(store, unresolved.betTxnId);
  assert.equal(bet.status, 'REJECTED');
  assert.equal(bet.settledAt?.getTime(), now().getTime());
  assert.equal(store.dump().outbox.length, 0);
});

test('a second recovery pass on the same store is a clean no-op', async () => {
  const { store, wallet } = fixture();
  await seedInterruptedBoot(store);
  await runRecovery({ store, wallet, now });
  const settled = store.dump();

  const summary = await runRecovery({ store, wallet, now });

  assert.deepEqual(summary, {
    abandonedRoundIds: [],
    refundedBets: 0,
    lostBets: 0,
    resolvedIndeterminate: 0,
    repairedSettlements: 0,
  });
  assert.deepEqual(store.dump(), settled);
});

test('the runtime sweep refunds an UNRESOLVED bet the wallet now accepts', async () => {
  const { store, wallet, replays } = fixture();
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  const unresolved = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 600n, status: 'UNRESOLVED', betTxnId: txn(1),
  });

  assert.equal(await reconcileUnresolvedBets({ store, wallet, now }), 1);

  // The original txn id is replayed, so bingo dedupes a second sweep.
  assert.equal(replays.length, 1);
  assert.equal(replays[0]!.txnId, unresolved.betTxnId);
  const resolved = betByTxn(store, unresolved.betTxnId);
  assert.equal(resolved.status, 'CANCELLED');
  assert.equal(resolved.settledAt?.getTime(), now().getTime());
  const rows = outboxFor(store, 'ROLLBACK', unresolved.betTxnId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.amount, 600n);
  assert.equal(rows[0]!.sessionToken, unresolved.sessionToken);
});

test('the runtime sweep leaves an UNRESOLVED bet alone while the wallet still fails', async () => {
  const { store, wallet } = fixture({
    bet: async () => { throw new WalletError(500, 'WALLET_HTTP_ERROR', 'boom'); },
  });
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  const unresolved = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 600n, status: 'UNRESOLVED', betTxnId: txn(1),
  });

  assert.equal(await reconcileUnresolvedBets({ store, wallet, now }), 0);

  const bet = betByTxn(store, unresolved.betTxnId);
  assert.equal(bet.status, 'UNRESOLVED');
  assert.equal(bet.settledAt, null);
  assert.equal(store.dump().outbox.length, 0);
});

test('the runtime sweep never touches an ACTIVE bet in a live round', async () => {
  const { store, wallet, replays } = fixture();
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  await store.startFlight(round.id, { crashPoint: 2.5, clientSeedComposite: 'composite', at: AT });
  const active = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 900n, status: 'ACTIVE', betTxnId: txn(1),
  });

  assert.equal(await reconcileUnresolvedBets({ store, wallet, now }), 0);

  assert.equal(replays.length, 0);
  assert.equal(betByTxn(store, active.betTxnId).status, 'ACTIVE');
  assert.equal(store.dump().outbox.length, 0);
});

test('running the runtime sweep twice does not roll back twice', async () => {
  const { store, wallet, replays } = fixture();
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  const unresolved = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 600n, status: 'UNRESOLVED', betTxnId: txn(1),
  });

  assert.equal(await reconcileUnresolvedBets({ store, wallet, now }), 1);
  assert.equal(await reconcileUnresolvedBets({ store, wallet, now }), 0);

  assert.equal(replays.length, 1);
  assert.equal(outboxFor(store, 'ROLLBACK', unresolved.betTxnId).length, 1);
  assert.equal(store.dump().outbox.length, 1);
});

test('an UNRESOLVED bet in a crashed round is refunded while its ACTIVE neighbour is lost', async () => {
  const { store, wallet } = fixture();
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: AT });
  await store.startFlight(round.id, { crashPoint: 1.5, clientSeedComposite: 'composite', at: AT });
  await store.finishRound(round.id, { status: 'CRASHED', at: AT });
  const unresolved = await seedBet(store, {
    roundId: round.id, sessionToken: token(1), stake: 600n, status: 'UNRESOLVED', betTxnId: txn(1),
  });
  const active = await seedBet(store, {
    roundId: round.id, sessionToken: token(2), stake: 700n, status: 'ACTIVE', betTxnId: txn(2),
  });

  const summary = await runRecovery({ store, wallet, now });

  assert.equal(summary.resolvedIndeterminate, 1);
  assert.equal(summary.lostBets, 1);
  // Never joined the round: refund, don't mark LOST.
  const refunded = betByTxn(store, unresolved.betTxnId);
  assert.equal(refunded.status, 'CANCELLED');
  assert.equal(outboxFor(store, 'ROLLBACK', unresolved.betTxnId).length, 1);
  // The ACTIVE bet did join the round, so the crash decides it.
  assert.equal(betByTxn(store, active.betTxnId).status, 'LOST');
  assert.equal(outboxFor(store, 'ROLLBACK', active.betTxnId).length, 0);
});
