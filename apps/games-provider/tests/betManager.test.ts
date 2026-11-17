import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BetManager, BetRuleError } from '../src/server/betManager';
import { WalletError, type WalletClient, type MovementReply } from '../src/server/wallet';
import { type RoundBetManager } from '../src/server/roundEngine';
import { createMemoryStore } from '../src/test/memoryStore';
import type { BetRecord, RoundRecord, SessionRecord } from '../src/domain/types';

async function fixture(
  walletOverrides: Partial<WalletClient> = {},
  hooks: { onSettled?: (bet: BetRecord) => void } = {},
  sessionOverrides: Partial<SessionRecord> = {},
) {
  const store = createMemoryStore();
  const calls: Array<{ kind: string; amount: bigint; txnId: string }> = [];
  const wallet: WalletClient = {
    balance: async () => { throw new Error('unused'); },
    bet: async (input) => {
      calls.push({ kind: 'bet', amount: input.amount, txnId: input.txnId });
      return { accepted: true, replayed: false, balance: 9_000n } satisfies MovementReply;
    },
    win: async (input) => {
      calls.push({ kind: 'win', amount: input.amount, txnId: input.txnId });
      return { accepted: true, replayed: false, balance: 12_540n } satisfies MovementReply;
    },
    rollback: async (input) => {
      calls.push({ kind: 'rollback', amount: input.amount, txnId: input.txnId });
      return { accepted: true, replayed: false, balance: 10_000n } satisfies MovementReply;
    },
    ...walletOverrides,
  };
  const round: RoundRecord = {
    id: 1, serverSeed: 's', serverSeedHash: 'h', clientSeedComposite: null, crashPoint: null,
    status: 'BETTING', startedAt: new Date(0), flewAt: null, crashedAt: null,
  };
  const session: SessionRecord = {
    token: '11111111-1111-4111-8111-111111111111', operatorCode: 'bingo251', currency: 'ETB',
    minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, displayBalance: 10_000n,
    status: 'OPEN', createdAt: new Date(0), lastHandshakeAt: new Date(0),
    ...sessionOverrides,
  };
  // The sweep has no session argument, so the auto-cashout payout limit comes
  // from the persisted session row.
  await store.saveSession(session);
  // Typed as the seam interface so a missing method fails the typecheck, not just a test.
  const manager: RoundBetManager = new BetManager({
    store, wallet, limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 2 },
    now: () => new Date(1_000), newId: () => randomUUID(), onSettled: hooks.onSettled,
  });
  return { store, wallet, calls, round, session, manager };
}

test('a bet persists PLACING then ACTIVE and calls the wallet once', async () => {
  const { manager, store, calls, round, session } = await fixture();
  const bet = await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null });
  assert.equal(bet.status, 'ACTIVE');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.kind, 'bet');
  assert.equal(calls[0]!.amount, 1_000n);
  assert.equal(store.dump().bets.length, 1);
});

test('out-of-range stakes are rejected without a wallet call', async () => {
  const { manager, calls, round, session } = await fixture();
  for (const stake of [50n, 200_000n]) {
    await assert.rejects(manager.place({ round, session, panel: 0, stake, autoCashout: null }), /stake/i);
  }
  assert.equal(calls.length, 0);
});

test('the signed session maxStake, not config, bounds the stake', async () => {
  // Config allows 100_000n; the operator signed a tighter 5_000n cap.
  const { manager, calls, round, session } = await fixture({}, {}, { maxStake: 5_000n });
  await assert.rejects(
    manager.place({ round, session, panel: 0, stake: 10_000n, autoCashout: null }),
    (error: unknown) => error instanceof BetRuleError && error.code === 'STAKE_OUT_OF_RANGE',
  );
  assert.equal(calls.length, 0);
});

test('stakes exactly at the session minimum and maximum are accepted', async () => {
  const { manager, round, session } = await fixture({}, {}, { minStake: 500n, maxStake: 2_000n });
  const low = await manager.place({ round, session, panel: 0, stake: 500n, autoCashout: null });
  const high = await manager.place({ round, session, panel: 1, stake: 2_000n, autoCashout: null });
  assert.equal(low.status, 'ACTIVE');
  assert.equal(high.status, 'ACTIVE');
});

