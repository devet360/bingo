import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMemoryStore } from '../src/test/memoryStore';
import { OperatorError, OperatorRegistry } from '../src/server/operatorRegistry';
import type { OperatorRecord } from '../src/domain/types';

const operator = (code: string): OperatorRecord => ({
  code, name: `Operator ${code}`, callbackUrl: `https://${code}.example/cb`,
  currency: 'ETB', status: 'ACTIVE', allowedOrigins: [], localeDefault: 'en',
  limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
  enabledGames: ['crash'], theme: null, maintenance: false, probeOkAt: null,
  createdAt: new Date('2026-11-19T00:00:00Z'),
});

async function seeded() {
  const store = createMemoryStore();
  await store.upsertOperator(operator('op-a'));
  await store.addOperatorSecret('op-a', 'secret-one');
  return { store, registry: new OperatorRegistry({ store }) };
}

const prefixed = (secret: string, code: string, raw: string) =>
  createHmac('sha256', secret).update(`${code}.${raw}`).digest('hex');

test('outbound signing uses the operator domain and the newest active secret', async () => {
  const { registry } = await seeded();
  const rotated = await registry.rotateSecret('op-a');
  assert.deepEqual(
    [rotated.version, await registry.signOutbound('op-a', '{"type":"win"}')],
    [2, prefixed(rotated.secret, 'op-a', '{"type":"win"}')],
  );
});

test('inbound verification accepts both active secrets during the overlap only', async () => {
  const { registry, store } = await seeded();
  const rotated = await registry.rotateSecret('op-a');
  assert.equal(await registry.verifyInbound('op-a', Buffer.from('raw'), prefixed('secret-one', 'op-a', 'raw')), true);
  assert.equal(await registry.verifyInbound('op-a', Buffer.from('raw'), prefixed(rotated.secret, 'op-a', 'raw')), true);
  // Third rotation retires v1 (oldest active) and leaves v2+v3 active.
  await registry.rotateSecret('op-a');
  const active = (await store.listOperatorSecrets('op-a')).filter((s) => s.retiredAt === null);
  assert.deepEqual(active.map((s) => s.version).sort(), [2, 3]);
  assert.equal(await registry.verifyInbound('op-a', Buffer.from('raw'), prefixed('secret-one', 'op-a', 'raw')), false);
});

test('the V1 bare-body signature is still accepted', async () => {
  const { registry } = await seeded();
  const legacy = createHmac('sha256', 'secret-one').update('raw').digest('hex');
  assert.equal(await registry.verifyInbound('op-a', Buffer.from('raw'), legacy), true);
});

test('walletFor scopes the signature to the operator', async () => {
  const { registry } = await seeded();
  const sent: { url: string; signature: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), signature: String(init?.headers && (init.headers as Record<string, string>)['x-provider-signature']), body: String(init?.body) });
    return new Response(JSON.stringify({ data: { accepted: true, replayed: false, balance: '500' } }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const wallet = await registry.walletFor('op-a', fetchImpl);
  await wallet.win({ sessionToken: 's', txnId: 't', amount: 100n, roundId: '1' });
  const call = sent[0]!;
  assert.equal(call.url, 'https://op-a.example/cb');
  assert.equal(call.signature, prefixed('secret-one', 'op-a', call.body));
});

test('unknown operators, missing secrets and currency-free lookups are typed errors', async () => {
  const { store } = await seeded();
  const registry = new OperatorRegistry({ store });
  await assert.rejects(() => registry.get('missing'), (e: unknown) => e instanceof OperatorError && e.status === 404 && e.code === 'OPERATOR_NOT_FOUND');
  await store.upsertOperator(operator('op-b'));
  await assert.rejects(() => registry.walletFor('op-b'), (e: unknown) => e instanceof OperatorError && e.code === 'OPERATOR_SECRET_MISSING');
});

test('rotateSecret retries the insert once when a concurrent rotation wins the version', async () => {
  const store = createMemoryStore();
  await store.upsertOperator(operator('op-a'));
  const add = store.addOperatorSecret.bind(store);
  let calls = 0;
  const racingStore = {
    ...store,
    async addOperatorSecret(code: string, secret: string) {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      return add(code, secret);
    },
  };
  const registry = new OperatorRegistry({ store: racingStore });
  const rotated = await registry.rotateSecret('op-a');
  assert.equal(calls, 2);
  assert.equal(rotated.version, 1);
  assert.equal((await store.listOperatorSecrets('op-a')).length, 1);
});
