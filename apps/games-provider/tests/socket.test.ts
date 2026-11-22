import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createFakeBingo } from '../src/test/fakeBingo';
import { createMemoryStore } from '../src/test/memoryStore';
import { OperatorRegistry } from '../src/server/operatorRegistry';
import { loadConfig } from '../src/config';
import { handshake } from '../src/server/handshake';
import { startTestServer } from '../src/test/server';
import { BETTING_WINDOW_MS } from '../src/server/roundEngine';

const OPERATOR_CODE = 'stratos';
const HMAC_SECRET = 'test-hmac-secret-value';

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
  const fake = await createFakeBingo({
    hmacSecret: HMAC_SECRET, balance: 10_000n, currency: 'ETB', operatorCode: OPERATOR_CODE,
  });
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CODE,
    OPERATOR_CALLBACK_URL: `${fake.url}/api/games/callback/${OPERATOR_CODE}`,
    OPERATOR_HMAC_SECRET: HMAC_SECRET,
  });
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
  await store.addOperatorSecret(config.operator.code, HMAC_SECRET);
  const registry = new OperatorRegistry({ store });
  await handshake({ token: fake.token, config, store, registry });
  const server = await startTestServer({ config, store, registry });
  return { fake, ...server };
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

test('a session of a suspended operator is refused at auth and on the next action', async (t) => {
  const env = await setup();
  t.after(async () => { await env.close(); await env.fake.close(); });
  const operator = await env.store.getOperator(OPERATOR_CODE);
  assert.ok(operator);

  await env.store.upsertOperator({ ...operator, status: 'SUSPENDED' });
  const refused = await connect(env.wsUrl);
  refused.frames.send({ type: 'auth', token: env.fake.token });
  const ended = await refused.frames.next((frame) => frame.type === 'session:ended');
  assert.equal(ended.reason, 'OPERATOR_INACTIVE');
  await new Promise<void>((resolve) => refused.ws.once('close', () => resolve()));

  await env.store.upsertOperator(operator);
  const live = await connect(env.wsUrl);
  live.frames.send({ type: 'auth', token: env.fake.token });
  await live.frames.next((frame) => frame.type === 'snapshot');

  // Suspension reaches sockets that were already authenticated.
  await env.store.upsertOperator({ ...operator, maintenance: true });
  live.frames.send({ type: 'bet:place', panel: 0, stake: '1000' });
  const endedLive = await live.frames.next((frame) => frame.type === 'session:ended');
  assert.equal(endedLive.reason, 'OPERATOR_INACTIVE');
  await new Promise<void>((resolve) => live.ws.once('close', () => resolve()));
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

  // "0" and "000" are decimal strings but not positive stakes.
  frames.send({ type: 'bet:place', panel: 0, stake: '0' });
  const zero = await frames.next((frame) => frame.type === 'error');
  assert.equal(zero.code, 'BAD_FRAME');

  // Still authed: the next valid frame reaches the engine (no round is open yet).
  frames.send({ type: 'bet:place', panel: 0, stake: '1000' });
  const rejected = await frames.next((frame) => frame.type === 'error');
  assert.equal(rejected.code, 'BET_REJECTED');
});

test('an oversized frame kills only its socket, not the provider process', async (t) => {
  const env = await setup();
  t.after(async () => { await env.close(); await env.fake.close(); });

  // maxPayload (64 KiB) makes `ws` emit 'error' on this socket pre-auth; without
  // the error listener that EventEmitter throw would end the provider process.
  const hostile = new WebSocket(env.wsUrl);
  hostile.on('error', () => { /* the server-side violation is expected here */ });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hostile socket never opened')), 5000);
    hostile.once('open', () => { clearTimeout(timer); resolve(); });
  });
  hostile.send(JSON.stringify({ type: 'auth', token: 'x'.repeat(70 * 1024) }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hostile socket never closed')), 5000);
    hostile.once('close', () => { clearTimeout(timer); resolve(); });
  });

  // A fresh client still gets served: the process survived the bad frame.
  const { frames } = await connect(env.wsUrl);
  frames.send({ type: 'auth', token: env.fake.token });
  const snapshot = await frames.next((frame) => frame.type === 'snapshot');
  assert.equal(snapshot.type, 'snapshot');
});

