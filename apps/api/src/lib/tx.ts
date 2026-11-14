import { Prisma } from '@prisma/client';
import { logger } from './logger';
import { prisma } from './prisma';

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/**
 * Interactive transaction with headroom over Prisma's 5s default. Hundreds of
 * milliseconds per round trip against a hosted database push multi-statement
 * journals (lock -> idempotency check -> write) past the default mid-flight.
 */
export function runTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(fn, TX_OPTIONS);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isKnownPrismaError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

export function isUniqueViolation(error: unknown, field?: string): boolean {
  if (!isKnownPrismaError(error) || error.code !== 'P2002') return false;
  if (!field) return true;
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return fields.includes(field);
}

/** Row-level deadlocks and write conflicts are expected under load; retry them. */
export function isRetryable(error: unknown): boolean {
  if (!isKnownPrismaError(error)) return false;
  if (error.code === 'P2034') return true;
  // Generated 6-digit codes can collide; a retry picks a fresh one.
  return isUniqueViolation(error, 'code') || isUniqueViolation(error, 'payoutCode');
}

export async function withTxRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) throw error;
      logger.warn({ attempt, err: error }, 'retrying transaction after conflict');
      await sleep(15 * 2 ** attempt);
    }
  }
  throw lastError;
}
