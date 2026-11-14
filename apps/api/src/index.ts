import { createServer } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { createRealtime } from './realtime/gateway';
import { roundEngine } from './engine/roundEngine';
import { startMaintenance } from './jobs/maintenanceQueue';

const app = createApp();
const server = createServer(app);
const io = createRealtime(server);

server.listen(env.port, () => {
  logger.info({ port: env.port, env: env.NODE_ENV }, 'bingo api listening');
  if (env.BINGO_ENGINE_ENABLED) {
    roundEngine.start();
    logger.info('bingo round engine started');
  }
  void startMaintenance()
    .then((stop) => {
      stopMaintenance = stop;
    })
    .catch((error) => logger.error({ err: error }, 'maintenance scheduler failed to start'));
});

let stopMaintenance: (() => Promise<void>) | null = null;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const force = setTimeout(() => {
    logger.error('forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
  force.unref();

  roundEngine.stop();
  if (stopMaintenance) await stopMaintenance().catch(() => undefined);
  io.close();
  server.close(async () => {
    await prisma.$disconnect();
    clearTimeout(force);
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled rejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception, exiting');
  void shutdown('uncaughtException');
});
