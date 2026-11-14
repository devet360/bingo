import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * Typed accessors over SystemConfig. Every value is JSON, so readers validate
 * the shape they expect and fall back to the platform default when an operator
 * has never touched the key.
 */
export async function getConfig<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.systemConfig.findUnique({ where: { key }, select: { value: true } });
  return row ? (row.value as T) : fallback;
}

export async function setConfig(
  key: string,
  value: Prisma.InputJsonValue,
  updatedById?: string,
  description?: string,
): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { key },
    create: { key, value, updatedById, description },
    update: { value, updatedById, ...(description ? { description } : {}) },
  });
}

export interface ReferralSettings {
  commissionBps: number;
  minRakeToPay: bigint;
}

export const REFERRAL_CONFIG_KEY = 'referral.program';

export async function getReferralSettings(): Promise<ReferralSettings> {
  const stored = await getConfig<Partial<{ commissionBps: number; minRakeToPay: string }>>(
    REFERRAL_CONFIG_KEY,
    {},
  );
  const bps = Number(stored.commissionBps ?? 0);
  return {
    commissionBps: Number.isInteger(bps) && bps >= 0 && bps <= 5000 ? bps : 0,
    minRakeToPay: BigInt(stored.minRakeToPay ?? '0'),
  };
}

export const BONUS_CONFIG_KEY = 'bonus.program';

export interface BonusSettings {
  defaultWageringMultiplier: number;
  defaultExpiryDays: number;
}

export async function getBonusSettings(): Promise<BonusSettings> {
  const stored = await getConfig<Partial<BonusSettings>>(BONUS_CONFIG_KEY, {});
  const multiplier = Number(stored.defaultWageringMultiplier ?? 3);
  const expiryDays = Number(stored.defaultExpiryDays ?? 7);
  return {
    defaultWageringMultiplier:
      Number.isInteger(multiplier) && multiplier >= 1 && multiplier <= 100 ? multiplier : 3,
    defaultExpiryDays: Number.isInteger(expiryDays) && expiryDays >= 1 && expiryDays <= 365
      ? expiryDays
      : 7,
  };
}
