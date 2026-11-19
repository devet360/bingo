import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMemoryStore } from '../src/test/memoryStore';
import { OperatorRegistry } from '../src/server/operatorRegistry';
import { createApp } from '../src/server/http';
import { loadConfig } from '../src/config';
import { createFakeBingo } from '../src/test/fakeBingo';

async function boot(adminToken: string | null) {
  const store = createMemoryStore();
  const registry = new OperatorRegistry({ store });
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CALLBACK_URL: 'https://seed.example/cb',
    OPERATOR_HMAC_SECRET: 'seed-secret-for-tests',
    ...(adminToken ? { PROVIDER_ADMIN_TOKEN: adminToken } : {}),
  });
  const server = createServer(createApp({ config, store, registry })).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, registry, config, base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const headers = (token = 'admin-token-for-tests') => ({ 'content-type': 'application/json', 'x-provider-admin-token': token });

test('admin routes are disabled without a token and reject a wrong one', async () => {
  const disabled = await boot(null);
  assert.equal((await fetch(`${disabled.base}/api/admin/operators`, { headers: headers() })).status, 503);
  await disabled.close();

  const enabled = await boot('admin-token-for-tests');
  assert.equal((await fetch(`${enabled.base}/api/admin/operators`, { headers: headers('wrong-token-value') })).status, 401);
  await enabled.close();
});

test('creating an operator returns its first secret once and starts PENDING', async () => {
  const ctx = await boot('admin-token-for-tests');
  const response = await fetch(`${ctx.base}/api/admin/operators`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      code: 'new-op', name: 'New Operator', callbackUrl: 'https://new.example/api/games/callback/new-op',
      allowedOrigins: ['https://new.example'],
      limits: { minStake: '100', maxStake: '50000', maxWin: '1000000', maxBetsPerRound: 50 },
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.operator.status, 'PENDING');
  assert.match(body.data.secret, /^[0-9a-f]{64}$/);
  const list = await (await fetch(`${ctx.base}/api/admin/operators`, { headers: headers() })).json();
  assert.equal(list.data[0].hasSecret, true);
  assert.equal('secret' in list.data[0], false);
  await ctx.close();
});

test('activation requires a successful probe', async () => {
  const fake = await createFakeBingo({ hmacSecret: 'probe-secret', balance: 0n, operatorCode: 'probe-op' });
  const ctx = await boot('admin-token-for-tests');
  await ctx.store.upsertOperator({
    code: 'probe-op', name: 'Probe', callbackUrl: `${fake.url}/api/games/callback/probe-op`, currency: 'ETB',
    status: 'PENDING', allowedOrigins: ['https://probe.example'], localeDefault: 'en',
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
    enabledGames: ['crash'], theme: null, maintenance: false, probeOkAt: null,
    createdAt: new Date('2026-11-19T00:00:00Z'),
  });
  await ctx.store.addOperatorSecret('probe-op', 'probe-secret');
  const denied = await fetch(`${ctx.base}/api/admin/operators/probe-op/status`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ status: 'ACTIVE' }),
  });
  assert.equal(denied.status, 409);

  const probe = await fetch(`${ctx.base}/api/admin/operators/probe-op/probe`, { method: 'POST', headers: headers() });
  assert.equal(probe.status, 200);
  assert.deepEqual(fake.state().calls.at(-1)?.type, 'probe');

  const activated = await fetch(`${ctx.base}/api/admin/operators/probe-op/status`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ status: 'ACTIVE' }),
  });
  assert.equal(activated.status, 200);
  await ctx.close();
  await fake.close();
});

test('updating round-trips lifecycle fields and rotation returns a new secret once', async () => {
  const ctx = await boot('admin-token-for-tests');
  const created = await (
    await fetch(`${ctx.base}/api/admin/operators`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        code: 'patch-op', name: 'Patch', callbackUrl: 'https://patch.example/cb',
        allowedOrigins: ['https://patch.example'],
        limits: { minStake: '100', maxStake: '2000', maxWin: '9000', maxBetsPerRound: 10 },
      }),
    })
  ).json();
  const createdAt = created.data.operator.createdAt;

  const patched = await fetch(`${ctx.base}/api/admin/operators/patch-op`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ name: 'Patched', limits: { minStake: '200', maxStake: '3000', maxWin: '15000', maxBetsPerRound: 20 } }),
  });
  assert.equal(patched.status, 200);
  const body = await patched.json();
  assert.equal(body.data.name, 'Patched');
  assert.equal(body.data.createdAt, createdAt);
  assert.equal(body.data.status, 'PENDING');
  assert.equal(body.data.probeOkAt, null);
  assert.equal(body.data.limits.minStake, '200');
  assert.equal(body.data.limits.maxStake, '3000');

  const badOrigin = await fetch(`${ctx.base}/api/admin/operators/patch-op`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify({ allowedOrigins: ['javascript:alert(1)'] }),
  });
  assert.equal(badOrigin.status, 400);

  const rotated = await fetch(`${ctx.base}/api/admin/operators/patch-op/secrets`, { method: 'POST', headers: headers() });
  assert.equal(rotated.status, 201);
  const rotatedBody = await rotated.json();
  assert.match(rotatedBody.data.secret, /^[0-9a-f]{64}$/);
  assert.equal(rotatedBody.data.secretVersion, 2);
  assert.equal(rotatedBody.data.operator.hasSecret, true);
  assert.equal('secret' in rotatedBody.data.operator, false);
  await ctx.close();
});
