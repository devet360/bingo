import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { maintenanceSweep } from '../services/maintenance';

export const MAINTENANCE_QUEUE = 'bingo-maintenance';
export const SWEEP_JOB = 'sweep';

export function createRedisConnection(): IORedis {
  return new IORedis(env.REDIS_URL!, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/**
 * Queue-side connection that fails fast: the API can fall back to an
 * in-process sweep when Redis is unreachable instead of queueing forever.
 */
function createQueueConnection(): IORedis {
  return new IORedis(env.REDIS_URL!, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    lazyConnect: true,
    connectTimeout: 3_000,
    retryStrategy: () => null,
  });
}

/** Registers the repeating sweep. Idempotent; safe to call from API and worker. */
export async function scheduleMaintenance(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    'maintenance-sweep',
    { every: env.MAINTENANCE_INTERVAL_MS },
    { name: SWEEP_JOB, data: {} },
  );
}

/**
 * Fail-fast connectivity probe for the worker entrypoint, so a misconfigured
 * REDIS_URL exits with a clear error instead of retrying forever.
 */
export async function assertRedisReachable(timeoutMs = 4_000): Promise<void> {
  if (!env.REDIS_URL) throw new Error('REDIS_URL is not set');
  const connection = createQueueConnection();
  connection.on('error', () => undefined);
  try {
    const probe = connection.connect().then(() => connection.ping());
    const ok = await Promise.race([probe.then(() => true), delay(timeoutMs).then(() => false)]);
    if (!ok) throw new Error(`Redis did not answer within ${timeoutMs}ms`);
  } finally {
    connection.disconnect();
  }
}

/**
 * When REDIS_URL is set, BullMQ owns the sweep so it survives API restarts and
 * runs once across replicas. Without Redis (or if it is unreachable) the API
 * falls back to a local timer.
 */
export async function startMaintenance(): Promise<() => Promise<void>> {
  if (!env.REDIS_URL) return startLocalSweep();

  const connection = createQueueConnection();
  connection.on('error', () => undefined);
  const queue = new Queue(MAINTENANCE_QUEUE, { connection });
  try {
    const scheduling = scheduleMaintenance(queue);
    scheduling.catch(() => undefined);
    const outcome = await Promise.race([
      scheduling.then(() => 'ok' as const),
      delay(5_000).then(() => 'timeout' as const),
    ]);
    if (outcome !== 'ok') throw new Error('BullMQ scheduling timed out');
    logger.info({ queue: MAINTENANCE_QUEUE }, 'maintenance sweep scheduled in BullMQ');

    return async () => {
      await queue.close();
      connection.disconnect();
    };
  } catch (error) {
    logger.warn({ err: error }, 'BullMQ unavailable; maintenance falls back to in-process');
    await queue.close().catch(() => undefined);
    connection.disconnect();
    return startLocalSweep();
  }
}

function startLocalSweep(): () => Promise<void> {
  const timer = setInterval(() => {
    maintenanceSweep().catch((error) => logger.error({ err: error }, 'maintenance sweep failed'));
  }, env.MAINTENANCE_INTERVAL_MS);
  timer.unref();
  logger.info({ intervalMs: env.MAINTENANCE_INTERVAL_MS }, 'maintenance sweep running in-process');
  return async () => clearInterval(timer);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