test('the round bet limit rejects the bet after maxBetsPerRound', async () => {
  const { manager, round, session } = await fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null });
  await manager.place({ round, session, panel: 1, stake: 1_000n, autoCashout: null });
  const other = { ...session, token: '33333333-3333-4333-8333-333333333333' };
  await assert.rejects(
    manager.place({ round, session: other, panel: 0, stake: 1_000n, autoCashout: null }),
    (error: unknown) => error instanceof BetRuleError && error.code === 'ROUND_BET_LIMIT',
  );
});

test('a wallet 409 marks the bet REJECTED and surfaces the code', async () => {
  const { manager, round, session } = await fixture({
    bet: async () => { throw new WalletError(409, 'INSUFFICIENT_FUNDS', 'no funds'); },
  });
  await assert.rejects(
    manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null }),
    (error: unknown) => error instanceof WalletError && error.code === 'INSUFFICIENT_FUNDS',
  );
});

test('a wallet timeout leaves the bet UNRESOLVED', async () => {
  const { manager, store, round, session } = await fixture({
    bet: async () => { throw new WalletError(null, 'TIMEOUT', 'slow'); },
  });
  await assert.rejects(
    manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null }),
    (error: unknown) => error instanceof WalletError && error.code === 'TIMEOUT',
  );
  assert.equal(store.dump().bets[0]!.status, 'UNRESOLVED');
});

test('cashout stores the multiplier and enqueues a win with a fresh txn id', async () => {
  const { manager, store, round, session } = await fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null });
  const winning = { ...round, status: 'FLYING' as const, crashPoint: 5 };
  await manager.cashout({ round: winning, session, panel: 0, multiplier: 2.54 });
  const bet = store.dump().bets[0]!;
  assert.equal(bet.status, 'CASHED');
  assert.equal(bet.payout, 2_540n);
  assert.notEqual(bet.winTxnId, bet.betTxnId);
  const outbox = store.dump().outbox;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.type, 'WIN');
  assert.equal(outbox[0]!.amount, 2_540n);
});

test('cancel before takeoff enqueues a rollback for the stake', async () => {
  const { manager, store, round, session } = await fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null });
  await manager.cancel({ round, session, panel: 0 });
  const bet = store.dump().bets[0]!;
  assert.equal(bet.status, 'CANCELLED');
  assert.equal(store.dump().outbox[0]!.type, 'ROLLBACK');
  assert.equal(store.dump().outbox[0]!.amount, 1_000n);
});

test('settling a crashed round marks uncashed ACTIVE bets LOST', async () => {
  const { manager, store, round, session } = await fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: 1.0 });
  await manager.settleRound({ round: { ...round, status: 'CRASHED', crashPoint: 1 }, maxWin: 30_000n });
  assert.equal(store.dump().bets[0]!.status, 'LOST');
});

test('settleRound only settles a crashed round', async () => {
  const { manager, store, round, session } = await fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null });
  const flying = { ...round, status: 'FLYING' as const, crashPoint: 2 };
  await assert.rejects(manager.settleRound({ round: flying, maxWin: 3_000_000n }), /not crashed/i);
  assert.equal(store.dump().bets[0]!.status, 'ACTIVE');
});

test('settling a crashed round leaves a cashed bet untouched', async () => {
  const { manager, store, round, session } = await fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null });
  const flying = { ...round, status: 'FLYING' as const, crashPoint: 2 };
  await manager.cashout({ round: flying, session, panel: 0, multiplier: 1.5 });
  await manager.settleRound({ round: { ...flying, status: 'CRASHED' }, maxWin: 3_000_000n });

  const bet = store.dump().bets[0]!;
  assert.equal(bet.status, 'CASHED');
  assert.equal(bet.payout, 1_500n);
  assert.equal(store.dump().outbox.length, 1);
});

