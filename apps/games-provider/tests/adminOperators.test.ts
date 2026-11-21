import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMemoryStore } from '../src/test/memoryStore';
import { OperatorRegistry } from '../src/server/operatorRegistry';
import { createApp } from '../src/server/http';
import { loadConfig } from '../src/config';
import { createFakeBingo } from '../src/test/fakeBingo';

async function boot(adminToken: string | null, consoleTokenSecret?: string) {
  const store = createMemoryStore();
  const registry = new OperatorRegistry({ store });
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CALLBACK_URL: 'https://seed.example/cb',
    OPERATOR_HMAC_SECRET: 'seed-secret-for-tests',
    ...(consoleTokenSecret ? { CONSOLE_TOKEN_SECRET: consoleTokenSecret } : {}),
    ...(adminToken ? { PROVIDER_ADMIN_TOKEN: adminToken } : {}),
  });
  const server = createServer(createApp({ config, store, registry })).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, registry, config, base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const headers = (token = 'admin-token-for-tests') => ({ 'content-type': 'application/json', 'x-provider-admin-token': token });
const CONSOLE_TOKEN_SECRET = 'provider-console-secret-for-tests-32';

function consoleToken(role: 'provider_viewer' | 'operator_admin', operatorCode: string): string {
  const encoded = Buffer.from(JSON.stringify({
    type: 'provider_console',
    actorId: 'super-admin-test',
    role,
    operatorCode,
    exp: Math.floor(Date.now() / 1000) + 600,
  })).toString('base64url');
  const signature = createHmac('sha256', CONSOLE_TOKEN_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

test('owner console can persist runtime settings while a viewer cannot access them', async () => {
  const ctx = await boot(null, CONSOLE_TOKEN_SECRET);
  await ctx.store.upsertOperator({
    code: 'bingo251', name: 'Owner', callbackUrl: 'https://owner.example/cb', currency: 'ETB',
    status: 'ACTIVE', allowedOrigins: ['https://owner.example'], localeDefault: 'en',
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
    enabledGames: ['crash'], theme: null,
    botConfig: {
      enabled: false, count: 0, stakeMin: 100n, stakeMax: 10_000n,
      roundPayoutCap: 0n, dayPayoutCap: 0n, disclose: false,
    },
    maintenance: false, probeOkAt: null, createdAt: new Date(),
  });
  const ownerHeaders = {
    authorization: `Bearer ${consoleToken('operator_admin', 'bingo251')}`,
    'content-type': 'application/json',
  };
  const saved = await fetch(`${ctx.base}/api/admin/runtime-settings`, {
    method: 'PUT',
    headers: ownerHeaders,
    body: JSON.stringify({
      botConfig: {
        enabled: true, count: 3, stakeMin: '100', stakeMax: '1000',
        roundPayoutCap: '5000', dayPayoutCap: '25000', disclose: true,
      },
      enabledGames: ['crash', 'coinflip'],
    }),
  });
  assert.equal(saved.status, 200);
  const payload = await saved.json();
  assert.equal(payload.data.botConfig.count, 3);
  assert.deepEqual(payload.data.enabledGames, ['crash', 'coinflip']);
  const operator = await ctx.store.getOperator('bingo251');
  assert.equal(operator?.botConfig?.stakeMax, 1000n);
  assert.deepEqual(operator?.enabledGames, ['crash', 'coinflip']);

  const viewerResponse = await fetch(`${ctx.base}/api/admin/runtime-settings`, {
    headers: { authorization: `Bearer ${consoleToken('provider_viewer', 'bingo251')}` },
  });
  assert.equal(viewerResponse.status, 403);
  await ctx.close();
});

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

test('operator deletion requires suspension and refuses records with history', async () => {
  const ctx = await boot('admin-token-for-tests');
  await ctx.store.upsertOperator({
    code: 'delete-op', name: 'Delete', callbackUrl: 'https://delete.example/cb', currency: 'ETB',
    status: 'PENDING', allowedOrigins: ['https://delete.example'], localeDefault: 'en',
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
    enabledGames: ['crash'], theme: null, maintenance: false, probeOkAt: null, createdAt: new Date(),
  });
  const activeDelete = await fetch(`${ctx.base}/api/admin/operators/delete-op`, {
    method: 'DELETE', headers: headers(),
  });
  assert.equal(activeDelete.status, 409);
  assert.equal((await activeDelete.json()).error.code, 'SUSPEND_REQUIRED');

  await ctx.store.upsertOperator({
    ...(await ctx.store.getOperator('delete-op'))!,
    status: 'SUSPENDED',
  });
  const deleted = await fetch(`${ctx.base}/api/admin/operators/delete-op`, {
    method: 'DELETE', headers: headers(),
  });
  assert.equal(deleted.status, 200);
  assert.equal(await ctx.store.getOperator('delete-op'), null);

  await ctx.store.upsertOperator({
    code: 'history-op', name: 'History', callbackUrl: 'https://history.example/cb', currency: 'ETB',
    status: 'SUSPENDED', allowedOrigins: ['https://history.example'], localeDefault: 'en',
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
    enabledGames: ['crash'], theme: null, maintenance: false, probeOkAt: null, createdAt: new Date(),
  });
  await ctx.store.createRound({
    operatorCode: 'history-op',
    gameId: 'crash',
    serverSeed: 'private',
    serverSeedHash: 'public',
    startedAt: new Date(),
  });
  const refused = await fetch(`${ctx.base}/api/admin/operators/history-op`, {
    method: 'DELETE', headers: headers(),
  });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, 'OPERATOR_HAS_HISTORY');
  assert.equal((await ctx.store.getOperator('history-op'))?.status, 'SUSPENDED');
  await ctx.close();
});

test('provider dashboard reports live operational metrics without exposing game seeds', async () => {
  const ctx = await boot('admin-token-for-tests', CONSOLE_TOKEN_SECRET);
  const now = new Date();
  await ctx.store.upsertOperator({
    code: 'bingo251',
    name: 'Bingo 251',
    callbackUrl: 'https://bingo.example/games/callback/bingo251',
    currency: 'ETB',
    status: 'ACTIVE',
    allowedOrigins: ['https://bingo.example'],
    localeDefault: 'en',
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
    enabledGames: ['crash'],
    theme: null,
    maintenance: false,
    probeOkAt: now,
    createdAt: now,
  });
  await ctx.store.addOperatorSecret('bingo251', 'never-return-this-secret');
  await ctx.store.upsertOperator({
    code: 'other',
    name: 'Other Operator',
    callbackUrl: 'https://other.example/callback/other',
    currency: 'ETB',
    status: 'ACTIVE',
    allowedOrigins: ['https://other.example'],
    localeDefault: 'en',
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
    enabledGames: ['crash'],
    theme: null,
    maintenance: false,
    probeOkAt: now,
    createdAt: now,
  });
  const sessionToken = '9e4b7df8-1051-49ae-81ec-342205af8002';
  await ctx.store.saveSession({
    token: sessionToken,
    operatorCode: 'bingo251',
    gameId: 'crash',
    currency: 'ETB',
    minStake: 100n,
    maxStake: 100_000n,
    maxWin: 3_000_000n,
    maxBetsPerRound: 200,
    displayBalance: 10_000n,
    status: 'OPEN',
    createdAt: now,
    lastHandshakeAt: now,
  });
  const round = await ctx.store.createRound({
    operatorCode: 'bingo251',
    gameId: 'crash',
    serverSeed: 'private-seed',
    serverSeedHash: 'public-hash',
    startedAt: now,
  });
  await ctx.store.insertBet({
    roundId: round.id,
    operatorCode: 'bingo251',
    sessionToken,
    panel: 0,
    stake: 100n,
    autoCashout: null,
    status: 'ACTIVE',
    cashoutMultiplier: null,
    payout: null,
    betTxnId: '9e4b7df8-1051-49ae-81ec-342205af8003',
    winTxnId: null,
  });
  await ctx.store.enqueueOutbox({
    operatorCode: 'bingo251',
    type: 'WIN',
    txnId: '9e4b7df8-1051-49ae-81ec-342205af8004',
    sessionToken,
    amount: 200n,
  });

  const response = await fetch(`${ctx.base}/api/admin/dashboard`, { headers: headers() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.data.operators.map((operator: { code: string }) => operator.code),
    ['bingo251', 'other'],
  );
  assert.equal(body.data.metrics.sessions.active, 1);
  assert.equal(body.data.metrics.rounds.total, 1);
  assert.equal(body.data.metrics.bets.unsettled, 1);
  assert.equal(body.data.metrics.outbox.pending, 1);
  assert.equal(body.data.metrics.rounds.recent[0].serverSeed, undefined);
  assert.equal(JSON.stringify(body).includes('never-return-this-secret'), false);

  const scopedHeaders = { authorization: `Bearer ${consoleToken('provider_viewer', 'bingo251')}` };
  const scoped = await fetch(`${ctx.base}/api/admin/dashboard`, { headers: scopedHeaders });
  assert.deepEqual(
    (await scoped.json()).data.operators.map((operator: { code: string }) => operator.code),
    ['bingo251'],
  );
  const forbidden = await fetch(`${ctx.base}/api/admin/operators`, {
    method: 'POST',
    headers: { ...scopedHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'nope' }),
  });
  assert.equal(forbidden.status, 403);
  const scopedAdminHeaders = {
    authorization: `Bearer ${consoleToken('operator_admin', 'bingo251')}`,
    'content-type': 'application/json',
  };
  const cannotCreate = await fetch(`${ctx.base}/api/admin/operators`, {
    method: 'POST',
    headers: scopedAdminHeaders,
    body: JSON.stringify({ code: 'nope', name: 'Nope', callbackUrl: 'https://nope.example/cb', allowedOrigins: ['https://nope.example'] }),
  });
  assert.equal(cannotCreate.status, 403);
  const cannotDelete = await fetch(`${ctx.base}/api/admin/operators/bingo251`, {
    method: 'DELETE',
    headers: scopedAdminHeaders,
  });
  assert.equal(cannotDelete.status, 403);
  await ctx.close();
});
