import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCombinedSeedInput, deriveCrashPointFromSha512Hex, elapsedMsForMultiplier,
  multiplierAtElapsedMs, sha256Hex, sha512Hex,
} from '../src/domain/provablyFair';

test('curve matches the prototype pacing', () => {
  assert.equal(multiplierAtElapsedMs(0), 1);
  assert.equal(multiplierAtElapsedMs(11_500), 1.99);
  assert.equal(multiplierAtElapsedMs(11_560), 2);
  assert.equal(multiplierAtElapsedMs(38_380), 10);
});

test('elapsed and multiplier round-trip within one tick', () => {
  const ms = elapsedMsForMultiplier(5);
  assert.ok(multiplierAtElapsedMs(ms) >= 5);
  assert.ok(multiplierAtElapsedMs(ms - 60) <= 5);
});

test('derivation is deterministic for a digest', async () => {
  const digest = await sha512Hex(buildCombinedSeedInput('seed-a', ['1', '2', '3']));
  const a = deriveCrashPointFromSha512Hex(digest);
  const b = deriveCrashPointFromSha512Hex(digest);
  assert.equal(a.crashPoint, b.crashPoint);
  assert.ok(a.crashPoint >= 1);
});

test('one digest in 33 crashes instantly at 1.00x', async () => {
  for (let i = 0; i < 500; i += 1) {
    const digest = await sha512Hex(`probe-${i}`);
    const value = Number.parseInt(digest.slice(0, 13), 16);
    if (value % 33 !== 0) continue;
    assert.equal(deriveCrashPointFromSha512Hex(digest).crashPoint, 1);
    return;
  }
  assert.fail('no instant-crash digest found in 500 probes');
});

test('crash point never exceeds 100000x', async () => {
  for (let i = 0; i < 200; i += 1) {
    const digest = await sha512Hex(`cap-${i}`);
    assert.ok(deriveCrashPointFromSha512Hex(digest).crashPoint <= 100_000);
  }
});

// One shared vector; tests/clientFair.test.ts asserts the same literals through
// the browser implementation, so the two provably-fair ports cannot drift.
test('the shared vector matches its hard-coded constants', async () => {
  const serverSeed = 'vect-server-seed';
  const clientSeeds = ['alpha', 'beta', 'gamma'];

  assert.equal(sha256Hex(serverSeed), 'e8c2cd0724faba2597b31c5708b812127cc99174e57f64b1418534a65dfa0574');
  const digest = await sha512Hex(buildCombinedSeedInput(serverSeed, clientSeeds));
  assert.equal(
    digest,
    'dae7fa435c56d5d221e0f1730fdb4cc61fdd895da28e3b3c32295db87a61b1dc8b47449569eca882db12bf85c204ea738058fbba95bec58c793c874d0e88fbf4',
  );
  const derived = deriveCrashPointFromSha512Hex(digest);
  assert.equal(derived.hexSlice52Bit, 'dae7fa435c56d');
  assert.equal(derived.decimalValue, 3851037936305517);
  assert.equal(derived.crashPoint, 6.84);
});
