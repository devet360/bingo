import { DepositStatus, WithdrawalStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { expireWithdrawal } from './withdrawals';
import { sendTelegramMessage } from './telegramNotify';

export interface SweepResult {
  expiredWithdrawals: number;
  expiredDeposits: number;
  telegramPushes: number;
}

const PUSH_WINDOW_MS = 24 * 60 * 60_000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Pushes recent in-app notifications to players who signed up via Telegram. */
async function flushTelegramNotifications(): Promise<number> {
  const pending = await prisma.notification.findMany({
    where: {
      telegramSentAt: null,
      createdAt: { gte: new Date(Date.now() - PUSH_WINDOW_MS) },
      user: { telegramId: { not: null } },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: {
      id: true,
      title: true,
      body: true,
      user: { select: { telegramId: true } },
    },
  });

  let sent = 0;
  for (const notification of pending) {
    const telegramId = notification.user.telegramId;
    if (!telegramId) continue;
    const delivered = await sendTelegramMessage(
      telegramId.toString(),
      `<b>${escapeHtml(notification.title)}</b>\n${escapeHtml(notification.body)}`,
    );
    if (delivered) {
      await prisma.notification.update({
        where: { id: notification.id },
        data: { telegramSentAt: new Date() },
      });
      sent += 1;
    }
  }
  return sent;
}

/**
 * Durable housekeeping. Runs from the BullMQ worker when Redis is configured,
 * otherwise from an in-process interval. Every action is idempotent.
 */
export async function maintenanceSweep(): Promise<SweepResult> {
  const now = new Date();

  const dueWithdrawals = await prisma.withdrawalRequest.findMany({
    where: { status: WithdrawalStatus.ESCROWED, expiresAt: { lte: now } },
    select: { id: true },
    take: 100,
  });
  for (const withdrawal of dueWithdrawals) {
    await expireWithdrawal(withdrawal.id);
  }

  const expiredDeposits = await prisma.depositRequest.updateMany({
    where: { status: DepositStatus.PENDING, expiresAt: { lte: now } },
    data: { status: DepositStatus.EXPIRED },
  });

  const telegramPushes = await flushTelegramNotifications();

  return {
    expiredWithdrawals: dueWithdrawals.length,
    expiredDeposits: expiredDeposits.count,
    telegramPushes,
  };
}
