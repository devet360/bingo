import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/index';
import { createPostgresStore } from '../src/db/storePostgres';
import { sha256Hex } from '../src/domain/provablyFair';
import { BetManager } from '../src/server/betManager';
import { runRecovery } from '../src/server/recovery';
import { HttpWalletClient, type WalletClient } from '../src/server/wallet';

/**
 * Production smoke: proves a real database migrates, the operator row is
 * upserted, and boot recovery rolls back an interrupted round exactly once.
 *
 * It writes rows, so it refuses to run without `SMOKE_CONFIRM=yes`. Recovery is
 * global, not scoped to these fixtures: run this against a staging database, or
 * before the provider is opened to players — it abandons and refunds every
 * unfinished round it finds.
 */

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(label);
}

/** Host and database name only: a connection string carries the password. */
function databaseTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return 'unparseable DATABASE_URL';
  }
}

if (process.env.SMOKE_CONFIRM !== 'yes') {
  console.error('smoke: refusing to run without SMOKE_CONFIRM=yes (this writes rows to the database)');
  process.exit(1);
}

const config = loadConfig();
const database = createDb(config.databaseUrl);
const store = createPostgresStore(database.db);
const wallet = new HttpWalletClient({
  callbackUrl: config.operator.callbackUrl,
  hmacSecret: config.operator.hmacSecret,
});

let failure: string | null = null;

