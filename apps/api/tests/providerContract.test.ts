import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildBalanceReply, buildLaunchUrl, isPlayableLaunchUrl, movementRequiresOpenSession, withBalance } from '../src/lib/providerContract';

test('launch url substitutes the real currency, not the legacy CREDIT literal', () => {
  const url = buildLaunchUrl('https://crash.example/play?token={token}&lang={lang}&currency={currency}', {
    token: 'f1f1f1f1-1111-4111-8111-111111111111',
    lang: 'am',
    currency: 'ETB',
  });
  assert.equal(
    url,
    'https://crash.example/play?token=f1f1f1f1-1111-4111-8111-111111111111&lang=am&currency=ETB',
  );
});

test('launch url substitutes the operator code when the template asks for it', () => {
  const ctx = { token: 't', lang: 'en', currency: 'ETB', operator: 'op-a' };
  assert.equal(
    buildLaunchUrl('https://crash.example/play?token={token}&operator={operator}', ctx),
    'https://crash.example/play?token=t&operator=op-a',
  );
  assert.equal(
    buildLaunchUrl('https://crash.example/play?token={token}', ctx),
    'https://crash.example/play?token=t',
  );
});

test('launch url is null without a template and encodes the token', () => {
  assert.equal(buildLaunchUrl(null, { token: 'a b', lang: 'en', currency: 'ETB' }), null);
  assert.equal(
    buildLaunchUrl('https://x/play?t={sessionId}', { token: 'a b', lang: 'en', currency: 'ETB' }),
    'https://x/play?t=a%20b',
  );
});

test('launch templates must be absolute http(s) URLs to be playable', () => {
  assert.equal(isPlayableLaunchUrl('https://crash.example/play?token={token}&lang={lang}'), true);
  assert.equal(isPlayableLaunchUrl('http://crash.example/play?token={token}'), true);
  assert.equal(isPlayableLaunchUrl('crash.example/play?token={token}'), false);
  assert.equal(isPlayableLaunchUrl('https://<crash-host>/play?token={token}'), false);
  assert.equal(isPlayableLaunchUrl('javascript:alert(1)'), false);
  assert.equal(isPlayableLaunchUrl(null), false);
});

test('balance reply signs the exact sessionId.currency.balance.timestamp.nonce string', () => {
  const reply = buildBalanceReply({
    secret: 'test-secret',
    sessionId: 's-1',
    currency: 'ETB',
    balance: 12345n,
    minStake: 100n,
    maxStake: 100000n,
    maxWin: 3000000n,
    timestamp: 1763400000,
    nonce: 'n-1',
  });
  const expected = createHmac('sha256', 'test-secret')
    .update('s-1.ETB.12345.1763400000.n-1')
    .digest('hex');
  assert.equal(reply.signature, expected);
  assert.equal(reply.balance, '12345');
  assert.equal(reply.minStake, '100');
  assert.equal(reply.maxStake, '100000');
  assert.equal(reply.maxWin, '3000000');
});

test('balance reply omits limits that are not configured', () => {
  const reply = buildBalanceReply({
    secret: 's',
    sessionId: 's-1',
    currency: 'ETB',
    balance: 0n,
    minStake: null,
    maxStake: null,
    maxWin: null,
    timestamp: 1,
    nonce: 'n',
  });
  assert.equal('minStake' in reply, false);
  assert.equal('maxWin' in reply, false);
});

test('withBalance appends the post-movement balance as a string', () => {
  assert.deepEqual(withBalance({ accepted: true, replayed: false }, 900n), {
    accepted: true,
    replayed: false,
    balance: '900',
  });
});

test('settlements do not require an open session but reads and debits do', () => {
  assert.equal(movementRequiresOpenSession('win'), false);
  assert.equal(movementRequiresOpenSession('rollback'), false);
  assert.equal(movementRequiresOpenSession('bet'), true);
  assert.equal(movementRequiresOpenSession('balance'), true);
});
