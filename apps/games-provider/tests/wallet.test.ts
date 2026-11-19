import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createFakeBingo, type FakeBingo } from '../src/test/fakeBingo';
import {
  balanceSignatureInput,
  HttpWalletClient,
  WalletError,
  verifyBalanceReply,
  type BalanceReply,
} from '../src/server/wallet';

const SECRET = 'test-hmac-secret-value';

function clientFor(fake: FakeBingo, timeoutMs = 500) {
  return new HttpWalletClient({ callbackUrl: `${fake.url}/api/games/callback/stratos`, hmacSecret: SECRET, timeoutMs });
}

/** Matches a WalletError with `code`; pass `status` to pin it (null = transport failure). */
function assertWalletError(code: string, status?: number | null) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof WalletError, `expected a WalletError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

test('handshake returns a verified balance with limits', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 50_000n, currency: 'ETB' });
  t.after(() => fake.close());
  const reply = await clientFor(fake).balance(fake.token, 'nonce-1');
  verifyBalanceReply(SECRET, fake.token, reply, Date.now());
  assert.equal(reply.balance, 50_000n);
  assert.equal(reply.balanceRaw, '50000');
  assert.equal(reply.currency, 'ETB');
  assert.equal(reply.minStake, 100n);
  assert.equal(reply.maxWin, 3_000_000n);
});

test('a tampered balance reply is rejected', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 50_000n, currency: 'ETB' });
  t.after(() => fake.close());
  const reply = await clientFor(fake).balance(fake.token, 'nonce-1');
  assert.throws(
    () => verifyBalanceReply(SECRET, fake.token, { ...reply, balance: 999_999n }, Date.now()),
    assertWalletError('BALANCE_SIGNATURE_INVALID', 502),
  );
});

test('bet rejection surfaces the bingo error code', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 100n, currency: 'ETB' });
  t.after(() => fake.close());
  await assert.rejects(
    clientFor(fake).bet({
      sessionToken: fake.token,
      txnId: '11111111-1111-4111-8111-111111111111',
      amount: 500n,
      roundId: '1',
    }),
    assertWalletError('INSUFFICIENT_FUNDS', 409),
  );
});

test('a replayed bet answers 200 after the 201 first bet and does not double-debit', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 10_000n, currency: 'ETB' });
  t.after(() => fake.close());
  const client = clientFor(fake);
  const input = { sessionToken: fake.token, txnId: '22222222-2222-4222-8222-222222222222', amount: 1000n, roundId: '1' };
  const first = await client.bet(input);
  const second = await client.bet(input);
  assert.equal(first.replayed, false);
  assert.equal(first.balance, 9_000n);
  assert.equal(second.replayed, true);
  assert.equal(fake.state().balance, 9_000n);
  // The movement status contract: applied first (201), replayed after (200).
  assert.deepEqual(
    fake.state().calls.filter((call) => call.type === 'bet').map((call) => call.status),
    [201, 200],
  );
});

test('rolling back an unapplied txnId surfaces a 404 NOT_FOUND WalletError', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 10_000n, currency: 'ETB' });
  t.after(() => fake.close());
  await assert.rejects(
    clientFor(fake).rollback({
      sessionToken: fake.token,
      txnId: '44444444-4444-4444-8444-444444444444',
      amount: 500n,
      roundId: '1',
    }),
    assertWalletError('NOT_FOUND', 404),
  );
  assert.equal(fake.state().balance, 10_000n);
});

test('timeouts become a TIMEOUT WalletError and leave the balance untouched', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 10_000n, currency: 'ETB', betDelayMs: 150 });
  t.after(() => fake.close());
  await assert.rejects(
    clientFor(fake, 40).bet({
      sessionToken: fake.token,
      txnId: '33333333-3333-4333-8333-333333333333',
      amount: 100n,
      roundId: '1',
    }),
    assertWalletError('TIMEOUT', null),
  );
  // Let the delayed handler wake up: an aborted request must not be applied.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fake.state().balance, 10_000n);
  assert.deepEqual(fake.state().applied, []);
});

test('balanceSignatureInput keeps the documented field order', () => {
  assert.equal(
    balanceSignatureInput({
      sessionId: 'session',
      currency: 'ETB',
      balance: '50000',
      timestamp: 1_700_000_000,
      nonce: 'nonce-1',
    }),
    'session.ETB.50000.1700000000.nonce-1',
  );
});

test('verifyBalanceReply rejects short and non-hex signatures before comparing', () => {
  const reply: BalanceReply = {
    currency: 'ETB',
    balance: 50_000n,
    balanceRaw: '50000',
    timestamp: 1_700_000_000,
    nonce: 'nonce-1',
    signature: 'zz',
    minStake: null,
    maxStake: null,
    maxWin: null,
  };
  const nowMs = reply.timestamp * 1000;
  // 'zz' is too short; 'z' * 64 is the right length but not hex; 63 chars is short.
  for (const signature of ['zz', 'z'.repeat(64), 'a'.repeat(63), '']) {
    assert.throws(
      () => verifyBalanceReply(SECRET, 'session', { ...reply, signature }, nowMs),
      assertWalletError('BALANCE_SIGNATURE_INVALID', 502),
      `signature ${JSON.stringify(signature)} should be rejected`,
    );
  }
});

test('verifyBalanceReply rejects a non-finite timestamp even when it is signed', () => {
  const sessionId = 'session';
  const nonce = 'nonce-1';
  const timestamp = Number.NaN;
  // The signature legitimately covers the literal "NaN"; the skew check must not
  // use `Math.abs(now - NaN) > skewMs`, which is false and would fail open.
  const signature = createHmac('sha256', SECRET)
    .update(`${sessionId}.ETB.50000.${timestamp}.${nonce}`)
    .digest('hex');
  assert.throws(
    () =>
      verifyBalanceReply(
        SECRET,
        sessionId,
        {
          currency: 'ETB',
          balance: 50_000n,
          balanceRaw: '50000',
          timestamp,
          nonce,
          signature,
          minStake: null,
          maxStake: null,
          maxWin: null,
        },
        Date.now(),
      ),
    assertWalletError('BALANCE_STALE', 502),
  );
});

test('a 2xx balance reply with a malformed or empty body surfaces WALLET_RESPONSE_INVALID', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 50_000n, currency: 'ETB' });
  t.after(() => fake.close());
  const client = clientFor(fake);
  for (const body of ['', '{not json', '[]', 'null']) {
    fake.respondNextWith(body);
    await assert.rejects(
      client.balance(fake.token, 'nonce-1'),
      assertWalletError('WALLET_RESPONSE_INVALID', 200),
      `body ${JSON.stringify(body)} should be rejected`,
    );
  }
  assert.equal(fake.state().balance, 50_000n);
});

test('a 2xx balance reply with missing or non-numeric fields surfaces WALLET_RESPONSE_INVALID', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 50_000n, currency: 'ETB' });
  t.after(() => fake.close());
  const client = clientFor(fake);
  const good = {
    currency: 'ETB',
    balance: '50000',
    timestamp: 1_700_000_000,
    nonce: 'nonce-1',
    signature: 'a'.repeat(64),
    minStake: '100',
    maxStake: '100000',
    maxWin: '3000000',
  };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['balance', { ...good, balance: 'nope' }],
    ['balance', { ...good, balance: undefined }],
    ['timestamp', { ...good, timestamp: 'oops' }],
    ['timestamp', { ...good, timestamp: undefined }],
    ['currency', { ...good, currency: undefined }],
    ['minStake', { ...good, minStake: 'free' }],
    ['nonce', { ...good, nonce: 42 }],
  ];
  for (const [field, data] of cases) {
    fake.respondNextWith(JSON.stringify({ data }));
    await assert.rejects(client.balance(fake.token, 'nonce-1'), (error: unknown) => {
      assertWalletError('WALLET_RESPONSE_INVALID', 200)(error);
      assert.match((error as WalletError).message, new RegExp(field));
      return true;
    });
  }
});

test('a 2xx balance reply with no signature surfaces BALANCE_SIGNATURE_INVALID', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 50_000n, currency: 'ETB' });
  t.after(() => fake.close());
  fake.respondNextWith(
    JSON.stringify({
      data: { currency: 'ETB', balance: '50000', timestamp: 1_700_000_000, nonce: 'nonce-1' },
    }),
  );
  await assert.rejects(
    clientFor(fake).balance(fake.token, 'nonce-1'),
    assertWalletError('BALANCE_SIGNATURE_INVALID', 200),
  );
});

test('a 2xx movement reply with a non-numeric balance surfaces WALLET_RESPONSE_INVALID', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 10_000n, currency: 'ETB' });
  t.after(() => fake.close());
  fake.respondNextWith(JSON.stringify({ data: { accepted: true, replayed: false, balance: 'lots' } }));
  await assert.rejects(
    clientFor(fake).bet({
      sessionToken: fake.token,
      txnId: '55555555-5555-4555-8555-555555555555',
      amount: 100n,
      roundId: '1',
    }),
    assertWalletError('WALLET_RESPONSE_INVALID', 200),
  );
});

test('an unparseable non-2xx body surfaces WALLET_HTTP_ERROR with the status', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 10_000n, currency: 'ETB' });
  t.after(() => fake.close());
  fake.respondNextWith('<html>bad gateway</html>', { status: 502, contentType: 'text/html' });
  await assert.rejects(
    clientFor(fake).bet({
      sessionToken: fake.token,
      txnId: '66666666-6666-4666-8666-666666666666',
      amount: 100n,
      roundId: '1',
    }),
    assertWalletError('WALLET_HTTP_ERROR', 502),
  );
  assert.equal(fake.state().balance, 10_000n);
});

test('operator-scoped signatures verify while the bare V1 form stays accepted', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 10_000n, operatorCode: 'op-a' });
  t.after(() => fake.close());
  const callbackUrl = `${fake.url}/api/games/callback/op-a`;
  const scoped = new HttpWalletClient({ callbackUrl, hmacSecret: SECRET, operatorCode: 'op-a' });
  const legacy = new HttpWalletClient({ callbackUrl, hmacSecret: SECRET });
  const base = { sessionToken: fake.token, amount: 100n, roundId: '1' };
  assert.equal((await scoped.bet({ ...base, txnId: '77777777-7777-4777-8777-777777777777' })).accepted, true);
  assert.equal((await legacy.bet({ ...base, txnId: '88888888-8888-4888-8888-888888888888' })).accepted, true);
  const wrongOperator = new HttpWalletClient({ callbackUrl, hmacSecret: SECRET, operatorCode: 'op-b' });
  await assert.rejects(
    wrongOperator.bet({ ...base, txnId: '99999999-9999-4999-8999-999999999999' }),
    assertWalletError('SIGNATURE_INVALID', 403),
  );
});
