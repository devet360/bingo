import { Queue, Worker } from 'bullmq';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import {
  assertRedisReachable,
  createRedisConnection,
  MAINTENANCE_QUEUE,
  scheduleMaintenance,
  SWEEP_JOB,
} from './jobs/maintenanceQueue';
import { maintenanceSweep } from './services/maintenance';

async function main(): Promise<void> {
  if (!env.REDIS_URL) {
    logger.error('REDIS_URL is required for the worker process');
    process.exit(1);
  }

  await assertRedisReachable();
  const queueConnection = createRedisConnection();
  const workerConnection = createRedisConnection();

  const queue = new Queue(MAINTENANCE_QUEUE, { connection: queueConnection });
  await scheduleMaintenance(queue);

  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name === SWEEP_JOB) return maintenanceSweep();
      logger.warn({ job: job.name }, 'ignoring unknown job');
      return null;
    },
    { connection: workerConnection, concurrency: env.WORKER_CONCURRENCY },
  );

  worker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, name: job.name, result }, 'job completed');
  });
  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, name: job?.name, err: error }, 'job failed');
  });

  logger.info({ queue: MAINTENANCE_QUEUE, concurrency: env.WORKER_CONCURRENCY }, 'bingo worker started');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    await worker.close();
    await queue.close();
    await prisma.$disconnect();
    await workerConnection.quit().catch(() => undefined);
    await queueConnection.quit().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
