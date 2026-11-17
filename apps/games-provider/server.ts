import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { loadConfig } from './src/config';
import { createDb } from './src/db/index';
import { createPostgresStore } from './src/db/storePostgres';
import { BetManager } from './src/server/betManager';
import { createApp } from './src/server/http';
import { OutboxWorker } from './src/server/outbox';
import { reconcileUnresolvedBets, RECONCILE_INTERVAL_MS, runRecovery } from './src/server/recovery';
import { RoundEngine } from './src/server/roundEngine';
import { attachSocket, type SocketHandle } from './src/server/socket';
import { HttpWalletClient } from './src/server/wallet';

const config = loadConfig();
const database = createDb(config.databaseUrl);
await database.migrate();
const store = createPostgresStore(database.db);
await store.upsertOperator({
  code: config.operator.code,
  name: config.operator.name,
  callbackUrl: config.operator.callbackUrl,
  hmacSecret: config.operator.hmacSecret,
  currency: config.operator.currency,
  enabled: true,
});

const wallet = new HttpWalletClient({
  callbackUrl: config.operator.callbackUrl,
  hmacSecret: config.operator.hmacSecret,
});
let socket: SocketHandle | undefined;
const outbox = new OutboxWorker({
  store,
  wallet,
  onDelivered: ({ sessionToken, balance }) => socket?.notifyBalance(sessionToken, balance),
});

// Design §5.3: attempt every pending win once before deciding anything else.
console.log('games-provider: boot drain', await outbox.drainOnce(new Date()));
console.log('games-provider: boot recovery', await runRecovery({ store, wallet }));
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
  wallet,
  limits: config.limits,
  newId: () => randomUUID(),
  onSettled: (bet) => socket?.notifyBet(bet),
});
const engine = new RoundEngine({
  store,
  wallet,
  limits: config.limits,
  betManager,
  operatorCode: config.operator.code,
  randomSeed: () => randomUUID(),
  clientSeeds: () => config.clientSeeds,
  onEvent: (event) => socket?.broadcast(event),
});
const server = createServer(createApp({ config, store, wallet }));
socket = attachSocket({ server, store, engine });

await new Promise<void>((resolve) => server.listen(config.port, resolve));
console.log(`games-provider: listening on ${config.port}`);
// §5.3: the background loop starts only once the port is open.
outbox.start(1000);
await engine.start();

// Runtime sweep for bets stranded by a flaky wallet; boot recovery only runs
// at process start, so without this an UNRESOLVED bet waits for a restart.
let reconciling = false;
const reconcileTimer = setInterval(() => {
  if (reconciling) return;
  reconciling = true;
  void reconcileUnresolvedBets({ store, wallet })
    .then((resolved) => {
      if (resolved > 0) console.log(`games-provider: reconciled ${resolved} unresolved bets`);
    })
    .catch((error: unknown) => console.error('games-provider: reconcile sweep failed', error))
    .finally(() => {
      reconciling = false;
    });
}, RECONCILE_INTERVAL_MS);
reconcileTimer.unref();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`games-provider: ${signal}, shutting down`);
  engine.stop(); // no new rounds, no new ticks
  outbox.stop();
  clearInterval(reconcileTimer);
  await socket?.close(); // terminates live clients so server.close can finish
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
