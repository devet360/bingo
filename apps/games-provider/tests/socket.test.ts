import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createFakeBingo } from '../src/test/fakeBingo';
import { createMemoryStore } from '../src/test/memoryStore';
import { HttpWalletClient } from '../src/server/wallet';
import { loadConfig } from '../src/config';
import { handshake } from '../src/server/handshake';
import { startTestServer } from '../src/test/server';
import { BETTING_WINDOW_MS } from '../src/server/roundEngine';

interface Frame { type: string; [key: string]: unknown }

function collector(ws: WebSocket) {
  const queue: Frame[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame;
    const index = waiters.findIndex((waiter) => waiter.match(frame));
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
    else queue.push(frame);
  });
  return {
    send: (frame: Frame) => ws.send(JSON.stringify(frame)),
    next(match: (frame: Frame) => boolean, timeoutMs = 2000): Promise<Frame> {
      const index = queue.findIndex(match);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs);
        waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
      });
    },
  };
}

async function setup() {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 10_000n, currency: 'ETB' });
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CALLBACK_URL: `${fake.url}/api/games/callback/stratos`,
    OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
  });
  const store = createMemoryStore();
  const wallet = new HttpWalletClient({ callbackUrl: config.operator.callbackUrl, hmacSecret: config.operator.hmacSecret });
  await handshake({ token: fake.token, config, store, wallet });
  const server = await startTestServer({ config, store, wallet });
  return { fake, store, ...server };
}

async function connect(url: string) {
  const ws = new WebSocket(url);
  const frames = collector(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, frames };
}

test('a client must auth before betting, and the snapshot hides the round outcome', async (t) => {
  const env = await setup();
  t.after(async () => { await env.close(); await env.fake.close(); });
  const { frames } = await connect(env.wsUrl);

  frames.send({ type: 'bet:place', panel: 0, stake: '1000' });
  const denied = await frames.next((frame) => frame.type === 'error');
  assert.equal(denied.code, 'NOT_AUTHED');

  frames.send({ type: 'auth', token: env.fake.token });
  const snapshot = await frames.next((frame) => frame.type === 'snapshot');
  assert.equal(snapshot.crashPoint, null);
  assert.equal(snapshot.serverSeed, null);
  assert.equal(snapshot.phase, 'BETTING');
});

test('placing, cancelling and cashing out confirm the bet and the balance', async (t) => {
  const env = await setup();
  t.after(async () => { await env.close(); await env.fake.close(); });
  const { frames } = await connect(env.wsUrl);
  frames.send({ type: 'auth', token: env.fake.token });
  await frames.next((frame) => frame.type === 'snapshot');

  await env.engine.tickOnce(0);
  const betting = await frames.next((frame) => frame.type === 'round:betting');
  assert.equal(typeof betting.roundId, 'number');

  frames.send({ type: 'bet:place', panel: 0, stake: '1000' });
  const placed = await frames.next((frame) => frame.type === 'bet:update' && frame.panel === 0);
  assert.equal(placed.status, 'ACTIVE');
  assert.equal(placed.stake, '1000');
  const balance = await frames.next((frame) => frame.type === 'balance:update');
  assert.equal(balance.balance, '9000');

  frames.send({ type: 'bet:place', panel: 1, stake: '500' });
  await frames.next((frame) => frame.type === 'bet:update' && frame.panel === 1 && frame.status === 'ACTIVE');
  frames.send({ type: 'bet:cancel', panel: 1 });
  const cancelled = await frames.next((frame) => frame.type === 'bet:update' && frame.panel === 1);
  assert.equal(cancelled.status, 'CANCELLED');

  await env.engine.tickOnce(BETTING_WINDOW_MS);
  const takeoff = await frames.next((frame) => frame.type === 'round:tick');
  assert.equal(takeoff.multiplier, 1);
  assert.equal(takeoff.elapsedMs, 0);

  frames.send({ type: 'bet:cashout', panel: 0 });
  const cashed = await frames.next((frame) => frame.type === 'bet:update' && frame.panel === 0);
  assert.equal(cashed.status, 'CASHED');
  assert.equal(cashed.payout, '1000');
});

test('authing a closed or unknown session ends the socket', async (t) => {
  const env = await setup();
  t.after(async () => { await env.close(); await env.fake.close(); });

  const unknown = await connect(env.wsUrl);
  unknown.frames.send({ type: 'auth', token: '11111111-1111-4111-8111-111111111111' });
  await unknown.frames.next((frame) => frame.type === 'session:ended');
  await new Promise<void>((resolve) => unknown.ws.once('close', () => resolve()));

  await env.store.closeSession(env.fake.token);
  const closed = await connect(env.wsUrl);
  closed.frames.send({ type: 'auth', token: env.fake.token });
  await closed.frames.next((frame) => frame.type === 'session:ended');
});

test('a bad frame is answered with BAD_FRAME and the socket keeps its auth', async (t) => {
  const env = await setup();
  t.after(async () => { await env.close(); await env.fake.close(); });
  const { frames } = await connect(env.wsUrl);
  frames.send({ type: 'auth', token: env.fake.token });
  await frames.next((frame) => frame.type === 'snapshot');

  frames.send({ type: 'bet:place', panel: 7, stake: '1000' });
  const bad = await frames.next((frame) => frame.type === 'error');
  assert.equal(bad.code, 'BAD_FRAME');

  // Still authed: the next valid frame reaches the engine (no round is open yet).
  frames.send({ type: 'bet:place', panel: 0, stake: '1000' });
  const rejected = await frames.next((frame) => frame.type === 'error');
  assert.equal(rejected.code, 'BET_REJECTED');
});
