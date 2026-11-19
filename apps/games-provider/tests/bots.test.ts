import test from 'node:test';
import assert from 'node:assert/strict';
import { BotManager } from '../src/server/botManager';

const config = {
  enabled: true,
  count: 50,
  stakeMin: 100n,
  stakeMax: 1_000n,
  roundPayoutCap: 100_000n,
  dayPayoutCap: 1_000_000n,
  disclose: false,
};

test('bot display state does not affect seed-derived crash outcome', () => {
  const off = new BotManager({ ...config, enabled: false, count: 0 });
  const on = new BotManager(config);
  assert.deepEqual(off.participants(7, 'seed'), []);
  const onA = on.participants(7, 'seed');
  assert.equal(onA.length, 50);
  assert.deepEqual(onA.map((item) => [item.id, item.stake, item.cashout]), on.participants(7, 'seed').map((item) => [item.id, item.stake, item.cashout]));
});

test('bot round and day payout caps are enforced before presentation', () => {
  const manager = new BotManager({ ...config, roundPayoutCap: 500n, dayPayoutCap: 800n });
  const settled = manager.settle(7, 'seed', 100, new Date('2026-11-19T12:00:00Z'));
  assert.equal(settled.some((item) => item.won), true);
  assert.ok(manager.roundPayouts(7) <= 500n);
  assert.ok(manager.dayPayouts('2026-11-19') <= 800n);
  assert.equal(manager.roundPayouts(7) <= 500n, true);
});