const OTHER_TOKEN = '22222222-2222-4222-8222-222222222222';

async function openSecondSession(store: Awaited<ReturnType<typeof setup>>['store']) {
  await store.saveSession({
    token: OTHER_TOKEN, operatorCode: OPERATOR_CODE, currency: 'ETB',
    gameId: 'crash', minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n,
    maxBetsPerRound: 200, displayBalance: 5_000n,
    status: 'OPEN', createdAt: new Date(0), lastHandshakeAt: new Date(0),
  });
}

test('notifyBet and notifyBalance address only the target session', async (t) => {
  const env = await setup();
  t.after(async () => { await env.close(); await env.fake.close(); });
  await openSecondSession(env.store);

  const a = await connect(env.wsUrl);
  a.frames.send({ type: 'auth', token: env.fake.token });
  await a.frames.next((frame) => frame.type === 'snapshot');
  const b = await connect(env.wsUrl);
  b.frames.send({ type: 'auth', token: OTHER_TOKEN });
  await b.frames.next((frame) => frame.type === 'snapshot');

  env.socket.notifyBet({
    id: 'bet-a', roundId: 7, operatorCode: OPERATOR_CODE, sessionToken: env.fake.token, panel: 1,
    stake: 1_000n, autoCashout: 1.5, status: 'CASHED', cashoutMultiplier: 2, payout: 2_000n,
    betTxnId: 'bet-txn', winTxnId: 'win-txn', createdAt: new Date(0), settledAt: new Date(0),
  });
  env.socket.notifyBalance(OTHER_TOKEN, 123n);

  const update = await a.frames.next((frame) => frame.type === 'bet:update');
  assert.equal(update.panel, 1);
  assert.equal(update.status, 'CASHED');
  assert.equal(update.stake, '1000');
  assert.equal(update.payout, '2000');
  const balance = await b.frames.next((frame) => frame.type === 'balance:update');
  assert.equal(balance.balance, '123');

  // The two pushes never cross sessions.
  await assert.rejects(a.frames.next((frame) => frame.type === 'balance:update', 150), /timed out/);
  await assert.rejects(b.frames.next((frame) => frame.type === 'bet:update', 150), /timed out/);
});

test('a reconnect snapshot carries the session own bets for the live round', async (t) => {
  const env = await setup();
  t.after(async () => { await env.close(); await env.fake.close(); });

  const first = await connect(env.wsUrl);
  first.frames.send({ type: 'auth', token: env.fake.token });
  await first.frames.next((frame) => frame.type === 'snapshot');
  await env.engine.tickOnce(0);
  await first.frames.next((frame) => frame.type === 'round:betting');
  first.frames.send({ type: 'bet:place', panel: 1, stake: '1000' });
  await first.frames.next((frame) => frame.type === 'bet:update' && frame.panel === 1 && frame.status === 'ACTIVE');
  first.ws.close();

  const second = await connect(env.wsUrl);
  second.frames.send({ type: 'auth', token: env.fake.token });
  const snapshot = await second.frames.next((frame) => frame.type === 'snapshot');
  const bets = snapshot.bets as Array<Record<string, unknown> | null>;
  assert.equal(typeof snapshot.roundId, 'number');
  assert.equal(bets.length, 2);
  assert.equal(bets[0], null);
  assert.equal(bets[1]!.panel, 1);
  assert.equal(bets[1]!.status, 'ACTIVE');
  assert.equal(bets[1]!.stake, '1000');

  // A session with no bet in the round still gets the two null slots.
  await openSecondSession(env.store);
  const fresh = await connect(env.wsUrl);
  fresh.frames.send({ type: 'auth', token: OTHER_TOKEN });
  const other = await fresh.frames.next((frame) => frame.type === 'snapshot');
  assert.deepEqual(other.bets, [null, null]);
});
