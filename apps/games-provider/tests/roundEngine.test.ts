import test from 'node:test';
import assert from 'node:assert/strict';
import { RoundEngine } from '../src/server/roundEngine';
import { createMemoryStore } from '../src/test/memoryStore';

function engine(store = createMemoryStore()) {
  const events: string[] = [];
  const instance = new RoundEngine({
    store,
    wallet: {} as never, // this test only exercises rounds, not bets
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 500 },
    operatorCode: 'bingo251',
    randomSeed: () => 'server-seed-fixed',
    clientSeeds: () => ['a', 'b', 'c'],
    onEvent: (event) => events.push(event.type),
  });
  return { instance, store, events };
}

test('a round is persisted before its betting broadcast', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { instance, store, events } = engine();
  await instance.start();
  const rounds = store.dump().rounds;
  assert.equal(rounds.length, 0); // created on the first loop tick
  await instance.tickOnce();
  assert.equal(store.dump().rounds.length, 1);
  assert.equal(events[0], 'round:betting');
  instance.stop();
});

test('takeoff persists the crash point before broadcasting it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { instance, store, events } = engine();
  await instance.start();
  await instance.tickOnce();
  await instance.tickOnce(5_500); // advance into FLYING
  const round = store.dump().rounds[0]!;
  assert.equal(round.status, 'FLYING');
  assert.ok(round.crashPoint && round.crashPoint >= 1);
  assert.ok(round.clientSeedComposite?.includes('a:b:c'));
  assert.deepEqual(events, ['round:betting', 'round:flying']);
  instance.stop();
});

test('crash persists the result and reveals the seed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { instance, store } = engine();
  await instance.start();
  await instance.tickOnce();
  await instance.tickOnce(5_500);
  const flightMs = instance.currentFlightMs();
  await instance.tickOnce(5_500 + flightMs);
  const round = store.dump().rounds[0]!;
  assert.equal(round.status, 'CRASHED');
  assert.ok(round.crashedAt);
  assert.equal(round.serverSeed, 'server-seed-fixed');
  instance.stop();
});

test('snapshot never exposes the crash point while flying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { instance } = engine();
  await instance.start();
  await instance.tickOnce();
  await instance.tickOnce(5_500);
  assert.equal(instance.snapshot().crashPoint, null);
  assert.ok(instance.snapshot().multiplier >= 1);
  instance.stop();
});
