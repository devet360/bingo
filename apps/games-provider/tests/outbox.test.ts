import test from 'node:test';
import assert from 'node:assert/strict';
import { OutboxWorker } from '../src/server/outbox';
import type { Store } from '../src/server/store';
import { WalletError, type MovementReply, type WalletClient } from '../src/server/wallet';
import type { OutboxType, SessionRecord } from '../src/domain/types';
import { createMemoryStore, type MemoryStore } from '../src/test/memoryStore';

const TOKEN = '11111111-1111-4111-8111-111111111111';
const NOW = new Date(Date.UTC(2026, 0, 1));

type Script = () => Promise<MovementReply>;

const ok = (balance: bigint | null = null): Script => async () => ({ accepted: true, replayed: false, balance });
const fail = (status: number | null, code: string): Script => async () => {
  throw new WalletError(status, code, `${code} (test script)`);
};

function session(displayBalance = 10_000n): SessionRecord {
  return {
    token: TOKEN,
    operatorCode: 'bingo251',
    currency: 'ETB',
    minStake: 100n,
    maxStake: 100_000n,
    maxWin: 3_000_000n,
    displayBalance,
    status: 'OPEN',
    createdAt: new Date(0),
    lastHandshakeAt: new Date(0),
  };
}

/**
 * Memory store on a frozen clock. `enqueueOutbox` stamps `nextAttemptAt` with
 * that clock, so every seeded row is due at `NOW` and the retry offsets in the
 * assertions are exact.
 */
function fixture(options: { wrapStore?: (base: MemoryStore) => Store } = {}) {
  const store = createMemoryStore({ now: () => NOW });
  const calls: Array<{ kind: 'win' | 'rollback'; txnId: string; amount: bigint }> = [];
  const scripts = new Map<string, Script>();

  function dispatch(kind: 'win' | 'rollback', input: { txnId: string; amount: bigint }): Promise<MovementReply> {
    calls.push({ kind, txnId: input.txnId, amount: input.amount });
    const script = scripts.get(input.txnId);
    // An unscripted call is a bug in the test, not worker behaviour.
    if (script === undefined) throw new Error(`unscripted wallet call: ${kind} ${input.txnId}`);
    return script();
  }

  const wallet: WalletClient = {
    balance: async () => { throw new Error('outbox worker never calls wallet.balance'); },
    bet: async () => { throw new Error('outbox worker never calls wallet.bet'); },
    win: (input) => dispatch('win', input),
    rollback: (input) => dispatch('rollback', input),
  };

  async function seed(input: { txnId: string; type?: OutboxType; amount?: bigint }) {
    const row = await store.enqueueOutbox({
      operatorCode: 'bingo251',
      type: input.type ?? 'WIN',
      txnId: input.txnId,
      sessionToken: TOKEN,
      amount: input.amount ?? 1_000n,
    });
    assert.ok(row, `outbox row ${input.txnId} seeded`);
    return row;
  }

  return {
    store,
    calls,
    seed,
    script: (txnId: string, scripted: Script) => scripts.set(txnId, scripted),
    worker: new OutboxWorker({ store: options.wrapStore ? options.wrapStore(store) : store, wallet }),
  };
}

function rowOf(store: MemoryStore, txnId: string) {
  const row = store.dump().outbox.find((candidate) => candidate.txnId === txnId);
  assert.ok(row, `outbox row ${txnId} exists`);
  return row;
}

