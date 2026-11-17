import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createFakeBingo } from '../src/test/fakeBingo';
import { createMemoryStore } from '../src/test/memoryStore';
import { createApp } from '../src/server/http';
import { HttpWalletClient } from '../src/server/wallet';
import { loadConfig } from '../src/config';

async function boot(fake: Awaited<ReturnType<typeof createFakeBingo>>) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CALLBACK_URL: `${fake.url}/api/games/callback/stratos`,
    OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
  });
  const store = createMemoryStore();
  const wallet = new HttpWalletClient({ callbackUrl: config.operator.callbackUrl, hmacSecret: config.operator.hmacSecret });
  const server = createApp({ config, store, wallet }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, store };
}

test('handshake stores the session and returns signed limits', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 50_000n, currency: 'ETB' });
  const { server, base, store } = await boot(fake);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  });
  const response = await fetch(`${base}/api/sessions/handshake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: fake.token }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.balance, '50000');
  assert.equal(body.data.limits.minStake, '100');
  assert.equal(store.dump().sessions.length, 1);
});

test('a closed bingo session answers 410', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB', sessionOpen: false });
  const { server, base } = await boot(fake);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  });
  const response = await fetch(`${base}/api/sessions/handshake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: fake.token }),
  });
  assert.equal(response.status, 410);
});

test('proof is available only after the round crashed', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB' });
  const { server, base, store } = await boot(fake);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  });
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: new Date() });
  const flying = await fetch(`${base}/api/rounds/${round.id}/proof`);
  assert.equal(flying.status, 409);
  await store.startFlight(round.id, { crashPoint: 2.5, clientSeedComposite: 'a:b:c', at: new Date() });
  await store.finishRound(round.id, { status: 'CRASHED', at: new Date() });
  const ok = await fetch(`${base}/api/rounds/${round.id}/proof`);
  const obj = await ok.json();
  assert.equal(obj.data.serverSeed, 's');
  assert.equal(obj.data.crashPoint, 2.5);
});

test('closing a session is idempotent and flips the stored status', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB' });
  const { server, base, store } = await boot(fake);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  });
  await fetch(`${base}/api/sessions/handshake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: fake.token }),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${base}/api/sessions/close`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: fake.token }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { closed: true } });
  }
  assert.equal(store.dump().sessions[0]!.status, 'CLOSED');
});

test('proof answers 404 for an unknown round and 409 for an abandoned one', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB' });
  const { server, base, store } = await boot(fake);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  });
  const missing = await fetch(`${base}/api/rounds/999999/proof`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'ROUND_NOT_FOUND');
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: new Date() });
  await store.finishRound(round.id, { status: 'ABANDONED', at: new Date() });
  const abandoned = await fetch(`${base}/api/rounds/${round.id}/proof`);
  assert.equal(abandoned.status, 409);
  assert.equal((await abandoned.json()).error.code, 'ROUND_ABANDONED');
});

test('a 5xx wallet answers 502 instead of declaring the session dead', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB' });
  const { server, base } = await boot(fake);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  });
  fake.respondNextWith('{"error":{"code":"INTERNAL_ERROR","message":"boom"}}', { status: 500 });
  const response = await fetch(`${base}/api/sessions/handshake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: fake.token }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'WALLET_UNAVAILABLE');
});

test('a 2xx wallet reply without a signature answers 502 rather than declaring the session dead', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB' });
  const { server, base } = await boot(fake);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  });
  fake.respondNextWith('{"data":{"currency":"ETB","balance":"100","timestamp":1700000000}}');
  const response = await fetch(`${base}/api/sessions/handshake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: fake.token }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'WALLET_UNAVAILABLE');
});

test('a malformed handshake body answers 400 rather than 500', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB' });
  const { server, base } = await boot(fake);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  });
  const response = await fetch(`${base}/api/sessions/handshake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'not-a-uuid' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
});
