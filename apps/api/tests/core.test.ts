import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBps, splitWithdrawalFee } from '../src/lib/money';
import { numericCode, referralCode } from '../src/lib/ids';
import { hashPassword, verifyPassword } from '../src/lib/crypto';

test('commission rounds down and never over-pays', () => {
  assert.equal(calculateBps(100_000n, 300), 3_000n);
  assert.equal(calculateBps(333n, 300), 9n); // 9.99 -> 9
  assert.equal(calculateBps(0n, 500), 0n);
});

test('rejects out-of-range bps', () => {
  assert.throws(() => calculateBps(100n, -1));
  assert.throws(() => calculateBps(100n, 10_001));
  assert.throws(() => calculateBps(100n, 1.5));
});

test('withdrawal fee splits preserve the gross amount', () => {
  const { fee, net } = splitWithdrawalFee(100_000n, 200);
  assert.equal(fee, 2_000n);
  assert.equal(net, 98_000n);
  assert.equal(fee + net, 100_000n);
});

test('generated codes are zero-padded six-digit strings', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = numericCode(6);
    assert.match(code, /^\d{6}$/);
  }
});

test('referral codes avoid ambiguous characters', () => {
  for (let i = 0; i < 50; i += 1) {
    assert.match(referralCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  }
});

test('password hashes verify and reject wrong secrets', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('verifyPassword tolerates malformed stored hashes', async () => {
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
});