test('one drain classifies success, cap rejection and retryable failures', async () => {
  const { store, calls, seed, script, worker } = fixture();
  await seed({ txnId: 'win-ok' });
  await seed({ txnId: 'win-cap' });
  await seed({ txnId: 'win-closed' });
  await seed({ txnId: 'win-boom' });
  script('win-ok', ok(12_345n));
  script('win-cap', fail(409, 'WIN_LIMIT_EXCEEDED'));
  script('win-closed', fail(409, 'SESSION_CLOSED'));
  script('win-boom', fail(500, 'WALLET_HTTP_ERROR'));

  const summary = await worker.drainOnce(NOW);
  assert.deepEqual(summary, { sent: 1, retried: 2, capped: 1, dead: 0 });
  assert.equal(calls.length, 4);
  assert.equal(calls[0]!.amount, 1_000n);

  assert.equal(rowOf(store, 'win-ok').status, 'SENT');

  const capped = rowOf(store, 'win-cap');
  assert.equal(capped.status, 'CAP_REJECTED');
  assert.equal(capped.lastError, 'WIN_LIMIT_EXCEEDED');

  const closed = rowOf(store, 'win-closed');
  assert.equal(closed.status, 'PENDING');
  assert.equal(closed.attempts, 1);
  assert.equal(closed.lastError, 'SESSION_CLOSED');

  const boom = rowOf(store, 'win-boom');
  assert.equal(boom.status, 'PENDING');
  assert.equal(boom.attempts, 1);
  assert.equal(boom.lastError, 'WALLET_HTTP_ERROR');
  assert.equal(boom.nextAttemptAt.getTime(), NOW.getTime() + 1_000);
  assert.ok(boom.nextAttemptAt.getTime() > NOW.getTime());

  // A SENT row is terminal; the retries are scheduled in the future, so a
  // second pass at the same instant claims nothing at all.
  assert.deepEqual(await store.claimDueOutbox(NOW, 20), []);
  assert.deepEqual(await worker.drainOnce(NOW), { sent: 0, retried: 0, capped: 0, dead: 0 });
  assert.equal(rowOf(store, 'win-ok').status, 'SENT');
  assert.equal(calls.length, 4);
});

test('SESSION_CLOSED that survives one retry is DEAD', async () => {
  const { store, seed, script, worker } = fixture();
  await seed({ txnId: 'win-closed' });
  script('win-closed', fail(409, 'SESSION_CLOSED'));

  assert.deepEqual(await worker.drainOnce(NOW), { sent: 0, retried: 1, capped: 0, dead: 0 });
  const retryAt = rowOf(store, 'win-closed').nextAttemptAt;

  assert.deepEqual(await worker.drainOnce(retryAt), { sent: 0, retried: 0, capped: 0, dead: 1 });
  const row = rowOf(store, 'win-closed');
  assert.equal(row.status, 'DEAD');
  assert.equal(row.lastError, 'SESSION_CLOSED');
  assert.equal(row.attempts, 1);
});

test('TRANSACTION_ROLLED_BACK that survives one retry is DEAD', async () => {
  const { store, seed, script, worker } = fixture();
  await seed({ txnId: 'win-rolled-back' });
  script('win-rolled-back', fail(409, 'TRANSACTION_ROLLED_BACK'));

  assert.equal((await worker.drainOnce(NOW)).retried, 1);
  assert.equal(rowOf(store, 'win-rolled-back').attempts, 1);

  const retryAt = rowOf(store, 'win-rolled-back').nextAttemptAt;
  assert.equal((await worker.drainOnce(retryAt)).dead, 1);
  const row = rowOf(store, 'win-rolled-back');
  assert.equal(row.status, 'DEAD');
  assert.equal(row.lastError, 'TRANSACTION_ROLLED_BACK');
});

test('a rollback whose original never applied dies with NOT_FOUND after one retry', async () => {
  const { store, calls, seed, script, worker } = fixture();
  await seed({ txnId: 'bet-txn', type: 'ROLLBACK', amount: 1_000n });
  script('bet-txn', fail(404, 'NOT_FOUND'));

  assert.equal((await worker.drainOnce(NOW)).retried, 1);
  assert.equal(rowOf(store, 'bet-txn').status, 'PENDING');
  assert.equal(rowOf(store, 'bet-txn').lastError, 'NOT_FOUND');

  const retryAt = rowOf(store, 'bet-txn').nextAttemptAt;
  assert.equal((await worker.drainOnce(retryAt)).dead, 1);
  const row = rowOf(store, 'bet-txn');
  // DEAD is the audit trail: a 404 is not a delivery.
  assert.equal(row.status, 'DEAD');
  assert.equal(row.lastError, 'NOT_FOUND');
  assert.deepEqual(calls.map((call) => call.kind), ['rollback', 'rollback']);
});

test('a permanent 4xx refusal that is not a closed session is DEAD after one replay', async () => {
  const { store, seed, script, worker } = fixture();
  await seed({ txnId: 'win-inactive' });
  script('win-inactive', fail(403, 'ACCOUNT_INACTIVE'));

  assert.deepEqual(await worker.drainOnce(NOW), { sent: 0, retried: 1, capped: 0, dead: 0 });
  const pending = rowOf(store, 'win-inactive');
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.lastError, 'ACCOUNT_INACTIVE');
  assert.equal(pending.attempts, 1);

  // A refusal is deterministic: the second pass must end the row, not back off again.
  assert.equal((await worker.drainOnce(pending.nextAttemptAt)).dead, 1);
  const row = rowOf(store, 'win-inactive');
  assert.equal(row.status, 'DEAD');
  assert.equal(row.lastError, 'ACCOUNT_INACTIVE');
});