try {
  console.log(`smoke: database ${databaseTarget(config.databaseUrl)}`);
  await database.migrate();
  const at = new Date();
  const existing = await store.getOperator(config.operator.code);
  await store.upsertOperator({
    code: config.operator.code,
    name: config.operator.name,
    callbackUrl: config.operator.callbackUrl,
    currency: config.operator.currency,
    status: existing?.status ?? 'ACTIVE',
    allowedOrigins: config.allowedParentOrigins,
    localeDefault: existing?.localeDefault ?? 'en',
    limits: config.limits,
    enabledGames: existing?.enabledGames ?? ['crash'],
    theme: existing?.theme ?? null,
    maintenance: existing?.maintenance ?? false,
    probeOkAt: existing?.probeOkAt ?? at,
    createdAt: existing?.createdAt ?? at,
  });
  if ((await store.listOperatorSecrets(config.operator.code)).length === 0) {
    await store.addOperatorSecret(config.operator.code, config.operator.hmacSecret);
  }

  const session = {
    token: randomUUID(),
    operatorCode: config.operator.code,
    gameId: 'crash',
    currency: config.operator.currency,
    minStake: config.limits.minStake,
    maxStake: config.limits.maxStake,
    maxWin: config.limits.maxWin,
    maxBetsPerRound: config.limits.maxBetsPerRound,
    displayBalance: 0n,
    status: 'OPEN' as const,
    createdAt: at,
    lastHandshakeAt: at,
  };
  await store.saveSession(session);

  const serverSeed = randomUUID();
  const round = await store.createRound({
    serverSeed,
    serverSeedHash: sha256Hex(serverSeed),
    startedAt: at,
  });
  const stake = config.limits.minStake;
  const bet = await store.insertBet({
    roundId: round.id,
    operatorCode: session.operatorCode,
    sessionToken: session.token,
    panel: 0,
    stake,
    autoCashout: null,
    status: 'ACTIVE',
    cashoutMultiplier: null,
    payout: null,
    betTxnId: randomUUID(),
    winTxnId: null,
  });

  const first = await runRecovery({ store, wallet });

  const abandoned = await store.getRound(round.id);
  check(abandoned?.status === 'ABANDONED', `round ${round.id} is ${abandoned?.status}, expected ABANDONED`);
  check(
    first.abandonedRoundIds.includes(round.id),
    `first recovery did not report round ${round.id} as abandoned`,
  );
  const cancelled = await store.getBet(round.id, session.token, 0);
  check(cancelled?.status === 'CANCELLED', `bet ${bet.id} is ${cancelled?.status}, expected CANCELLED`);

  // A wide batch: this must find its own row even when live rows are queued
  // ahead of it, or the fake session's rollback would be delivered to bingo.
  const due = await store.claimDueOutbox(new Date(), 1000);
  const rollback = due.find((row) => row.txnId === bet.betTxnId);
  if (rollback === undefined) throw new Error(`no due outbox row for bet txn ${bet.betTxnId}`);
  check(rollback.type === 'ROLLBACK', `outbox row for bet txn ${bet.betTxnId} is ${rollback.type}`);
  check(
    rollback.amount === stake,
    `outbox row for bet txn ${bet.betTxnId} refunds ${rollback.amount}, expected the stake ${stake}`,
  );
  check(
    rollback.sessionToken === session.token,
    `outbox row for bet txn ${bet.betTxnId} targets session ${rollback.sessionToken}, expected ${session.token}`,
  );
  // Never call bingo for a fake session: close the row as a labelled tombstone.
  await store.markOutbox(rollback.id, 'SENT', 'SMOKE_TEST');

  const second = await runRecovery({ store, wallet });
  check(
    second.abandonedRoundIds.length === 0 && second.refundedBets === 0 && second.repairedSettlements === 0,
    `second recovery was not idempotent: ${JSON.stringify(second)}`,
  );

  // One full round through the bet manager, still without calling bingo: a stub
  // wallet accepts the placement so the numeric columns and settle path run.
  const playRound = await store.createRound({
    serverSeed: randomUUID(),
    serverSeedHash: sha256Hex(randomUUID()),
    startedAt: at,
  });
  const stubWallet: WalletClient = {
    balance: async () => { throw new Error('smoke: stub wallet balance must not be called'); },
    bet: async () => ({ accepted: true, replayed: false, balance: null }),
    win: async () => { throw new Error('smoke: stub wallet win must not be called directly'); },
    rollback: async () => { throw new Error('smoke: stub wallet rollback must not be called directly'); },
  };
  const betManager = new BetManager({
    store,
    wallet: stubWallet,
    limits: config.limits,
    newId: () => randomUUID(),
  });
  const playStake = config.limits.minStake;
  // place() only accepts a BETTING round, so the bet goes down before takeoff.
  const firstBet = await betManager.place({
    round: playRound, session, panel: 0, stake: playStake, autoCashout: null,
  });
  check(firstBet.status === 'ACTIVE', `bet ${firstBet.id} is ${firstBet.status}, expected ACTIVE`);

  await store.startFlight(playRound.id, {
    crashPoint: 3.5,
    clientSeedComposite: 'smoke-client-seed-composite',
    at,
  });
  const flying = await store.getRound(playRound.id);
  if (flying === null) throw new Error(`round ${playRound.id} vanished after takeoff`);
  check(flying.status === 'FLYING', `round ${playRound.id} is ${flying.status}, expected FLYING`);

  await betManager.cashout({ round: flying, session, panel: 0, multiplier: 2.37 });
  const cashed = await store.getBet(playRound.id, session.token, 0);
  if (cashed === null) throw new Error(`bet ${firstBet.id} vanished after cashout`);
  check(cashed.status === 'CASHED', `bet ${cashed.id} is ${cashed.status}, expected CASHED`);
  check(
    cashed.cashoutMultiplier === 2.37,
    `bet ${cashed.id} round-tripped ${cashed.cashoutMultiplier}, expected 2.37`,
  );
  const expectedPayout = (playStake * 237n) / 100n;
  check(cashed.payout === expectedPayout, `bet ${cashed.id} pays ${cashed.payout}, expected ${expectedPayout}`);

  // A second ACTIVE bet must lose the round while the cashed one stays paid.
  await store.insertBet({
    roundId: playRound.id,
    operatorCode: session.operatorCode,
    sessionToken: session.token,
    panel: 1,
    stake: playStake,
    autoCashout: null,
    status: 'ACTIVE',
    cashoutMultiplier: null,
    payout: null,
    betTxnId: randomUUID(),
    winTxnId: null,
  });
  const crashedAt = new Date();
  await store.finishRound(playRound.id, { status: 'CRASHED', at: crashedAt });
  await betManager.settleRound({
    round: { ...flying, status: 'CRASHED', crashPoint: 3.5, crashedAt },
    maxWin: config.limits.maxWin,
  });
  const lost = await store.getBet(playRound.id, session.token, 1);
  check(lost?.status === 'LOST', `second bet is ${lost?.status}, expected LOST`);
  const stillCashed = await store.getBet(playRound.id, session.token, 0);
  check(stillCashed?.status === 'CASHED', `first bet is ${stillCashed?.status}, expected CASHED`);

  const winTxnId = cashed.winTxnId;
  if (winTxnId === null) throw new Error(`cashed bet ${cashed.id} has no win txn id`);
  const afterRound = await store.claimDueOutbox(new Date(), 1000);
  const win = afterRound.find((row) => row.txnId === winTxnId);
  if (win === undefined) throw new Error(`no due outbox row for win txn ${winTxnId}`);
  check(win.type === 'WIN', `outbox row for win txn ${winTxnId} is ${win.type}`);
  check(win.amount === expectedPayout, `WIN row for ${winTxnId} pays ${win.amount}, expected ${expectedPayout}`);
  check(win.sessionToken === session.token, `WIN row targets session ${win.sessionToken}, expected ${session.token}`);
  await store.markOutbox(win.id, 'SENT', 'SMOKE_TEST');

  console.log('smoke: first recovery', JSON.stringify(first));
  console.log('smoke: second recovery', JSON.stringify(second));
  console.log(
    `smoke: played round=${playRound.id} cashedBet=${cashed.id} payout=${cashed.payout} winOutbox=${win.id}`,
  );
  console.log(
    `smoke: wrote session=${session.token} round=${round.id} bet=${bet.id} betTxn=${bet.betTxnId} rollbackOutbox=${rollback.id}`,
  );
  console.log('smoke: OK');
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await database.close();
}

if (failure !== null) {
  console.error(`smoke: FAILED ${failure}`);
  process.exit(1);
}
