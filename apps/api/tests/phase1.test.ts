import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  ProviderCallbackSchema,
  legacyProviderLedgerKey,
  providerLedgerKey,
  rollbackLedgerKey,
  signBalance,
  verifyCallbackSignature,
} from '../src/lib/providerCallback';
import { accountSuffixMatches } from '../src/lib/accountMatch';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

test('bet and win callbacks normalize numeric amounts to minor-unit strings', () => {
  const bet = ProviderCallbackSchema.parse({
    type: 'bet',
    sessionId: SESSION_ID,
    txnId: 'bet-1',
    amount: 2500,
  });
  assert.equal(bet.type, 'bet');
  assert.equal('amount' in bet && bet.amount, '2500');

  const win = ProviderCallbackSchema.parse({
    type: 'win',
    sessionId: SESSION_ID,
    txnId: 'win-1',
    amount: '900',
    currency: 'etb',
  });
  assert.equal('amount' in win && win.amount, '900');
});

test('movement callbacks reject non-positive or fractional amounts', () => {
  for (const amount of ['0', '-5', '1.5', '', 0, -3, 1.5]) {
    assert.equal(
      ProviderCallbackSchema.safeParse({
        type: 'bet',
        sessionId: SESSION_ID,
        txnId: 'bet-1',
        amount,
      }).success,
      false,
      `amount ${String(amount)} should be rejected`,
    );
  }
});

test('rollback and bet callbacks require a transaction id', () => {
  for (const type of ['bet', 'win', 'rollback'] as const) {
    assert.equal(
      ProviderCallbackSchema.safeParse({ type, sessionId: SESSION_ID, amount: '100' }).success,
      false,
    );
  }
});

test('balance callbacks carry only a session and optional nonce', () => {
  const parsed = ProviderCallbackSchema.parse({
    type: 'balance',
    sessionId: SESSION_ID,
    nonce: 'nonce-1',
  });
  assert.equal(parsed.type, 'balance');
  assert.equal('nonce' in parsed && parsed.nonce, 'nonce-1');
  assert.equal(ProviderCallbackSchema.safeParse({ type: 'unknown', sessionId: SESSION_ID }).success, false);
});

test('signature verification uses the exact raw bytes sent by the provider', () => {
  const secret = 'provider-shared-secret';
  const provider = { webhookSecret: secret, code: 'demo' };
  const body = Buffer.from(JSON.stringify({ type: 'bet', amount: '100' }));
  const signature = createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(verifyCallbackSignature(provider, body, signature), true);
  assert.equal(verifyCallbackSignature(provider, body, `sha256=${signature}`), true);
  assert.equal(verifyCallbackSignature(provider, Buffer.from('{}'), signature), false);
  assert.equal(
    verifyCallbackSignature({ webhookSecret: null, code: 'demo' }, body, signature),
    false,
  );
  assert.equal(verifyCallbackSignature(provider, body, undefined), false);
});

test('callback verification accepts the operator-scoped and the legacy signature', () => {
  const provider = { webhookSecret: 'secret-value', code: 'stratos', config: null };
  const body = Buffer.from('{"type":"balance"}');
  const legacy = createHmac('sha256', 'secret-value').update(body).digest('hex');
  const scoped = createHmac('sha256', 'secret-value')
    .update(Buffer.concat([Buffer.from('stratos.'), body]))
    .digest('hex');
  assert.equal(verifyCallbackSignature(provider, body, legacy), true);
  assert.equal(verifyCallbackSignature(provider, body, scoped), true);
  assert.equal(verifyCallbackSignature(provider, body, `sha256=${scoped}`), true);
  assert.equal(verifyCallbackSignature(provider, Buffer.from('{}'), scoped), false);
});

test('callback verification honors a previous secret during rotation', () => {
  const body = Buffer.from('{"type":"win"}');
  const oldScoped = createHmac('sha256', 'old-secret')
    .update(Buffer.concat([Buffer.from('stratos.'), body]))
    .digest('hex');
  const provider = {
    webhookSecret: 'new-secret',
    code: 'stratos',
    config: { previousWebhookSecret: 'old-secret' },
  };
  assert.equal(verifyCallbackSignature(provider, body, oldScoped), true);
});

test('signed balances bind amount, currency, timestamp and nonce', () => {
  const secret = 'provider-shared-secret';
  const base = {
    sessionId: SESSION_ID,
    currency: 'ETB',
    balance: 125_000n,
    timestamp: 1_700_000_000,
    nonce: 'nonce-1',
  };
  const signature = signBalance(secret, base);
  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.equal(signBalance(secret, { ...base }), signature);
  assert.notEqual(signBalance(secret, { ...base, nonce: 'nonce-2' }), signature);
  assert.notEqual(signBalance(secret, { ...base, balance: 1n }), signature);
});

test('ledger keys are namespaced by movement type', () => {
  assert.equal(providerLedgerKey('demo', 'bet', 'tx-1'), 'provider:demo:bet:tx-1');
  assert.equal(providerLedgerKey('demo', 'win', 'tx-1'), 'provider:demo:win:tx-1');
  assert.equal(legacyProviderLedgerKey('demo', 'tx-1'), 'provider:demo:tx-1');
  assert.equal(rollbackLedgerKey('demo', 'tx-1'), 'provider:demo:rollback:tx-1');
});

test('payout account suffixes match masked numbers', () => {
  assert.equal(accountSuffixMatches('1000123456789', '1000123456789'), true);
  assert.equal(accountSuffixMatches('****6789', '1000123456789'), true);
  assert.equal(accountSuffixMatches('****456789', '1000123456789'), true);
  assert.equal(accountSuffixMatches('****0000', '1000123456789'), false);
  assert.equal(accountSuffixMatches('789', '1000123456789'), undefined);
  assert.equal(accountSuffixMatches('', '1000123456789'), undefined);
  assert.equal(accountSuffixMatches('****6789', null), undefined);
});
