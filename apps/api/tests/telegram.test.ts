import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyTelegramInitData } from '../src/services/telegram';
import { AppError } from '../src/lib/errors';

const BOT_TOKEN = '123456:TEST-token-for-unit-tests';

function sign(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const checkString = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(checkString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function baseFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    query_id: 'AAHdF6IQAAAAAN0Xoha9',
    user: JSON.stringify({ id: 123456789, first_name: 'Ada', username: 'ada' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
    ...overrides,
  };
}

function expectAppError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AppError, 'expected AppError');
    assert.equal(error.code, code);
    return true;
  });
}

test('accepts a correctly signed initData payload', () => {
  const verified = verifyTelegramInitData(sign(baseFields()), BOT_TOKEN, 300);
  assert.equal(verified.user.id, 123456789);
  assert.equal(verified.user.first_name, 'Ada');
  assert.equal(verified.queryId, 'AAHdF6IQAAAAAN0Xoha9');
});

test('accepts a payload that also carries an Ed25519 signature field', () => {
  const initData = sign(baseFields({ signature: 'deadbeef' }));
  const verified = verifyTelegramInitData(initData, BOT_TOKEN, 300);
  assert.equal(verified.user.id, 123456789);
});

test('rejects a tampered user payload', () => {
  const initData = sign(baseFields());
  const tampered = initData.replace(
    encodeURIComponent('"first_name":"Ada"'),
    encodeURIComponent('"first_name":"Mallory"'),
  );
  expectAppError(() => verifyTelegramInitData(tampered, BOT_TOKEN, 300), 'TELEGRAM_INIT_DATA_INVALID');
});

test('rejects a signature produced with a different bot token', () => {
  const initData = sign(baseFields(), '999:OTHER-token');
  expectAppError(() => verifyTelegramInitData(initData, BOT_TOKEN, 300), 'TELEGRAM_INIT_DATA_INVALID');
});

test('rejects stale initData', () => {
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const initData = sign(baseFields({ auth_date: old }));
  expectAppError(() => verifyTelegramInitData(initData, BOT_TOKEN, 300), 'TELEGRAM_INIT_DATA_EXPIRED');
});

test('rejects initData without a hash', () => {
  const params = new URLSearchParams(baseFields());
  expectAppError(
    () => verifyTelegramInitData(params.toString(), BOT_TOKEN, 300),
    'TELEGRAM_INIT_DATA_INVALID',
  );
});

test('rejects an empty payload', () => {
  expectAppError(() => verifyTelegramInitData('', BOT_TOKEN, 300), 'TELEGRAM_INIT_DATA_MISSING');
});