test('place on a flying round is rejected', async () => {
  const { manager, calls, round, session } = await fixture();
  const flying = { ...round, status: 'FLYING' as const, crashPoint: 2 };
  await assert.rejects(
    manager.place({ round: flying, session, panel: 0, stake: 1_000n, autoCashout: null }),
    /Betting is closed/,
  );
  assert.equal(calls.length, 0);
});

test('cashout on a betting round is rejected', async () => {
  const { manager, round, session } = await fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null });
  await assert.rejects(
    manager.cashout({ round, session, panel: 0, multiplier: 1.5 }),
    /not flying/i,
  );
});

test('auto cashout settles the bet at its target and enqueues a win', async () => {
  const { manager, store, round, session } = await fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: 1.5 });
  const flying = { ...round, status: 'FLYING' as const, crashPoint: 2 };
  await manager.processAutoCashouts({ round: flying, multiplier: 1.6, elapsedMs: 1_000 });

  const bet = store.dump().bets[0]!;
  assert.equal(bet.status, 'CASHED');
  assert.equal(bet.cashoutMultiplier, 1.5);
  assert.equal(bet.payout, 1_500n);
  const outbox = store.dump().outbox;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.type, 'WIN');
  assert.equal(outbox[0]!.amount, 1_500n);

  // Second sweep on a later tick must not settle or pay the bet again.
  await manager.processAutoCashouts({ round: flying, multiplier: 1.7, elapsedMs: 1_200 });
  assert.equal(store.dump().outbox.length, 1);
  assert.equal(store.dump().bets[0]!.payout, 1_500n);
});

test('a payout above session.maxWin is clamped', async () => {
  const { manager, store, round, session } = await fixture();
  // 100_000 x 40.0 = 4_000_000, above the fixture's maxWin of 3_000_000.
  await manager.place({ round, session, panel: 0, stake: 100_000n, autoCashout: 40 });
  const flying = { ...round, status: 'FLYING' as const, crashPoint: 50 };
  await manager.processAutoCashouts({ round: flying, multiplier: 45, elapsedMs: 1_000 });

  const bet = store.dump().bets[0]!;
  assert.equal(bet.status, 'CASHED');
  assert.equal(bet.cashoutMultiplier, 40);
  assert.equal(bet.payout, session.maxWin);
  assert.equal(store.dump().outbox[0]!.amount, session.maxWin);
});

test('auto cashout never fires at or above the crash point', async () => {
  const { manager, store, round, session } = await fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: 2.0 });
  const flying = { ...round, status: 'FLYING' as const, crashPoint: 2 };
  await manager.processAutoCashouts({ round: flying, multiplier: 2, elapsedMs: 1_000 });
  assert.equal(store.dump().bets[0]!.status, 'ACTIVE');
  assert.equal(store.dump().outbox.length, 0);
});

test('the crash-tick sweep pays a target crossed after the last tick', async () => {
  const { manager, store, round, session } = await fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: 1.5 });
  const flying = { ...round, status: 'FLYING' as const, crashPoint: 2 };
  // The last 50 ms tick saw 1.98; the crash-tick sweep reports the final 2.00.
  await manager.processAutoCashouts({ round: flying, multiplier: 2, elapsedMs: 1_000 });

  const bet = store.dump().bets[0]!;
  assert.equal(bet.status, 'CASHED');
  assert.equal(bet.cashoutMultiplier, 1.5);
  assert.equal(bet.payout, 1_500n);
  const outbox = store.dump().outbox;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.type, 'WIN');
  assert.equal(outbox[0]!.amount, 1_500n);
});

