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
