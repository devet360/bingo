import test from 'node:test';
import assert from 'node:assert/strict';

// The support service pulls in env/prisma at import time; provide dummy values
// before the dynamic import so this test never needs a database.
process.env.DATABASE_URL = 'postgresql://bingo:bingo@127.0.0.1:5432/bingo';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
process.env.OTP_HASH_PEPPER = 'c'.repeat(32);
process.env.BOT_TOKEN = '123456:test-support-token';
process.env.SUPPORT_HOURS_START = '20';
process.env.SUPPORT_HOURS_END = '04';
process.env.SUPPORT_TIMEZONE = 'UTC';

test('operating hours wrap past midnight', async () => {
  const support = await import('../src/services/support');
  assert.equal(support.isSupportOnline(new Date('2026-01-01T12:00:00Z')), false);
  assert.equal(support.isSupportOnline(new Date('2026-01-01T20:00:00Z')), true);
  assert.equal(support.isSupportOnline(new Date('2026-01-01T23:59:00Z')), true);
  assert.equal(support.isSupportOnline(new Date('2026-01-01T03:59:00Z')), true);
  assert.equal(support.isSupportOnline(new Date('2026-01-01T04:00:00Z')), false);
  assert.equal(support.supportHoursLabel(), '20:00–04:00');
});

test('en and am bot copy expose the same surface', async () => {
  const { supportCopy } = await import('../src/support-bot/copy');
  assert.deepEqual(
    Object.keys(supportCopy.en).sort(),
    Object.keys(supportCopy.am).sort(),
  );
  assert.deepEqual(
    Object.keys(supportCopy.en.buttons).sort(),
    Object.keys(supportCopy.am.buttons).sort(),
  );
  assert.deepEqual(
    Object.keys(supportCopy.en.faq).sort(),
    Object.keys(supportCopy.am.faq).sort(),
  );
});

test('bot copy interpolates codes and hours', async () => {
  const { supportCopy } = await import('../src/support-bot/copy');
  assert.match(supportCopy.en.agentOnline('SUP-ABC123'), /SUP-ABC123/);
  assert.match(supportCopy.am.agentOffline('SUP-ABC123', '20:00–04:00'), /SUP-ABC123/);
  assert.match(supportCopy.en.unregistered('bingo_bot'), /@bingo_bot/);
  assert.ok(
    supportCopy.en
      .accountBody({
        name: 'Ada',
        phone: '+251900000000',
        verified: true,
        available: '10.00',
        bonus: '0.00',
        locked: '0.00',
        deposits: [],
        withdrawals: [],
      })
      .includes('Ada'),
  );
});
