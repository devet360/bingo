import type { Prisma } from '@prisma/client';

/**
 * Transaction-scoped Postgres advisory lock. Two API instances sharing a room
 * serialise their transitions here; the lock is released at commit/rollback.
 *
 * `$executeRaw` (not `$queryRaw`): the lock function returns `void`, which
 * Prisma cannot deserialize from a result set.
 */
export async function advisoryXactLock(
  tx: Prisma.TransactionClient,
  key: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
