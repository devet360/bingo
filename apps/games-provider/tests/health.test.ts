import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/http';
import { OperatorRegistry } from '../src/server/operatorRegistry';
import { createMemoryStore } from '../src/test/memoryStore';
import { loadConfig } from '../src/config';

const config = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  OPERATOR_CODE: 'stratos',
  OPERATOR_CALLBACK_URL: 'https://bingo.example/api/games/callback/stratos',
  OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
});

test('health endpoint reports ok', async () => {
  const store = createMemoryStore();
  await store.upsertOperator({
    code: config.operator.code,
    name: config.operator.name,
    callbackUrl: config.operator.callbackUrl!,
    currency: config.operator.currency,
    status: 'ACTIVE',
    allowedOrigins: [],
    localeDefault: 'en',
    limits: config.limits,
    enabledGames: ['crash'],
    theme: null,
    maintenance: false,
    probeOkAt: null,
    createdAt: new Date('2026-11-19T00:00:00Z'),
  });
  await store.addOperatorSecret(config.operator.code, config.operator.hmacSecret!);
  const server = createApp({ config, store, registry: new OperatorRegistry({ store }) }).listen(0);
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { status: 'ok', game: 'crash' } });
  server.close();
});

test('bot count is configurable and defaults to off', () => {
  assert.equal(config.botCount, 0);
  const enabled = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CALLBACK_URL: 'https://bingo.example/cb',
    OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
    BOT_COUNT: '5',
  });
  assert.equal(enabled.botCount, 5);
  assert.equal(enabled.botConfig.enabled, true);
});

test('config parses minor-unit limit overrides', () => {
  const custom = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CALLBACK_URL: 'https://bingo.example/cb',
    OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
    GAME_MIN_STAKE: '50',
    GAME_MAX_STAKE: '25000',
    GAME_MAX_WIN: '500000',
  });
  assert.equal(custom.limits.minStake, 50n);
  assert.equal(custom.limits.maxStake, 25000n);
  assert.equal(custom.limits.maxWin, 500000n);
});
