import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateClientSeed,
  computeSeedHash,
  deriveBallOrder,
  hmacSha256Hex,
  sha256Hex,
} from '../src/game/rng';
import { generateCard, isColumnAscending } from '../src/game/cards';
import {
  completedPatterns,
  isPatternComplete,
  validateClaim,
} from '../src/game/patterns';
import { computeEconomics, computeFixedEconomics, splitPrize } from '../src/game/payout';
import { cardNumbers, type CardGrid } from '../src/game/types';

test('ball order is deterministic, complete and seed-dependent', () => {
  const input = {
    serverSeed: 'server-seed',
    clientSeed: 'client-seed',
    nonce: 0,
    ballMax: 75,
  };
  const first = deriveBallOrder(input);
  const second = deriveBallOrder(input);
  assert.deepEqual(first, second);
  assert.equal(first.length, 75);
  assert.deepEqual([...first].sort((a, b) => a - b), Array.from({ length: 75 }, (_, i) => i + 1));

  const otherSeed = deriveBallOrder({ ...input, serverSeed: 'other' });
  const otherNonce = deriveBallOrder({ ...input, nonce: 1 });
  const otherClient = deriveBallOrder({ ...input, clientSeed: 'other' });
  assert.notDeepEqual(otherSeed, first);
  assert.notDeepEqual(otherNonce, first);
  assert.notDeepEqual(otherClient, first);
});

test('draw order matches the documented HMAC construction', () => {
  const serverSeed = 'abc';
  const clientSeed = 'def';
  const nonce = 7;
  const ballMax = 90;
  const order = deriveBallOrder({ serverSeed, clientSeed, nonce, ballMax });
  assert.equal(order.length, 90);
  assert.equal(computeSeedHash(serverSeed), sha256Hex(serverSeed));
  assert.equal(
    hmacSha256Hex(serverSeed, `${clientSeed}:${nonce}`),
    hmacSha256Hex(serverSeed, 'def:7'),
  );
});

test('client seed aggregation is order independent', () => {
  assert.equal(aggregateClientSeed([]), sha256Hex(''));
  assert.equal(aggregateClientSeed(['b', 'a']), aggregateClientSeed(['a', 'b']));
  assert.notEqual(aggregateClientSeed(['a']), aggregateClientSeed(['b']));
});

test('US 75 cards have legal columns and a free centre', () => {
  for (let i = 0; i < 50; i += 1) {
    const card = generateCard('US_75');
    assert.equal(card.grid.length, 5);
    assert.equal(card.grid[2]![2], null);
    assert.equal(cardNumbers(card).length, 24);
    for (let col = 0; col < 5; col += 1) {
      const values = card.grid.map((row) => row[col]!).filter((value) => value !== null);
      assert.equal(values.length, col === 2 ? 4 : 5);
      for (const value of values) {
        assert.ok(value >= col * 15 + 1 && value <= col * 15 + 15);
      }
    }
  }
});

test('UK 90 tickets have 15 numbers, five per row and legal columns', () => {
  for (let i = 0; i < 100; i += 1) {
    const card = generateCard('UK_90');
    assert.equal(card.grid.length, 3);
    assert.equal(cardNumbers(card).length, 15);
    for (const row of card.grid) {
      assert.equal(row.filter((cell) => cell !== null).length, 5);
    }
    for (let col = 0; col < 9; col += 1) {
      const values = card.grid.map((row) => row[col]!).filter((value) => value !== null);
      assert.ok(values.length >= 1 && values.length <= 3);
      const [min, max] = col === 0 ? [1, 9] : col === 8 ? [80, 90] : [col * 10, col * 10 + 9];
      for (const value of values) assert.ok(value >= min && value <= max);
    }
    assert.ok(isColumnAscending(card));
  }
});

// row 0: vertical line; row 1: diagonal; row 2: corner-ish grid
const usCard: CardGrid = {
  variant: 'US_75',
  rows: 5,
  cols: 5,
  freeCenter: true,
  grid: [
    [1, 16, 31, 46, 61],
    [2, 17, 32, 47, 62],
    [3, 18, null, 48, 63],
    [4, 19, 34, 49, 64],
    [5, 20, 35, 50, 65],
  ],
};

