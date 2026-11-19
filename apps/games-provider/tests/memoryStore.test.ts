import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/test/memoryStore';

test('outbox attempts count reschedules only, never terminal marks', async () => {
  const t0 = new Date('2026-01-01T00:00:00.000Z');
  let clock = t0;
  const store = createMemoryStore({ now: () => clock });
  const entry = {
    operatorCode: 'op-a',
    type: 'WIN' as const,
    txnId: 'txn-1',
    sessionToken: 'sess-1',
    amount: 2500n,
  };

  // Dedupe on (operatorCode, type, txnId): first enqueue wins, second is a no-op.
  const first = await store.enqueueOutbox(entry);
  assert.ok(first);
  assert.equal(first.attempts, 0);
  assert.equal(await store.enqueueOutbox(entry), null);

  clock = new Date(t0.getTime() + 1_000);
  const nextAttemptAt = new Date(t0.getTime() + 3_000);
  await store.rescheduleOutbox(first.id, nextAttemptAt, 'timeout');

  let row = store.dump().outbox[0];
  assert.equal(row.attempts, 1);
  assert.equal(row.nextAttemptAt.getTime(), nextAttemptAt.getTime());
  assert.equal(row.lastError, 'timeout');
  assert.equal(row.updatedAt.getTime(), clock.getTime());

  // A terminal mark must not touch the retry counter.
  clock = new Date(t0.getTime() + 4_000);
  await store.markOutbox(first.id, 'SENT');

  row = store.dump().outbox[0];
  assert.equal(row.attempts, 1);
  assert.equal(row.status, 'SENT');
  assert.equal(row.lastError, null);
  assert.equal(row.updatedAt.getTime(), clock.getTime());
});

test('countOutboxByStatus counts the rows of one status only', async () => {
  const store = createMemoryStore();
  const row = await store.enqueueOutbox({
    operatorCode: 'op-a',
    type: 'ROLLBACK',
    txnId: 'txn-1',
    sessionToken: 'sess-1',
    amount: 2500n,
  });
  assert.ok(row);

  assert.equal(await store.countOutboxByStatus('PENDING'), 1);
  assert.equal(await store.countOutboxByStatus('DEAD'), 0);

  await store.markOutbox(row.id, 'DEAD', 'X');
  assert.equal(await store.countOutboxByStatus('DEAD'), 1);
  assert.equal(await store.countOutboxByStatus('PENDING'), 0);
});

const operator = {
  code: 'op-a', name: 'Operator A', callbackUrl: 'https://a.example/cb', currency: 'ETB',
  status: 'ACTIVE' as const, allowedOrigins: ['https://a.example'],
  localeDefault: 'en' as const,
  limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
  enabledGames: ['crash'], theme: { accent: '#f59e0b' }, maintenance: false,
  probeOkAt: new Date('2026-11-19T00:00:00Z'), createdAt: new Date('2026-11-19T00:00:00Z'),
};

test('operator records round-trip nested limits and arrays without aliasing', async () => {
  const store = createMemoryStore();
  await store.upsertOperator(operator);
  const read = await store.getOperator('op-a');
  assert.deepEqual(read, operator);
  read!.allowedOrigins.push('https://evil.example');
  assert.deepEqual((await store.getOperator('op-a'))!.allowedOrigins, ['https://a.example']);
});

test('operator secrets version up and retire in place', async () => {
  const store = createMemoryStore();
  await store.upsertOperator(operator);
  const v1 = await store.addOperatorSecret('op-a', 'secret-one');
  const v2 = await store.addOperatorSecret('op-a', 'secret-two');
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  await store.retireOperatorSecret('op-a', 1);
  const secrets = await store.listOperatorSecrets('op-a');
  assert.equal(secrets.find((s) => s.version === 1)?.retiredAt instanceof Date, true);
  assert.equal(secrets.find((s) => s.version === 2)?.retiredAt, null);
});

test('bets-per-round counts are scoped per operator', async () => {
  const store = createMemoryStore();
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: new Date() });
  const base = {
    roundId: round.id, panel: 0 as const, stake: 100n, autoCashout: null,
    status: 'ACTIVE' as const, cashoutMultiplier: null, payout: null,
    betTxnId: 't1', winTxnId: null,
  };
  await store.insertBet({ ...base, operatorCode: 'op-a', sessionToken: '11111111-1111-4111-8111-111111111111' });
  await store.insertBet({ ...base, operatorCode: 'op-b', sessionToken: '22222222-2222-4222-8222-222222222222' });
  assert.equal(await store.countBetsForRoundByOperator(round.id, 'op-a'), 1);
  assert.equal(await store.countBetsForRound(round.id), 2);
});
