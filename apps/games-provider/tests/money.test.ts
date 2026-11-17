import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMinor, parseStakeToMinor, payoutFor } from '../src/domain/money';

test('payout uses integer hundredths, never floats', () => {
  assert.equal(payoutFor(1000n, 2.54, 1_000_000n), 2540n);
  assert.equal(payoutFor(333n, 1.5, 1_000_000n), 499n);
});

test('payout is clamped to the max win', () => {
  assert.equal(payoutFor(1000n, 50, 30_000n), 30_000n);
});

test('stake parsing rejects zero, negatives, fractions beyond 2dp and junk', () => {
  assert.equal(parseStakeToMinor('12.5'), 1250n);
  assert.equal(parseStakeToMinor('12,000'), 1_200_000n);
  assert.equal(parseStakeToMinor('0'), null);
  assert.equal(parseStakeToMinor('-5'), null);
  assert.equal(parseStakeToMinor('1.234'), null);
  assert.equal(parseStakeToMinor('abc'), null);
});

test('formatMinor renders two decimals', () => {
  assert.equal(formatMinor(2540n), '25.40');
  assert.equal(formatMinor(0n), '0.00');
});