test('a WIN that 404s on an unknown session is DEAD after one replay', async () => {
  const { store, seed, script, worker } = fixture();
  await seed({ txnId: 'win-unknown' });
  script('win-unknown', fail(404, 'NOT_FOUND'));

  assert.deepEqual(await worker.drainOnce(NOW), { sent: 0, retried: 1, capped: 0, dead: 0 });
  const pending = rowOf(store, 'win-unknown');
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.lastError, 'NOT_FOUND');
  assert.equal(pending.attempts, 1);

  assert.equal((await worker.drainOnce(pending.nextAttemptAt)).dead, 1);
  const row = rowOf(store, 'win-unknown');
  assert.equal(row.status, 'DEAD');
  assert.equal(row.lastError, 'NOT_FOUND');
});

test('an unreadable 4xx body stays retryable', async () => {
  const { store, seed, script, worker } = fixture();
  await seed({ txnId: 'win-mangled' });
  script('win-mangled', fail(400, 'WALLET_RESPONSE_INVALID'));

  assert.equal((await worker.drainOnce(NOW)).retried, 1);
  const pending = rowOf(store, 'win-mangled');
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.nextAttemptAt.getTime(), NOW.getTime() + 1_000);

  assert.equal((await worker.drainOnce(pending.nextAttemptAt)).retried, 1);
  const row = rowOf(store, 'win-mangled');
  assert.equal(row.status, 'PENDING');
  assert.notEqual(row.status, 'DEAD');
  assert.equal(row.attempts, 2);
});

test('a 429 stays retryable', async () => {
  const { store, seed, script, worker } = fixture();
  await seed({ txnId: 'win-throttled' });
  script('win-throttled', fail(429, 'RATE_LIMITED'));

  assert.equal((await worker.drainOnce(NOW)).retried, 1);
  const pending = rowOf(store, 'win-throttled');
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.attempts, 1);

  assert.equal((await worker.drainOnce(pending.nextAttemptAt)).retried, 1);
  const row = rowOf(store, 'win-throttled');
  assert.equal(row.status, 'PENDING');
  assert.equal(row.attempts, 2);
});

test('an unreadable 4xx body with WALLET_HTTP_ERROR stays retryable', async () => {
  const { store, seed, script, worker } = fixture();
  await seed({ txnId: 'win-mangled-4xx' });
  // A proxy/WAF 4xx HTML page: the status is 4xx but the refusal is unreadable.
  script('win-mangled-4xx', fail(404, 'WALLET_HTTP_ERROR'));

  assert.equal((await worker.drainOnce(NOW)).retried, 1);
  const pending = rowOf(store, 'win-mangled-4xx');
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.lastError, 'WALLET_HTTP_ERROR');
  assert.equal(pending.nextAttemptAt.getTime(), NOW.getTime() + 1_000);

  assert.equal((await worker.drainOnce(pending.nextAttemptAt)).retried, 1);
  const row = rowOf(store, 'win-mangled-4xx');
  assert.equal(row.status, 'PENDING');
  assert.notEqual(row.status, 'DEAD');
  assert.equal(row.attempts, 2);
});

test('a 408 stays retryable', async () => {
  const { store, seed, script, worker } = fixture();
  await seed({ txnId: 'win-timeout' });
  script('win-timeout', fail(408, 'TIMEOUT'));

  assert.equal((await worker.drainOnce(NOW)).retried, 1);
  const pending = rowOf(store, 'win-timeout');
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.attempts, 1);
  assert.equal(pending.lastError, 'TIMEOUT');

  assert.equal((await worker.drainOnce(pending.nextAttemptAt)).retried, 1);
  const row = rowOf(store, 'win-timeout');
  assert.equal(row.status, 'PENDING');
  assert.notEqual(row.status, 'DEAD');
  assert.equal(row.attempts, 2);
});

