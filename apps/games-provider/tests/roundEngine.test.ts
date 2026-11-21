import test from 'node:test';
import assert from 'node:assert/strict';
import { RoundEngine, type RoundBetManager } from '../src/server/roundEngine';
import { createMemoryStore } from '../src/test/memoryStore';
import { BotManager } from '../src/server/botManager';

function engine(store = createMemoryStore(), betManager?: RoundBetManager) {
  const events: string[] = [];
  const instance = new RoundEngine({
    store,
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 500 },
    operatorCode: 'bingo251',
    randomSeed: () => 'server-seed-fixed',
    clientSeeds: () => ['a', 'b', 'c'],
    onEvent: (event) => events.push(event.type),
    betManager,
  });
  return { instance, store, events };
}

/** Bet-handling seam stub; override only the methods a test exercises. */
function betManagerStub(overrides: Partial<RoundBetManager> = {}): RoundBetManager {
  const unused = async (): Promise<never> => {
    throw new Error('bet manager stub called unexpectedly');
  };
  return {
    place: unused,
    cancel: async () => undefined,
    cashout: async () => undefined,
    settleRound: async () => undefined,
    processAutoCashouts: async () => undefined,
    ...overrides,
  };
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

test('round events expose explicitly labelled simulation bots and their settled outcomes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const store = createMemoryStore();
  const events: import('../src/server/roundEngine').RoundEngineEvent[] = [];
  const instance = new RoundEngine({
    store,
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 500 },
    operatorCode: 'bingo251',
    randomSeed: () => 'server-seed-fixed',
    clientSeeds: () => ['a', 'b', 'c'],
    onEvent: (event) => events.push(event),
    botManager: new BotManager({
      enabled: true, count: 2, stakeMin: 100n, stakeMax: 200n,
      roundPayoutCap: 10_000n, dayPayoutCap: 100_000n, disclose: false,
    }),
  });
  await instance.start();
  await instance.tickOnce();
  const betting = events[0];
  assert.equal(betting?.type, 'round:betting');
  if (betting?.type !== 'round:betting') throw new Error('Expected betting event');
  assert.equal(betting.payload.bots.length, 2);
  assert.equal(betting.payload.bots[0]?.disclosed, true);
  await instance.tickOnce(5_500);
  await instance.tickOnce(instance.currentFlightMs());
  const crashed = events.find((event) => event.type === 'round:crashed');
  assert.equal(crashed?.type, 'round:crashed');
  if (crashed?.type === 'round:crashed') {
    assert.equal(crashed.payload.bots.length, 2);
    assert.equal(crashed.payload.bots[0]?.disclosed, true);
  }
  instance.stop();
});

test('a settlement failure does not wedge the crash', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  let settleCalls = 0;
  const betManager = betManagerStub({
    settleRound: async () => {
      settleCalls += 1;
      throw new Error('boom');
    },
  });
  const { instance, store, events } = engine(createMemoryStore(), betManager);
  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    await instance.start();
    await instance.tickOnce();
    await instance.tickOnce(5_500);
    // Unguarded on purpose: before the fix this crash tick rejected and the
    // engine stayed FLYING, re-running the failing settlement on every tick.
    await instance.tickOnce(5_500 + instance.currentFlightMs());
  } finally {
    console.error = originalError;
    instance.stop();
  }

  assert.equal(store.dump().rounds[0]!.status, 'CRASHED');
  assert.equal(instance.snapshot().phase, 'CRASHED');
  assert.ok(events.includes('round:crashed'));
  assert.equal(settleCalls, 1); // the crash path never re-runs
  assert.equal(logged.length, 1); // failure is reported, not thrown
});

test('restart does not stall the loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { instance } = engine();
  await instance.start();
  // Fires the interval: the round opens, but every queued tick still shares the
  // engine clock, so the betting window starts here.
  t.mock.timers.tick(6_000);
  instance.stop();
  await new Promise((resolve) => setImmediate(resolve));
  const bettingEndsBeforeRestart = instance.snapshot().bettingEndsInMs;
  assert.equal(bettingEndsBeforeRestart, 5_500);

  await instance.start();
  t.mock.timers.tick(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  // Without the wall-clock rebase this stayed 5_500 for another 6s of engine time.
  assert.ok(instance.snapshot().bettingEndsInMs < bettingEndsBeforeRestart);

  t.mock.timers.tick(5_000); // betting window elapses -> FLYING
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instance.snapshot().phase, 'FLYING');

  t.mock.timers.tick(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(instance.snapshot().elapsedMs > 0);
  instance.stop();
});

test('auto-cashout sweep runs on every flying tick', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const sweeps: { roundId: number; multiplier: number; elapsedMs: number }[] = [];
  const betManager = betManagerStub({
    processAutoCashouts: async ({ round, multiplier, elapsedMs }) => {
      sweeps.push({ roundId: round.id, multiplier, elapsedMs });
    },
  });
  const { instance, events } = engine(createMemoryStore(), betManager);
  await instance.start();
  await instance.tickOnce();
  await instance.tickOnce(5_500); // takeoff instant: no sweep yet
  await instance.tickOnce(500);
  await instance.tickOnce(500);
  await instance.tickOnce(250);

  assert.ok(sweeps.length >= 2);
  for (const sweep of sweeps) {
    assert.equal(sweep.roundId, 1);
    assert.ok(sweep.multiplier >= 1);
  }
  assert.ok(sweeps[0]!.multiplier < sweeps[sweeps.length - 1]!.multiplier);
  // One sweep per flying tick: the sweep precedes that tick's `round:tick`.
  assert.equal(sweeps.length, events.filter((type) => type === 'round:tick').length);
  instance.stop();
});