test('a manual cashout racing the sweep mints exactly one win', async () => {
  const { manager, store, round, session } = await fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: 1.5 });
  const flying = { ...round, status: 'FLYING' as const, crashPoint: 2 };
  // Same bet, target and multiplier coincide: both paths pass the ACTIVE check.
  await Promise.all([
    manager.cashout({ round: flying, session, panel: 0, multiplier: 1.5 }),
    manager.processAutoCashouts({ round: flying, multiplier: 1.5, elapsedMs: 1_000 }),
  ]);

  const wins = store.dump().outbox.filter((row) => row.type === 'WIN');
  assert.equal(wins.length, 1);
  assert.equal(wins.reduce((total, row) => total + row.amount, 0n), 1_500n);
  assert.equal(store.dump().bets[0]!.status, 'CASHED');
});

test('a 2xx reply that does not accept the bet leaves it UNRESOLVED', async () => {
  const { manager, store, round, session } = await fixture({
    bet: async () => ({ accepted: false, replayed: false, balance: 8_000n }) satisfies MovementReply,
  });
  await assert.rejects(
    manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null }),
    (error: unknown) => error instanceof WalletError && error.code === 'BET_NOT_ACCEPTED',
  );
  assert.equal(store.dump().bets[0]!.status, 'UNRESOLVED');
  // The declined reply's balance is never mirrored: no charge happened.
  assert.equal(store.dump().sessions[0]!.displayBalance, session.displayBalance);
});

test('a 5xx wallet error leaves the bet UNRESOLVED', async () => {
  const { manager, store, round, session } = await fixture({
    bet: async () => { throw new WalletError(500, 'WALLET_HTTP_ERROR', 'boom'); },
  });
  await assert.rejects(
    manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null }),
    (error: unknown) => error instanceof WalletError && error.code === 'WALLET_HTTP_ERROR',
  );
  assert.equal(store.dump().bets[0]!.status, 'UNRESOLVED');
});

test('the sweep only touches the current round', async () => {
  const { manager, store, round, session } = await fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null });
  await store.insertBet({
    roundId: 2, operatorCode: session.operatorCode, sessionToken: session.token, panel: 0,
    stake: 1_000n, autoCashout: 1.2, status: 'ACTIVE', cashoutMultiplier: null, payout: null,
    betTxnId: randomUUID(), winTxnId: null,
  });
  const flying = { ...round, status: 'FLYING' as const, crashPoint: 2 };
  await manager.processAutoCashouts({ round: flying, multiplier: 1.5, elapsedMs: 1_000 });

  const other = store.dump().bets.find((bet) => bet.roundId === 2)!;
  assert.equal(other.status, 'ACTIVE');
  assert.equal(other.payout, null);
  assert.equal(store.dump().outbox.filter((row) => row.txnId === other.betTxnId).length, 0);
});

test('an auto cashout pushes the settled bet once, at the target multiplier', async () => {
  const settled: BetRecord[] = [];
  const { manager, store, round, session } = await fixture({}, { onSettled: (bet) => settled.push(bet) });
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: 1.2 });
  const flying = { ...round, status: 'FLYING' as const, crashPoint: 2 };
  await manager.processAutoCashouts({ round: flying, multiplier: 1.5, elapsedMs: 1_000 });

  assert.equal(settled.length, 1);
  const [pushed] = settled;
  assert.equal(pushed!.status, 'CASHED');
  assert.equal(pushed!.cashoutMultiplier, 1.2);
  assert.equal(pushed!.payout, 1_200n);
  // The pushed frame carries exactly what the row persisted.
  const row = store.dump().bets[0]!;
  assert.equal(pushed!.payout, row.payout);
  assert.equal(pushed!.winTxnId, row.winTxnId);
});

test('settling a crashed round pushes LOST for every active bet', async () => {
  const settled: BetRecord[] = [];
  const { manager, round, session } = await fixture({}, { onSettled: (bet) => settled.push(bet) });
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null });
  await manager.place({ round, session, panel: 1, stake: 500n, autoCashout: null });
  await manager.settleRound({ round: { ...round, status: 'CRASHED', crashPoint: 1 }, maxWin: 3_000_000n });

  assert.equal(settled.length, 2);
  assert.deepEqual(settled.map((bet) => bet.status), ['LOST', 'LOST']);
  assert.deepEqual(settled.map((bet) => bet.panel).sort(), [0, 1]);
});
