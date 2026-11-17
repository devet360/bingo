import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/http';
import { HttpWalletClient } from '../src/server/wallet';
import { createMemoryStore } from '../src/test/memoryStore';
import { loadConfig } from '../src/config';

const config = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  OPERATOR_CALLBACK_URL: 'https://bingo.example/api/games/callback/stratos',
  OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
});

test('health endpoint reports ok', async () => {
  const store = createMemoryStore();
  const wallet = new HttpWalletClient({
    callbackUrl: config.operator.callbackUrl,
    hmacSecret: config.operator.hmacSecret,
  });
  const server = createApp({ config, store, wallet }).listen(0);
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { status: 'ok', game: 'crash' } });
  server.close();
});

test('config forces bots off in v1', () => {
  assert.equal(config.botCount, 0);
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: 'postgres://x',
        OPERATOR_CALLBACK_URL: 'https://bingo.example/cb',
        OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
        BOT_COUNT: '5',
      }),
    /BOT_COUNT must be 0/,
  );
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
