import type { Bonus, BonusPromotion, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { runTransaction, withTxRetry } from '../lib/tx';
import { advisoryXactLock } from '../lib/dbLock';
import { minorToWire } from '../lib/money';
import { getBonusSettings } from './config';
import { postLedger } from './ledger';
import { provisionUserAccounts } from './accounts';

export function serializeBonus(bonus: Bonus) {
  return {
    id: bonus.id,
    kind: bonus.kind,
    amount: minorToWire(bonus.amount),
    wagered: minorToWire(bonus.wagered),
    target: minorToWire(bonus.target),
    multiplier: bonus.multiplier,
    status: bonus.status,
    expiresAt: bonus.expiresAt,
    completedAt: bonus.completedAt,
    createdAt: bonus.createdAt,
    promotionId: bonus.promotionId,
  };
}

export function serializeBonusPromotion(promotion: BonusPromotion) {
  return {
    id: promotion.id,
    code: promotion.code,
    name: promotion.name,
    percentBps: promotion.percentBps,
    fixedAmount: minorToWire(promotion.fixedAmount),
    maxBonus: minorToWire(promotion.maxBonus),
    minDeposit: minorToWire(promotion.minDeposit),
    wageringMultiplier: promotion.wageringMultiplier,
    expiresInDays: promotion.expiresInDays,
    enabled: promotion.enabled,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    maxRedemptions: promotion.maxRedemptions,
    redemptionCount: promotion.redemptionCount,
    createdAt: promotion.createdAt,
  };
}

async function bonusAccountBalance(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<bigint> {
  const account = await tx.ledgerAccount.findUnique({
    where: {
      ownerKind_ownerId_code: { ownerKind: 'USER', ownerId: userId, code: 'BONUS' },
    },
    select: { balance: true },
  });
  return account?.balance ?? 0n;
}

/** Moves the whole grant to withdrawable credits once the playthrough target is met. */
async function convertBonus(tx: Prisma.TransactionClient, bonus: Bonus): Promise<void> {
  const remaining = await bonusAccountBalance(tx, bonus.userId);
  if (remaining > 0n) {
    await postLedger(tx, {
      idempotencyKey: `bonus-convert:${bonus.id}`,
      kind: 'BONUS_CONVERT',
      refType: 'Bonus',
      refId: bonus.id,
      memo: `Bonus ${bonus.id} released after wagering ${bonus.target} minor units`,
      instructions: [
        { ownerKind: 'USER', ownerId: bonus.userId, code: 'BONUS', delta: -remaining },
        { ownerKind: 'USER', ownerId: bonus.userId, code: 'AVAILABLE', delta: remaining },
      ],
    });
  }
  await tx.bonus.update({
    where: { id: bonus.id },
    data: { status: 'COMPLETED', completedAt: new Date(), wagered: bonus.target },
  });
}

/** Expired playthrough forfeits whatever is left of the grant. */
async function forfeitBonus(tx: Prisma.TransactionClient, bonus: Bonus): Promise<void> {
  const remaining = await bonusAccountBalance(tx, bonus.userId);
  if (remaining > 0n) {
    await postLedger(tx, {
      idempotencyKey: `bonus-forfeit:${bonus.id}`,
      kind: 'BONUS_FORFEIT',
      refType: 'Bonus',
      refId: bonus.id,
      memo: `Bonus ${bonus.id} expired before wagering completed`,
      instructions: [
        { ownerKind: 'USER', ownerId: bonus.userId, code: 'BONUS', delta: -remaining },
        { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'BONUS_EXPENSE', delta: remaining },
      ],
    });
  }
  await tx.bonus.update({ where: { id: bonus.id }, data: { status: 'EXPIRED' } });
}

interface GrantInput {
  amount: bigint;
  multiplier: number;
  expiresInDays: number;
  promotionId?: string | null;
  grantedById?: string | null;
  kind: 'PROMO_CODE' | 'ADMIN_GRANT';
}

async function grantBonusTx(
  tx: Prisma.TransactionClient,
  userId: string,
  input: GrantInput,
): Promise<Bonus> {
  await provisionUserAccounts(tx, userId);
  await tx.ledgerAccount.upsert({
    where: {
      ownerKind_ownerId_code: { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'BONUS_EXPENSE' },
    },
    create: { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'BONUS_EXPENSE' },
    update: {},
  });

  const bonus = await tx.bonus.create({
    data: {
      userId,
      promotionId: input.promotionId ?? null,
      grantedById: input.grantedById ?? null,
      kind: input.kind,
      amount: input.amount,
      target: input.amount * BigInt(input.multiplier),
      multiplier: input.multiplier,
      expiresAt: new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1_000),
    },
  });

  await postLedger(tx, {
    idempotencyKey: `bonus-grant:${bonus.id}`,
    kind: 'BONUS_GRANT',
    refType: 'Bonus',
    refId: bonus.id,
    memo: `${input.kind} bonus for user ${userId}`,
    createdById: input.grantedById ?? undefined,
    instructions: [
      { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'BONUS_EXPENSE', delta: -input.amount },
      { ownerKind: 'USER', ownerId: userId, code: 'BONUS', delta: input.amount },
    ],
  });

  return bonus;
}

/**
 * Player redeems a promo code. The percentage form applies to deposits settled
 * since the promotion opened, capped by maxBonus; fixed codes ignore deposits.
 */
export async function redeemPromoCode(userId: string, rawCode: string): Promise<Bonus> {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    throw Errors.badRequest('Enter a valid promo code', 'INVALID_PROMO_CODE');
  }

  return withTxRetry(() =>
    runTransaction(async (tx) => {
      await advisoryXactLock(tx, `user-bonus:${userId}`);

      const promotion = await tx.bonusPromotion.findUnique({ where: { code } });
      if (!promotion) throw Errors.notFound('Promo code');
      const now = new Date();
      if (!promotion.enabled) throw Errors.conflict('This promo code is not active', 'PROMO_INACTIVE');
      if (promotion.startsAt && promotion.startsAt > now) {
        throw Errors.conflict('This promo code is not active yet', 'PROMO_NOT_STARTED');
      }
      if (promotion.endsAt && promotion.endsAt <= now) {
        throw Errors.conflict('This promo code has expired', 'PROMO_EXPIRED');
      }
      if (
        promotion.maxRedemptions !== null &&
        promotion.redemptionCount >= promotion.maxRedemptions
      ) {
        throw Errors.conflict('This promo code has been fully redeemed', 'PROMO_EXHAUSTED');
      }

      const active = await tx.bonus.findFirst({
        where: { userId, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      });
      if (active && active.expiresAt > now) {
        throw Errors.conflict(
          'Finish your current bonus before redeeming another code',
          'BONUS_ACTIVE',
        );
      }
      if (active) await forfeitBonus(tx, active);

      await advisoryXactLock(tx, `bonus-promo:${promotion.id}`);
      const claimed = await tx.bonusPromotion.updateMany({
        where: {
          id: promotion.id,
          enabled: true,
          ...(promotion.maxRedemptions !== null
            ? { redemptionCount: { lt: promotion.maxRedemptions } }
            : {}),
        },
        data: { redemptionCount: { increment: 1 } },
      });
      if (claimed.count !== 1) {
        throw Errors.conflict('This promo code has been fully redeemed', 'PROMO_EXHAUSTED');
      }

      let amount = promotion.fixedAmount ?? 0n;
      if (promotion.percentBps !== null) {
        const cutoff = promotion.startsAt ?? promotion.createdAt;
        const deposited = await tx.depositRequest.aggregate({
          where: { playerId: userId, status: 'CREDITED', settledAt: { gte: cutoff } },
          _sum: { creditedAmount: true, amount: true },
        });
        const base = deposited._sum.creditedAmount ?? deposited._sum.amount ?? 0n;
        if (promotion.minDeposit !== null && base < promotion.minDeposit) {
          throw Errors.conflict(
            'Deposit the required amount before redeeming this code',
            'PROMO_MIN_DEPOSIT',
          );
        }
        amount = (base * BigInt(promotion.percentBps)) / 10_000n;
        if (promotion.maxBonus !== null && amount > promotion.maxBonus) amount = promotion.maxBonus;
      }

      if (amount <= 0n) {
        throw Errors.conflict('This code is not available on your account', 'PROMO_NO_VALUE');
      }

      return grantBonusTx(tx, userId, {
        amount,
        multiplier: promotion.wageringMultiplier,
        expiresInDays: promotion.expiresInDays,
        promotionId: promotion.id,
        kind: 'PROMO_CODE',
      });
    }),
  );
}

export interface AdminGrantInput {
  userId: string;
  amount: bigint;
  multiplier?: number;
  expiresInDays?: number;
  grantedById: string;
  note?: string;
}

export async function grantBonus(input: AdminGrantInput): Promise<Bonus> {
  if (input.amount <= 0n) throw Errors.badRequest('Bonus amount must be positive');
  const settings = await getBonusSettings();
  const multiplier = input.multiplier ?? settings.defaultWageringMultiplier;
  const expiresInDays = input.expiresInDays ?? settings.defaultExpiryDays;

  return withTxRetry(() =>
    runTransaction(async (tx) => {
      await advisoryXactLock(tx, `user-bonus:${input.userId}`);
      const user = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true, status: true },
      });
      if (!user) throw Errors.notFound('Player');
      if (user.status !== 'ACTIVE') {
        throw Errors.conflict('This account is not active', 'ACCOUNT_INACTIVE');
      }
      const active = await tx.bonus.findFirst({
        where: { userId: input.userId, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      });
      if (active) {
        if (active.expiresAt > new Date()) {
          throw Errors.conflict('Player already has an active bonus', 'BONUS_ACTIVE');
        }
        await forfeitBonus(tx, active);
      }
      return grantBonusTx(tx, input.userId, {
        amount: input.amount,
        multiplier,
        expiresInDays,
        grantedById: input.grantedById,
        kind: 'ADMIN_GRANT',
      });
    }),
  );
}

