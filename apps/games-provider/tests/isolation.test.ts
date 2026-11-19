import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakeBingo } from '../src/test/fakeBingo';
import { createMemoryStore } from '../src/test/memoryStore';
import { OperatorRegistry } from '../src/server/operatorRegistry';
import { loadConfig } from '../src/config';
import { startTestServer } from '../src/test/server';
import { handshake } from '../src/server/handshake';
import { BetManager, BetRuleError } from '../src/server/betManager';
import { OutboxWorker } from '../src/server/outbox';
import { BETTING_WINDOW_MS } from '../src/server/roundEngine';
import type { MovementReply, WalletClient } from '../src/server/wallet';
import type { RoundRecord, SessionRecord } from '../src/domain/types';

const SECRET_A = 'test-secret-operator-a';
const SECRET_B = 'test-secret-operator-b';
// The fake mirrors bingo, which rejects a non-UUID session id before anything else.
const TOKEN_B = '9e107d9d-372b-4f4b-9c1d-2f7a1b3c4d5e';

test('two operators settle against their own wallets only', async (t) => {
  const fakeA = await createFakeBingo({ hmacSecret: SECRET_A, balance: 50_000n, operatorCode: 'op-a' });
  const fakeB = await createFakeBingo({
    hmacSecret: SECRET_B, balance: 50_000n, operatorCode: 'op-b', token: TOKEN_B,
  });
  const store = createMemoryStore();
  const base = {
    currency: 'ETB', status: 'ACTIVE' as const, allowedOrigins: [], localeDefault: 'en' as const,
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 4 },
    enabledGames: ['crash'], theme: null, maintenance: false, probeOkAt: null,
    createdAt: new Date('2026-11-19T00:00:00Z'),
  };
  await store.upsertOperator({ ...base, code: 'op-a', name: 'A', callbackUrl: `${fakeA.url}/api/games/callback/op-a` });
  await store.upsertOperator({ ...base, code: 'op-b', name: 'B', callbackUrl: `${fakeB.url}/api/games/callback/op-b` });
  await store.addOperatorSecret('op-a', SECRET_A);
  await store.addOperatorSecret('op-b', SECRET_B);
  const registry = new OperatorRegistry({ store });
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CODE: 'op-a',
    OPERATOR_CALLBACK_URL: `${fakeA.url}/api/games/callback/op-a`,
    OPERATOR_HMAC_SECRET: SECRET_A,
  });
  const server = await startTestServer({ config, store, registry });
  t.after(async () => { await server.close(); await fakeA.close(); await fakeB.close(); });

  const sessionA = await handshake({ token: fakeA.token, operatorCode: 'op-a', config, store, registry });
  const sessionB = await handshake({ token: fakeB.token, operatorCode: 'op-b', config, store, registry });

  await server.engine.tickOnce(1); // opens round 1
  await server.engine.placeBet({ session: sessionA, panel: 0, stake: 1_000n });
  await server.engine.placeBet({ session: sessionB, panel: 0, stake: 2_000n });
  // Both bets are on round 1 and carry their own operator.
  const roundId = server.engine.snapshot().roundId!;
  const bets = await store.listBetsForRound(roundId);
  assert.deepEqual(bets.map((bet) => bet.operatorCode).sort(), ['op-a', 'op-b']);
  assert.equal(await store.countBetsForRoundByOperator(roundId, 'op-a'), 1);
  assert.equal(await store.countBetsForRoundByOperator(roundId, 'op-b'), 1);

  // Each placement was charged by its own operator's wallet, never the other's.
  assert.equal(fakeA.state().balance, 49_000n);
  assert.equal(fakeB.state().balance, 48_000n);

  // Take off and cash both out at 1.00, then deliver the outbox through the
  // registry: every win must reach the wallet that owns its operator code.
  await server.engine.tickOnce(BETTING_WINDOW_MS);
  assert.equal(server.engine.snapshot().phase, 'FLYING');
  await server.engine.cashout({ session: sessionA, panel: 0 });
  await server.engine.cashout({ session: sessionB, panel: 0 });
  assert.deepEqual(
    await new OutboxWorker({ store, wallets: registry }).drainOnce(new Date()),
    { sent: 2, retried: 0, capped: 0, dead: 0 },
  );
  assert.equal(fakeA.state().balance, 50_000n);
  assert.equal(fakeB.state().balance, 50_000n);
  // Each fake saw exactly its own session: the handshake balance, one placement
  // and one delivery. A win routed to the wrong operator would land here.
  const ownCalls: Array<[string, number]> = [['balance', 200], ['bet', 201], ['win', 201]];
  assert.deepEqual(fakeA.state().calls.map((call) => [call.type, call.status]), ownCalls);
  assert.deepEqual(fakeB.state().calls.map((call) => [call.type, call.status]), ownCalls);
});

test('one operator at its cap does not block another operator in the same round', async () => {
  const store = createMemoryStore();
  const charged: string[] = [];
  const wallets = {
    async walletFor(code: string): Promise<WalletClient> {
      return {
        balance: async () => { throw new Error('isolation test never reads a balance'); },
        bet: async () => {
          charged.push(code);
          return { accepted: true, replayed: false, balance: null } satisfies MovementReply;
        },
        win: async () => { throw new Error('isolation test never wins'); },
        rollback: async () => { throw new Error('isolation test never rolls back'); },
      };
    },
  };
  const manager = new BetManager({ store, wallets, newId: () => randomUUID() });
  const round: RoundRecord = {
    id: 1, serverSeed: 's', serverSeedHash: 'h', clientSeedComposite: null, crashPoint: null,
    status: 'BETTING', startedAt: new Date(0), flewAt: null, crashedAt: null,
  };
  const session = (token: string, operatorCode: string): SessionRecord => ({
    token, operatorCode, gameId: 'crash', currency: 'ETB',
    minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 1,
    displayBalance: 10_000n, status: 'OPEN', createdAt: new Date(0), lastHandshakeAt: new Date(0),
  });
  const opA = session('11111111-1111-4111-8111-111111111111', 'op-a');
  const opB = session('22222222-2222-4222-8222-222222222222', 'op-b');

  await manager.place({ round, session: opA, panel: 0, stake: 1_000n, autoCashout: null });
  await assert.rejects(
    manager.place({ round, session: opA, panel: 1, stake: 1_000n, autoCashout: null }),
    (error: unknown) => error instanceof BetRuleError && error.code === 'ROUND_BET_LIMIT',
  );
  const betB = await manager.place({ round, session: opB, panel: 0, stake: 1_000n, autoCashout: null });

  assert.equal(betB.status, 'ACTIVE');
  assert.equal(await store.countBetsForRoundByOperator(round.id, 'op-a'), 1);
  assert.equal(await store.countBetsForRoundByOperator(round.id, 'op-b'), 1);
  // The rejected bet never reached op-a's wallet, and op-b was charged by its own.
  assert.deepEqual(charged, ['op-a', 'op-b']);
});