test('a 2xx reply that does not accept the movement retries as NOT_ACCEPTED, never SENT', async () => {
  const { store, seed, script, worker } = fixture();
  await seed({ txnId: 'win-declined' });
  script('win-declined', async () => ({ accepted: false, replayed: false, balance: 12_000n }));

  assert.equal((await worker.drainOnce(NOW)).retried, 1);
  const row = rowOf(store, 'win-declined');
  assert.equal(row.status, 'PENDING');
  assert.notEqual(row.status, 'SENT');
  assert.equal(row.lastError, 'NOT_ACCEPTED');
  assert.equal(row.attempts, 1);
});

test('a replayed reply is a delivery', async () => {
  const { store, seed, script, worker } = fixture();
  await seed({ txnId: 'win-replayed' });
  script('win-replayed', async () => ({ accepted: true, replayed: true, balance: null }));

  assert.equal((await worker.drainOnce(NOW)).sent, 1);
  assert.equal(rowOf(store, 'win-replayed').status, 'SENT');
});

test('a non-wallet failure retries with the UNKNOWN code', async () => {
  const { store, seed, script, worker } = fixture();
  await seed({ txnId: 'win-weird' });
  script('win-weird', async () => { throw new TypeError('socket hang up'); });

  assert.equal((await worker.drainOnce(NOW)).retried, 1);
  const row = rowOf(store, 'win-weird');
  assert.equal(row.status, 'PENDING');
  assert.equal(row.lastError, 'UNKNOWN');
});

test('a win reply mirrors its balance onto the session', async () => {
  const { store, seed, script, worker } = fixture();
  await store.saveSession(session());
  await seed({ txnId: 'win-ok' });
  script('win-ok', ok(12_540n));

  assert.equal((await worker.drainOnce(NOW)).sent, 1);
  assert.equal(store.dump().sessions[0]!.displayBalance, 12_540n);
});

test('start drains on a timer without overlapping, and stop halts it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  let claims = 0;
  const { store, calls, seed, script, worker } = fixture({
    wrapStore: (base) => ({
      ...base,
      claimDueOutbox: async (at, limit) => {
        claims += 1;
        return base.claimDueOutbox(at, limit);
      },
    }),
  });
  await seed({ txnId: 'win-slow' });
  let release!: () => void;
  script('win-slow', () => new Promise<MovementReply>((resolve) => {
    release = () => resolve({ accepted: true, replayed: false, balance: null });
  }));

  try {
    worker.start(20);
    t.mock.timers.tick(20);
    await flush();
    assert.equal(claims, 1);
    assert.equal(calls.length, 1);

    // A tick while the previous drain is still in flight must be skipped.
    t.mock.timers.tick(20);
    await flush();
    assert.equal(claims, 1);
    assert.equal(calls.length, 1);

    release();
    await flush();
    assert.equal(rowOf(store, 'win-slow').status, 'SENT');

    // The timer is still alive and drains again; the row is SENT so nothing is sent.
    t.mock.timers.tick(20);
    await flush();
    assert.equal(claims, 2);
    assert.equal(calls.length, 1);

    worker.stop();
    worker.stop(); // safe twice
    t.mock.timers.tick(20);
    t.mock.timers.tick(20);
    await flush();
    assert.equal(claims, 2);
    assert.equal(calls.length, 1);
  } finally {
    worker.stop();
    t.mock.timers.reset();
  }
});

test('a rejected drain is logged, never thrown, and the timer keeps running', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  const { worker } = fixture({
    wrapStore: (base) => ({
      ...base,
      claimDueOutbox: async () => { throw new Error('store unavailable'); },
    }),
  });

  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    worker.start(20);
    t.mock.timers.tick(20);
    await flush();
    assert.equal(logged.length, 1);
    assert.match(String(logged[0]![0]), /outbox/i);

    t.mock.timers.tick(20);
    await flush();
    assert.equal(logged.length, 2);
  } finally {
    console.error = originalError;
    worker.stop();
    t.mock.timers.reset();
  }
});

test('retry backoff is capped at 60s', async () => {
  const { store, seed, script, worker } = fixture();
  const seeded = await seed({ txnId: 'win-boom' });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await store.rescheduleOutbox(seeded.id, NOW, 'WALLET_HTTP_ERROR');
  }
  script('win-boom', fail(500, 'WALLET_HTTP_ERROR'));

  assert.equal((await worker.drainOnce(NOW)).retried, 1);
  const row = rowOf(store, 'win-boom');
  assert.equal(row.attempts, 11);
  assert.equal(row.nextAttemptAt.getTime(), NOW.getTime() + 60_000);
});