/**
 * Called inside card purchase: stake counts toward the active bonus target.
 * Conversion/forfeiture happen in the same transaction as the purchase.
 */
export async function accrueWagering(
  tx: Prisma.TransactionClient,
  userId: string,
  stake: bigint,
): Promise<void> {
  if (stake <= 0n) return;
  const bonus = await tx.bonus.findFirst({
    where: { userId, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });
  if (!bonus) return;
  if (bonus.expiresAt <= new Date()) {
    await forfeitBonus(tx, bonus);
    return;
  }
  const wagered = bonus.wagered + stake;
  if (wagered >= bonus.target) {
    await tx.bonus.update({ where: { id: bonus.id }, data: { wagered } });
    await convertBonus(tx, bonus);
    return;
  }
  await tx.bonus.update({ where: { id: bonus.id }, data: { wagered } });
}

export async function getActiveBonus(userId: string): Promise<Bonus | null> {
  return prisma.bonus.findFirst({
    where: { userId, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });
}

export async function listBonusHistory(userId: string, take = 20): Promise<Bonus[]> {
  return prisma.bonus.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

/** Sweeper entry point: expire every grant whose playthrough deadline passed. */
export async function expireDueBonuses(limit = 100): Promise<number> {
  const due = await prisma.bonus.findMany({
    where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
    select: { id: true },
    take: limit,
  });
  let expired = 0;
  for (const { id } of due) {
    const didExpire = await withTxRetry(() =>
      runTransaction(async (tx) => {
        await advisoryXactLock(tx, `bonus:${id}`);
        const bonus = await tx.bonus.findUnique({ where: { id } });
        if (!bonus || bonus.status !== 'ACTIVE') return false;
        await forfeitBonus(tx, bonus);
        return true;
      }),
    );
    if (didExpire) expired += 1;
  }
  return expired;
}
