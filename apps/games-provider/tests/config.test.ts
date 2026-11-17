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

test('limits and client seeds have production defaults and are overridable', () => {
  const defaults = loadConfig(baseEnv);
  assert.equal(defaults.limits.maxBetsPerRound, 200);
  assert.deepEqual(defaults.clientSeeds, [
    'stratos_slot_1_00000001', 'stratos_slot_2_00000002', 'stratos_slot_3_00000003',
  ]);
  assert.equal(defaults.operator.name, 'Bingo 251');

  const custom = loadConfig({
    ...baseEnv,
    GAME_MAX_BETS_PER_ROUND: '350',
    CLIENT_SEEDS: 'a,b,c',
    OPERATOR_NAME: 'Acme Casino',
  });
  assert.equal(custom.limits.maxBetsPerRound, 350);
  assert.deepEqual(custom.clientSeeds, ['a', 'b', 'c']);
  assert.equal(custom.operator.name, 'Acme Casino');
});

test('CLIENT_SEEDS must contain exactly three seeds', () => {
  assert.throws(() => loadConfig({ ...baseEnv, CLIENT_SEEDS: 'a,b' }), /exactly 3/);
});
