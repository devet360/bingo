import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { seedBootstrapOperator } from '../src/server/bootstrap';
import { createMemoryStore } from '../src/test/memoryStore';

function config() {
  return loadConfig({
    DATABASE_URL: 'postgres://test',
    OPERATOR_CALLBACK_URL: 'https://legacy.example/games/callback/bingo251',
    OPERATOR_HMAC_SECRET: 'legacy-bootstrap-secret-for-tests',
    ALLOWED_PARENT_ORIGINS: 'https://legacy.example',
  });
}

test('bootstrap creates the configured operator when it is missing', async () => {
  const store = createMemoryStore();
  const bootstrap = config();

  await seedBootstrapOperator(store, bootstrap);

  const operator = await store.getOperator(bootstrap.operator.code);
  assert.equal(operator?.callbackUrl, bootstrap.operator.callbackUrl);
  assert.deepEqual(operator?.allowedOrigins, bootstrap.allowedParentOrigins);
  assert.equal((await store.listOperatorSecrets(bootstrap.operator.code))[0]?.secret, bootstrap.operator.hmacSecret);
});

test('bootstrap never overwrites an existing dashboard-managed operator', async () => {
  const store = createMemoryStore();
  const bootstrap = config();
  const managedCallback = 'https://bingo-api.example/games/callback/bingo251';
  await store.upsertOperator({
    code: bootstrap.operator.code,
    name: 'Dashboard-managed operator',
    callbackUrl: managedCallback,
    currency: 'ETB',
    status: 'SUSPENDED',
    allowedOrigins: ['https://bingo-web.example'],
    localeDefault: 'am',
    limits: bootstrap.limits,
    enabledGames: ['coinflip'],
    theme: null,
    botConfig: bootstrap.botConfig,
    maintenance: true,
    probeOkAt: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
  });

  await seedBootstrapOperator(store, bootstrap);

  const operator = await store.getOperator(bootstrap.operator.code);
  assert.equal(operator?.callbackUrl, managedCallback);
  assert.deepEqual(operator?.allowedOrigins, ['https://bingo-web.example']);
  assert.equal(operator?.status, 'SUSPENDED');
  assert.equal(operator?.maintenance, true);
  assert.equal((await store.listOperatorSecrets(bootstrap.operator.code)).length, 0);
});
