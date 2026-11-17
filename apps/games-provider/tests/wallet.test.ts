import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBingo } from '../src/test/fakeBingo';
import { HttpWalletClient, WalletError, verifyBalanceReply } from '../src/server/wallet';

const SECRET = 'test-hmac-secret-value';

async function clientFor(fake: Awaited<ReturnType<typeof createFakeBingo>>) {
  return new HttpWalletClient({ callbackUrl: `${fake.url}/api/games/callback/stratos`, hmacSecret: SECRET, timeoutMs: 500 });
}

test('handshake returns a verified balance with limits', async () => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 50_000n, currency: 'ETB' });
  const client = await clientFor(fake);
  const reply = await client.balance(fake.token, 'nonce-1');
  verifyBalanceReply(SECRET, fake.token, reply, Date.now());
  assert.equal(reply.balance, 50_000n);
  assert.equal(reply.minStake, 100n);
  assert.equal(reply.maxWin, 3_000_000n);
  await fake.close();
});

test('a tampered balance reply is rejected', async () => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 50_000n, currency: 'ETB' });
  const client = await clientFor(fake);
  const reply = await client.balance(fake.token, 'nonce-1');
  assert.throws(
    () => verifyBalanceReply(SECRET, fake.token, { ...reply, balance: 999_999n }, Date.now()),
    (error: unknown) => error instanceof WalletError && error.code === 'BALANCE_SIGNATURE_INVALID',
  );
  await fake.close();
});

test('bet rejection surfaces the bingo error code', async () => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 100n, currency: 'ETB' });
  const client = await clientFor(fake);
  await assert.rejects(
    client.bet({ sessionToken: fake.token, txnId: '11111111-1111-4111-8111-111111111111', amount: 500n, roundId: '1' }),
    (error: unknown) => error instanceof WalletError && error.code === 'INSUFFICIENT_FUNDS' && error.status === 409,
  );
  await fake.close();
});

test('a replayed bet is reported as replayed and does not double-debit', async () => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 10_000n, currency: 'ETB' });
  const client = await clientFor(fake);
  const input = { sessionToken: fake.token, txnId: '22222222-2222-4222-8222-222222222222', amount: 1000n, roundId: '1' };
  const first = await client.bet(input);
  const second = await client.bet(input);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(fake.state().balance, 9_000n);
  await fake.close();
});

test('rolling back an unapplied txnId surfaces a 404 NOT_FOUND WalletError', async () => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 10_000n, currency: 'ETB' });
  const client = await clientFor(fake);
  await assert.rejects(
    client.rollback({
      sessionToken: fake.token,
      txnId: '44444444-4444-4444-8444-444444444444',
      amount: 500n,
      roundId: '1',
    }),
    (error: unknown) =>
      error instanceof WalletError && error.status === 404 && error.code === 'NOT_FOUND',
  );
  assert.equal(fake.state().balance, 10_000n);
  await fake.close();
});

test('timeouts become a TIMEOUT WalletError', async () => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 10_000n, currency: 'ETB', betDelayMs: 200 });
  const client = new HttpWalletClient({ callbackUrl: `${fake.url}/api/games/callback/stratos`, hmacSecret: SECRET, timeoutMs: 30 });
  await assert.rejects(
    client.bet({ sessionToken: fake.token, txnId: '33333333-3333-4333-8333-333333333333', amount: 100n, roundId: '1' }),
    (error: unknown) => error instanceof WalletError && error.code === 'TIMEOUT' && error.status === null,
  );
  await fake.close();
});
