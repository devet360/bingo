import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCombinedSeedInput, deriveCrashPointFromSha512Hex, elapsedMsForMultiplier,
  multiplierAtElapsedMs, sha512Hex,
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
