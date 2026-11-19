import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { loadConfig } from './src/config';
import { createDb } from './src/db/index';
import { createPostgresStore } from './src/db/storePostgres';
import { BetManager } from './src/server/betManager';
import { createApp } from './src/server/http';
import { OutboxWorker } from './src/server/outbox';
import { OperatorRegistry } from './src/server/operatorRegistry';
import { reconcileUnresolvedBets, RECONCILE_INTERVAL_MS, runRecovery } from './src/server/recovery';
import { RoundEngine } from './src/server/roundEngine';
import { attachSocket, type SocketHandle } from './src/server/socket';
import { CoinFlipEngine } from './src/server/coinFlipEngine';
import { LeaderLock } from './src/server/leaderLock';

const config = loadConfig();
const database = createDb(config.databaseUrl);
await database.migrate();
const store = createPostgresStore(database.db);

// The bootstrap operator stays env-seeded: `OPERATOR_*` owns identity, callback,
// currency, limits and origins, while lifecycle fields survive a restart.
async function seedBootstrapOperator(store: ReturnType<typeof createPostgresStore>, config: ReturnType<typeof loadConfig>) {
  const existing = await store.getOperator(config.operator.code);
  const now = new Date();
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
    probeOkAt: existing?.probeOkAt ?? now,
    createdAt: existing?.createdAt ?? now,
  });
  if ((await store.listOperatorSecrets(config.operator.code)).length === 0) {
    await store.addOperatorSecret(config.operator.code, config.operator.hmacSecret);
  }
}
await seedBootstrapOperator(store, config);
// One directory resolves every wallet: bets, outbox rows and recovery replays
// all settle against the operator that owns the session, never a shared client.
const registry = new OperatorRegistry({ store });

let socket: SocketHandle | undefined;
const outbox = new OutboxWorker({
  store,
  wallets: registry,
  onDelivered: ({ sessionToken, balance }) => socket?.notifyBalance(sessionToken, balance),
});

// Design §5.3: attempt every pending win once before deciding anything else.
console.log('games-provider: boot drain', await outbox.drainOnce(new Date()));
console.log('games-provider: boot recovery', await runRecovery({ store, wallets: registry }));
// §5.3.4: every recovery rollback is enqueued now; attempt them before the loop.
console.log('games-provider: recovery drain', await outbox.drainOnce(new Date()));

const stranded = {
  dead: await store.countOutboxByStatus('DEAD'),
  capped: await store.countOutboxByStatus('CAP_REJECTED'),
};
if (stranded.dead + stranded.capped > 0) {
  console.error('games-provider: wallet rows need operator attention', stranded);
}

const betManager = new BetManager({
  store,
  wallets: registry,
  newId: () => randomUUID(),
  onSettled: (bet) => socket?.notifyBet(bet),
});
const coinEngine = new CoinFlipEngine({
  store,
  betManager,
  operatorCode: config.operator.code,
  randomSeed: () => randomUUID(),
  clientSeeds: () => config.clientSeeds,
  onEvent: (event) => socket?.broadcastCoinFlip(event),
});
const engine = new RoundEngine({
  store,
  limits: config.limits,
  betManager,
  operatorCode: config.operator.code,
  randomSeed: () => randomUUID(),
  clientSeeds: () => config.clientSeeds,
  onEvent: (event) => socket?.broadcast(event),
});
const server = createServer(createApp({ config, store, registry }));
socket = attachSocket({ server, store, engine, coinEngine, registry });

await new Promise<void>((resolve) => server.listen(config.port, resolve));
console.log(`games-provider: listening on ${config.port}`);
const leader = new LeaderLock(database.pool);
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
await leader.start((isLeader) => {
  if (!isLeader) {
    outbox.stop();
    engine.stop();
    coinEngine.stop();
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
    console.log('games-provider: leadership lost');
    return;
  }
  outbox.start(1000);
  void engine.start();
  void coinEngine.start();
  let reconciling = false;
  reconcileTimer = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void reconcileUnresolvedBets({ store, wallets: registry })
      .then((resolved) => {
        if (resolved > 0) console.log(`games-provider: reconciled ${resolved} unresolved bets`);
      })
      .catch((error: unknown) => console.error('games-provider: reconcile sweep failed', error))
      .finally(() => {
        reconciling = false;
      });
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
  void leader.notifyState({ leader: true, at: new Date().toISOString() });
  console.log('games-provider: leadership acquired');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`games-provider: ${signal}, shutting down`);
  engine.stop(); // no new rounds, no new ticks
  coinEngine.stop();
  outbox.stop();
  if (reconcileTimer) clearInterval(reconcileTimer);
  await leader.stop();
  await socket?.close(); // terminates live clients so server.close can finish
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
