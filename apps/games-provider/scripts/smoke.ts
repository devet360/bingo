import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/index';
import { createPostgresStore } from '../src/db/storePostgres';
import { sha256Hex } from '../src/domain/provablyFair';
import { runRecovery } from '../src/server/recovery';
import { HttpWalletClient } from '../src/server/wallet';

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
  await store.upsertOperator({
    code: config.operator.code,
    name: config.operator.name,
    callbackUrl: config.operator.callbackUrl,
    hmacSecret: config.operator.hmacSecret,
    currency: config.operator.currency,
    enabled: true,
  });

  const at = new Date();
  const session = {
    token: randomUUID(),
    operatorCode: config.operator.code,
    currency: config.operator.currency,
    minStake: config.limits.minStake,
    maxStake: config.limits.maxStake,
    maxWin: config.limits.maxWin,
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

  console.log('smoke: first recovery', JSON.stringify(first));
  console.log('smoke: second recovery', JSON.stringify(second));
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
