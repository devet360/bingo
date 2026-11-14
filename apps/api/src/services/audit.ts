import type { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export interface AuditInput {
  actorId?: string | null;
  actorRole?: UserRole | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
}

/**
 * Staff actions are audited even when the business write later fails, so the
 * trail reflects every attempt. Never pass credentials or token material here.
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorRole: input.actorRole ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        before: input.before as Prisma.InputJsonValue | undefined,
        after: input.after as Prisma.InputJsonValue | undefined,
        ip: input.ip,
        userAgent: input.userAgent,
      },
    });
  } catch (error) {
    logger.error({ err: error, action: input.action }, 'failed to write audit log');
  }
}
