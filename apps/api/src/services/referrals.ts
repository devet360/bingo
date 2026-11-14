import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { minorToWire } from '../lib/money';
import { getReferralSettings, REFERRAL_CONFIG_KEY } from './config';
import { postLedger } from './ledger';

interface RoundStakes {
  roundId: string;
  roomName: string;
  rakeBps: number;
  stakesByUser: Map<string, bigint>;
}

export interface ReferralCommissionView {
  id: string;
  playerId: string;
  playerName: string | null;
  roundId: string | null;
  rakeBase: bigint;
  bps: number;
  amount: bigint;
  createdAt: Date;
}

export function serializeReferralCommission(commission: ReferralCommissionView) {
  return {
    id: commission.id,
    playerId: commission.playerId,
    playerName: commission.playerName,
    roundId: commission.roundId,
    rakeBase: minorToWire(commission.rakeBase),
    bps: commission.bps,
    amount: minorToWire(commission.amount),
    createdAt: commission.createdAt,
  };
}

async function readSettings(
  tx: Prisma.TransactionClient,
): Promise<{ commissionBps: number; minRakeToPay: bigint }> {
  const row = await tx.systemConfig.findUnique({
    where: { key: REFERRAL_CONFIG_KEY },
    select: { value: true },
  });
  const value = (row?.value ?? {}) as Partial<{ commissionBps: number; minRakeToPay: string }>;
  const bps = Number(value.commissionBps ?? 0);
  return {
    commissionBps: Number.isInteger(bps) && bps >= 0 && bps <= 5000 ? bps : 0,
    minRakeToPay: BigInt(value.minRakeToPay ?? '0'),
  };
}

/**
 * Pays referrers a share of the rake their referred players generated in this
 * round. Runs inside the settlement transaction so the payout and the round's
 * ledger commit together; one journal per referrer per round keeps it idempotent.
 */
export async function settleReferralCommissions(
  tx: Prisma.TransactionClient,
  stakes: RoundStakes,
): Promise<number> {
  const settings = await readSettings(tx);
  if (settings.commissionBps <= 0 || stakes.stakesByUser.size === 0) return 0;

  const players = await tx.user.findMany({
    where: {
      id: { in: [...stakes.stakesByUser.keys()] },
      referredById: { not: null },
    },
    select: { id: true, referredById: true },
  });
  if (players.length === 0) return 0;

  const byReferrer = new Map<
    string,
    { total: bigint; rows: Array<{ playerId: string; rakeBase: bigint; amount: bigint }> }
  >();

  for (const player of players) {
    const referrerId = player.referredById!;
    const stake = stakes.stakesByUser.get(player.id) ?? 0n;
    const rakeBase = (stake * BigInt(stakes.rakeBps)) / 10_000n;
    if (rakeBase < settings.minRakeToPay) continue;
    const amount = (rakeBase * BigInt(settings.commissionBps)) / 10_000n;
    if (amount <= 0n) continue;
    const bucket = byReferrer.get(referrerId) ?? { total: 0n, rows: [] };
    bucket.total += amount;
    bucket.rows.push({ playerId: player.id, rakeBase, amount });
    byReferrer.set(referrerId, bucket);
  }
  if (byReferrer.size === 0) return 0;

  for (const [referrerId, bucket] of byReferrer) {
    await tx.referralCommission.createMany({
      data: bucket.rows.map((row) => ({
        referrerId,
        playerId: row.playerId,
        roundId: stakes.roundId,
        rakeBase: row.rakeBase,
        bps: settings.commissionBps,
        amount: row.amount,
      })),
      skipDuplicates: true,
    });

    await postLedger(tx, {
      idempotencyKey: `referral:${stakes.roundId}:${referrerId}`,
      kind: 'AFFILIATE_COMMISSION',
      refType: 'BingoRound',
      refId: stakes.roundId,
      memo: `Referral commission from ${stakes.roomName} round ${stakes.roundId}`,
      instructions: [
        { ownerKind: 'PLATFORM', ownerId: 'platform', code: 'RAKE', delta: -bucket.total },
        { ownerKind: 'USER', ownerId: referrerId, code: 'AVAILABLE', delta: bucket.total },
      ],
    });

    await tx.notification.create({
      data: {
        userId: referrerId,
        type: 'SYSTEM',
        title: 'Referral commission',
        body: `You earned ${minorToWire(bucket.total)} credits from your referrals.`,
        data: { roundId: stakes.roundId },
      },
    });
  }

  return byReferrer.size;
}

export interface ReferralOverview {
  code: string;
  inviteLink: string | null;
  commissionBps: number;
  referredCount: number;
  activeReferrals: number;
  totalEarned: bigint;
  recent: ReferralCommissionView[];
}

export async function getReferralOverview(
  userId: string,
  botUsername: string | null,
): Promise<ReferralOverview> {
  const [user, settings, referredCount, activeReferrals, totals, recent] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } }),
    getReferralSettings(),
    prisma.user.count({ where: { referredById: userId } }),
    prisma.user.count({ where: { referredById: userId, status: 'ACTIVE' } }),
    prisma.referralCommission.aggregate({
      where: { referrerId: userId },
      _sum: { amount: true },
    }),
    prisma.referralCommission.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { player: { select: { displayName: true } } },
    }),
  ]);

  const code = user?.referralCode ?? '';
  return {
    code,
    inviteLink: botUsername && code ? `https://t.me/${botUsername}?start=ref_${code}` : null,
    commissionBps: settings.commissionBps,
    referredCount,
    activeReferrals,
    totalEarned: totals._sum.amount ?? 0n,
    recent: recent.map((row) => ({
      id: row.id,
      playerId: row.playerId,
      playerName: row.player?.displayName ?? null,
      roundId: row.roundId,
      rakeBase: row.rakeBase,
      bps: row.bps,
      amount: row.amount,
      createdAt: row.createdAt,
    })),
  };
}
