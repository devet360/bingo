import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';

const baseEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  OPERATOR_CALLBACK_URL: 'https://bingo.example/api/games/callback/stratos',
  OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
};

test('config rejects blank limit overrides and keeps bigint parsing', () => {
  assert.throws(() => loadConfig({ ...baseEnv, GAME_MIN_STAKE: '' }), /GAME_MIN_STAKE/);

  const custom = loadConfig({ ...baseEnv, GAME_MIN_STAKE: '250' });
  assert.equal(typeof custom.limits.minStake, 'bigint');
  assert.equal(custom.limits.minStake, 250n);
});
