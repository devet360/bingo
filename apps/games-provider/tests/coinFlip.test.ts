import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deriveCoinFlipOutcome } from '../src/domain/provablyFair';
import { createMemoryStore } from '../src/test/memoryStore';
import { BetManager } from '../src/server/betManager';
import { CoinFlipEngine, COINFLIP_BETTING_WINDOW_MS } from '../src/server/coinFlipEngine';
import type { SessionRecord } from '../src/domain/types';
import type { WalletClient } from '../src/server/wallet';

test('coin flip derives heads or tails from the server/client seed triple', () => {
  const seeds = ['coin-a', 'coin-b', 'coin-c'];
  const first = deriveCoinFlipOutcome('server-one', seeds);
  const second = deriveCoinFlipOutcome('server-one', seeds);
  assert.equal(first, second);
  assert.ok(first === 'HEADS' || first === 'TAILS');
});

test('coin flip pays only the winning panel through the shared bet/outbox machinery', async () => {
  const store = createMemoryStore();
  const walletCalls: string[] = [];
  const wallet: WalletClient = {
    balance: async () => {
      throw new Error('coin flip test must not read balance');
    },
    bet: async (input) => {
      walletCalls.push(`bet:${input.txnId}:${input.amount}`);
      return { accepted: true, replayed: false, balance: 8_000n };
    },
    win: async (input) => {
      walletCalls.push(`win:${input.txnId}:${input.amount}`);
      return { accepted: true, replayed: false, balance: 10_000n };
    },
    rollback: async () => ({ accepted: true, replayed: false, balance: 8_000n }),
  };
  const manager = new BetManager({
    store,
    wallets: { walletFor: async () => wallet },
    newId: () => '11111111-1111-4111-8111-111111111111',
  });
  const engine = new CoinFlipEngine({
    store,
    betManager: manager,
    operatorCode: 'op-a',
    randomSeed: () => 'deterministic-seed',
    clientSeeds: () => ['coin-a', 'coin-b', 'coin-c'],
  });
  await engine.tickOnce(1);
  const round = engine.snapshot().roundId;
  assert.ok(round !== null);
  const session: SessionRecord = {
    token: randomUUID(),
    operatorCode: 'op-a',
    gameId: 'coinflip',
    currency: 'ETB',
    minStake: 100n,
    maxStake: 10_000n,
    maxWin: 10_000n,
    maxBetsPerRound: 100,
    displayBalance: 10_000n,
    status: 'OPEN',
    createdAt: new Date(),
    lastHandshakeAt: new Date(),
  };
  await store.saveSession(session);
  await engine.placeBet({ session, panel: 0, stake: 1_000n });
  await engine.placeBet({ session, panel: 1, stake: 1_000n });
  await engine.tickOnce(COINFLIP_BETTING_WINDOW_MS);

  const bets = await store.listBetsForRound(round);
  const winningOutcome = bets.find((bet) => bet.status === 'CASHED');
  assert.equal(bets.length, 2);
  assert.equal(winningOutcome ? 1 : 0, 1);
  assert.equal(bets.filter((bet) => bet.status === 'LOST').length, 1);
  assert.ok(walletCalls.some((call) => call.startsWith('bet:coinflip:')));
  const outbox = store.dump().outbox;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]?.type, 'WIN');
  assert.ok(outbox[0]?.txnId.startsWith('coinflip:'));
});
