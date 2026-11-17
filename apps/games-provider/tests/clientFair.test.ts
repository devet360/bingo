import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyProof } from '../src/client/fair';

// Same vector as tests/provablyFair.test.ts: literals generated once by the
// server implementation and hard-coded here, never re-derived from the code
// under test.
const SERVER_SEED = 'vect-server-seed';
const CLIENT_SEED_COMPOSITE = 'alpha:beta:gamma';
const SERVER_SEED_HASH = 'e8c2cd0724faba2597b31c5708b812127cc99174e57f64b1418534a65dfa0574';
const SHA512_HASH =
  'dae7fa435c56d5d221e0f1730fdb4cc61fdd895da28e3b3c32295db87a61b1dc8b47449569eca882db12bf85c204ea738058fbba95bec58c793c874d0e88fbf4';
const HEX_SLICE = 'dae7fa435c56d';
const DECIMAL = 3851037936305517;
const CRASH_POINT = 6.84;

test('the browser proof verifier matches the shared server vector', async () => {
  const proof = await verifyProof({
    roundId: 1,
    serverSeed: SERVER_SEED,
    serverSeedHash: SERVER_SEED_HASH,
    clientSeedComposite: CLIENT_SEED_COMPOSITE,
    crashPoint: CRASH_POINT,
  });

  assert.equal(proof.serverSeedHashComputed, SERVER_SEED_HASH);
  assert.equal(proof.serverSeedHashMatches, true);
  assert.equal(proof.combinedInput, 'vect-server-seed:alpha:beta:gamma');
  assert.equal(proof.sha512Hash, SHA512_HASH);
  assert.equal(proof.hexSlice52Bit, HEX_SLICE);
  assert.equal(proof.decimalValue, DECIMAL);
  assert.equal(proof.computedCrashPoint, CRASH_POINT);
  assert.equal(proof.crashPointMatches, true);
});
