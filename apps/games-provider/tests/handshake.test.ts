import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBingo } from '../src/test/fakeBingo';
import { createMemoryStore } from '../src/test/memoryStore';
import { OperatorError, OperatorRegistry } from '../src/server/operatorRegistry';
import { handshake, SessionEndedError } from '../src/server/handshake';
import { loadConfig } from '../src/config';
import type { OperatorRecord } from '../src/domain/types';

const SECRET_A = 'test-secret-operator-a';
const SECRET_B = 'test-secret-operator-b';

function operator(code: string, callbackUrl: string, patch: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    code, name: code, callbackUrl, currency: 'ETB', status: 'ACTIVE', allowedOrigins: [],
    localeDefault: 'en', limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
    enabledGames: ['crash'], theme: null, maintenance: false, probeOkAt: null,
    createdAt: new Date('2026-11-19T00:00:00Z'), ...patch,
  };
}

async function setup() {
  const a = await createFakeBingo({ hmacSecret: SECRET_A, balance: 50_000n, currency: 'ETB', operatorCode: 'op-a' });
  const b = await createFakeBingo({ hmacSecret: SECRET_B, balance: 20_000n, currency: 'ETB', operatorCode: 'op-b' });
  const store = createMemoryStore();
  await store.upsertOperator(operator('op-a', `${a.url}/api/games/callback/op-a`));
  await store.upsertOperator(operator('op-b', `${b.url}/api/games/callback/op-b`));
  await store.addOperatorSecret('op-a', SECRET_A);
  await store.addOperatorSecret('op-b', SECRET_B);
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CODE: 'op-a',
    OPERATOR_CALLBACK_URL: `${a.url}/api/games/callback/op-a`,
    OPERATOR_HMAC_SECRET: SECRET_A,
  });
  return { a, b, store, registry: new OperatorRegistry({ store }), config };
}

test('handshake resolves the operator from the frame and stores the game', async (t) => {
  const { a, b, store, registry, config } = await setup();
  t.after(async () => { await a.close(); await b.close(); });
  const session = await handshake({ token: a.token, operatorCode: 'op-b', gameId: 'crash', config, store, registry });
  assert.equal(session.operatorCode, 'op-b');
  assert.equal(session.gameId, 'crash');
  assert.equal(session.displayBalance, 20_000n);
});

test('a token bound to one operator cannot be replayed under another', async (t) => {
  const { a, b, store, registry, config } = await setup();
  t.after(async () => { await a.close(); await b.close(); });
  await handshake({ token: a.token, operatorCode: 'op-a', config, store, registry });
  await assert.rejects(
    () => handshake({ token: a.token, operatorCode: 'op-b', config, store, registry }),
    (error: unknown) => error instanceof OperatorError && error.status === 403 && error.code === 'OPERATOR_MISMATCH',
  );
  assert.equal(b.state().calls.length, 0, 'operator B wallet must not be touched');
});

test('inactive, maintenance and disabled-game operators are rejected before the wallet call', async (t) => {
  const { a, b, store, registry, config } = await setup();
  t.after(async () => { await a.close(); await b.close(); });
  await store.upsertOperator(operator('op-a', `${a.url}/api/games/callback/op-a`, { status: 'SUSPENDED' }));
  await assert.rejects(() => handshake({ token: a.token, operatorCode: 'op-a', config, store, registry }),
    (e: unknown) => e instanceof OperatorError && e.code === 'OPERATOR_INACTIVE');
  await store.upsertOperator(operator('op-a', `${a.url}/api/games/callback/op-a`, { maintenance: true }));
  await assert.rejects(() => handshake({ token: a.token, operatorCode: 'op-a', config, store, registry }),
    (e: unknown) => e instanceof OperatorError && e.code === 'OPERATOR_MAINTENANCE');
  await store.upsertOperator(operator('op-a', `${a.url}/api/games/callback/op-a`, { enabledGames: ['coinflip'] }));
  await assert.rejects(() => handshake({ token: a.token, operatorCode: 'op-a', gameId: 'crash', config, store, registry }),
    (e: unknown) => e instanceof OperatorError && e.code === 'GAME_UNAVAILABLE');
  assert.equal(a.state().calls.length, 0);
});

test('effective limits intersect the signed reply with the operator record', async (t) => {
  const { a, b, store, registry, config } = await setup();
  t.after(async () => { await a.close(); await b.close(); });
  a.setLimits({ minStake: 50n, maxStake: 200_000n, maxWin: 5_000_000n });
  const session = await handshake({ token: a.token, operatorCode: 'op-a', config, store, registry });
  assert.deepEqual(
    [session.minStake, session.maxStake, session.maxWin],
    [100n, 100_000n, 3_000_000n],
  );
});

test('an empty limit intersection is a typed conflict', async (t) => {
  const { a, b, store, registry, config } = await setup();
  t.after(async () => { await a.close(); await b.close(); });
  a.setLimits({ minStake: 500_000n });
  await assert.rejects(
    () => handshake({ token: a.token, operatorCode: 'op-a', config, store, registry }),
    (error: unknown) => error instanceof OperatorError && error.status === 409 && error.code === 'LIMITS_CONFLICT',
  );
});

test('a closed session still answers SessionEndedError', async (t) => {
  const { a, b, store, registry, config } = await setup();
  t.after(async () => { await a.close(); await b.close(); });
  await handshake({ token: a.token, operatorCode: 'op-a', config, store, registry });
  await store.closeSession(a.token);
  await assert.rejects(
    () => handshake({ token: a.token, operatorCode: 'op-a', config, store, registry }),
    (error: unknown) => error instanceof SessionEndedError,
  );
});