test('horizontal, vertical and full house detection', () => {
  assert.ok(isPatternComplete(usCard, [1, 16, 31, 46, 61], 'HORIZONTAL'));
  assert.ok(!isPatternComplete(usCard, [1, 16, 31, 46], 'HORIZONTAL'));
  assert.ok(isPatternComplete(usCard, [1, 2, 3, 4, 5], 'VERTICAL'));
  assert.ok(!isPatternComplete(usCard, [1, 2, 3, 4], 'VERTICAL'));
  assert.ok(isPatternComplete(usCard, cardNumbers(usCard), 'FULL_HOUSE'));
  assert.ok(!isPatternComplete(usCard, cardNumbers(usCard).slice(0, -1), 'FULL_HOUSE'));
});

test('diagonal crosses the free centre', () => {
  assert.ok(isPatternComplete(usCard, [1, 17, 49, 65], 'DIAGONAL'));
  assert.ok(isPatternComplete(usCard, [61, 47, 19, 5], 'DIAGONAL'));
  assert.ok(!isPatternComplete(usCard, [1, 17, 49], 'DIAGONAL'));
});

test('four corners needs every corner number', () => {
  assert.ok(isPatternComplete(usCard, [1, 61, 5, 65], 'FOUR_CORNERS'));
  assert.ok(!isPatternComplete(usCard, [1, 61, 5], 'FOUR_CORNERS'));
  assert.ok(!isPatternComplete(usCard, [1, 61, 5, 64], 'FOUR_CORNERS'));
});

test('completed pattern list respects the room allow-list', () => {
  const drawn = [1, 16, 31, 46, 61];
  assert.deepEqual(completedPatterns(usCard, drawn, ['HORIZONTAL']), ['HORIZONTAL']);
  assert.deepEqual(completedPatterns(usCard, drawn, ['FULL_HOUSE']), []);
});

test('claim validation enforces variant support, room rules and evidence', () => {
  assert.deepEqual(validateClaim(usCard, [1, 16, 31, 46, 61], 'HORIZONTAL', ['HORIZONTAL']), {
    valid: true,
  });
  assert.equal(
    validateClaim(usCard, [1, 16, 31, 46, 61], 'DIAGONAL', ['HORIZONTAL']).reason,
    'PATTERN_NOT_ALLOWED',
  );
  assert.equal(
    validateClaim(usCard, [1, 16, 31], 'HORIZONTAL', ['HORIZONTAL']).reason,
    'PATTERN_INCOMPLETE',
  );

  const ukCard = generateCard('UK_90');
  assert.equal(
    validateClaim(ukCard, cardNumbers(ukCard), 'DIAGONAL', ['DIAGONAL']).reason,
    'PATTERN_NOT_SUPPORTED',
  );
});

test('round economics keep gross = rake + prize and split exactly', () => {
  const economics = computeEconomics(100_001n, 1000);
  assert.equal(economics.rakeAmount, 10_000n);
  assert.equal(economics.prizePool, 90_001n);
  assert.equal(economics.rakeAmount + economics.prizePool, economics.grossPot);

  const shares = splitPrize(100n, 3);
  assert.deepEqual(shares, [34n, 33n, 33n]);
  assert.equal(shares.reduce((sum, share) => sum + share, 0n), 100n);
  assert.throws(() => splitPrize(100n, 0));
});

test('fixed prizes leave a rake surplus or a treasury-funded shortfall', () => {
  const surplus = computeFixedEconomics(2_600_000n, 2_500_000n);
  assert.equal(surplus.prizePool, 2_500_000n);
  assert.equal(surplus.rakeAmount, 100_000n);

  const shortfall = computeFixedEconomics(1_800_000n, 2_500_000n);
  assert.equal(shortfall.prizePool, 2_500_000n);
  assert.equal(shortfall.rakeAmount, -700_000n);
  assert.equal(shortfall.rakeAmount + shortfall.prizePool, shortfall.grossPot);

  const shares = splitPrize(shortfall.prizePool, 2);
  assert.equal(shares.reduce((sum, share) => sum + share, 0n), shortfall.prizePool);
});
