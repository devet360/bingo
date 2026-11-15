import {
  SupportMessageAuthor,
  SupportTicketStatus,
  SupportTopic,
  UserRole,
  UserStatus,
  type Prisma,
  type SupportMessage,
  type SupportTicket,
} from '@prisma/client';
import { env } from '../config/env';
import { Errors } from '../lib/errors';
import { referralCode } from '../lib/ids';
import { prisma } from '../lib/prisma';
import { isUniqueViolation, runTransaction, withTxRetry } from '../lib/tx';

export const SUPPORT_PAGE_SIZE = 25;
const DEFAULT_SUBJECT = 'Support request';
const MAX_BODY = 4000;
const MAX_OPEN_TICKETS_PER_HOUR = 5;
const DELIVERY_MAX_ATTEMPTS = 5;

function preview(value: string | null | undefined, limit = 140): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function cleanBody(value: string): string {
  return value.trim().slice(0, MAX_BODY);
}

// ─────────────────────────────── operating hours ───────────────────────────────

export interface SupportHours {
  startHour: number;
  endHour: number;
  timezone: string;
}

export function getSupportHours(): SupportHours {
  return {
    startHour: env.SUPPORT_HOURS_START,
    endHour: env.SUPPORT_HOURS_END,
    timezone: env.SUPPORT_TIMEZONE,
  };
}

/** Start === end means 24/7. A window may wrap midnight (e.g. 20 → 04). */
export function isSupportOnline(at: Date = new Date()): boolean {
  const { startHour, endHour, timezone } = getSupportHours();
  if (startHour === endHour) return true;
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(at),
    );
  } catch {
    hour = at.getUTCHours();
  }
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

export function supportHoursLabel(): string {
  const { startHour, endHour } = getSupportHours();
  const pad = (value: number) => `${String(value).padStart(2, '0')}:00`;
  return `${pad(startHour)}–${pad(endHour)}`;
}

// ─────────────────────────────── notifications ───────────────────────────────

/**
 * Texts the player bot pushes to staff Telegram accounts (worker sweep). An
 * assigned ticket only notifies its assignee so the queue stays quiet.
 */
async function notifyStaff(
  tx: Prisma.TransactionClient,
  ticket: SupportTicket,
  playerName: string,
  summary: string,
): Promise<void> {
  const recipients = await tx.user.findMany({
    where: {
      role: { in: [UserRole.SUPPORT, UserRole.SUPER_ADMIN] },
      status: UserStatus.ACTIVE,
      telegramId: { not: null },
      ...(ticket.assigneeId ? { id: ticket.assigneeId } : {}),
    },
    select: { id: true },
  });
  if (recipients.length === 0) return;
  await tx.notification.createMany({
    data: recipients.map((recipient) => ({
      userId: recipient.id,
      type: 'SUPPORT_MESSAGE',
      title: `Support ${ticket.code}`,
      body: `${playerName}: ${summary}`,
      data: { ticketId: ticket.id, code: ticket.code, topic: ticket.topic },
    })),
  });
}

// ─────────────────────────────── player side ───────────────────────────────

export interface CreateTicketInput {
  playerId: string;
  telegramChatId: bigint;
  topic: SupportTopic;
  locale: 'en' | 'am';
  body?: string;
  mediaAssetId?: string;
  telegramMessageId?: bigint;
}

export async function findActiveSupportTicket(playerId: string): Promise<SupportTicket | null> {
  return prisma.supportTicket.findFirst({
    where: { playerId, status: { in: [SupportTicketStatus.OPEN, SupportTicketStatus.PENDING] } },
    orderBy: { lastMessageAt: 'desc' },
  });
}

/**
 * Opens (or resumes) the player's live ticket. The partial unique index on
 * OPEN/PENDING tickets is the real guard; a concurrent press folds into the
 * existing thread instead of failing.
 */
export async function createSupportTicket(input: CreateTicketInput): Promise<{
  ticket: SupportTicket;
  message: SupportMessage | null;
  created: boolean;
}> {
  // An empty body is allowed: pressing "Talk to an agent" opens the thread
  // before the player has typed anything.
  const body = cleanBody(input.body ?? '');

  const player = await prisma.user.findUnique({
    where: { id: input.playerId },
    select: { id: true, displayName: true, role: true, status: true },
  });
  if (!player) throw Errors.notFound('User');
  if (player.role !== UserRole.PLAYER) {
    throw Errors.forbidden('Support chats are for players', 'SUPPORT_PLAYERS_ONLY');
  }
  if (player.status === UserStatus.BANNED || player.status === UserStatus.DELETED) {
    throw Errors.forbidden('This account cannot open support chats', 'ACCOUNT_CLOSED');
  }

  const active = await findActiveSupportTicket(player.id);
  if (active) return { ticket: active, message: null, created: false };

  const recent = await prisma.supportTicket.count({
    where: { playerId: player.id, createdAt: { gte: new Date(Date.now() - 60 * 60_000) } },
  });
  if (recent >= MAX_OPEN_TICKETS_PER_HOUR) {
    throw Errors.tooManyRequests('You opened several support chats recently. Please wait for a reply.');
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await withTxRetry(() =>
        runTransaction(async (tx) => {
          const existing = await tx.supportTicket.findFirst({
            where: {
              playerId: player.id,
              status: { in: [SupportTicketStatus.OPEN, SupportTicketStatus.PENDING] },
            },
          });
          if (existing) return { ticket: existing, message: null, created: false };

          const ticket = await tx.supportTicket.create({
            data: {
              code: `SUP-${referralCode(6)}`,
              playerId: player.id,
              telegramChatId: input.telegramChatId,
              topic: input.topic,
              locale: input.locale,
              subject: body ? preview(body, 120) : DEFAULT_SUBJECT,
            },
          });
          const message =
            body || input.mediaAssetId
              ? await tx.supportMessage.create({
                  data: {
                    ticketId: ticket.id,
                    author: SupportMessageAuthor.PLAYER,
                    authorUserId: player.id,
                    body,
                    mediaAssetId: input.mediaAssetId ?? null,
                    telegramMessageId: input.telegramMessageId ?? null,
                  },
                })
              : null;
          // An empty ticket (player pressed "Talk to an agent" but has not
          // typed yet) stays quiet; the first message triggers the push.
          if (message) {
            await notifyStaff(tx, ticket, player.displayName, preview(body || '[screenshot]'));
          }
          return { ticket, message, created: true };
        }),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Either the code collided (retry with a new one) or another request
      // opened the ticket first (return it).
      const race = await findActiveSupportTicket(player.id);
      if (race) return { ticket: race, message: null, created: false };
    }
  }
  throw Errors.internal('Could not allocate a support ticket');
}

export async function appendPlayerMessage(input: {
  ticketId: string;
  playerId: string;
  body: string;
  mediaAssetId?: string;
  telegramMessageId?: bigint;
}): Promise<{ ticket: SupportTicket; message: SupportMessage }> {
  const body = cleanBody(input.body);
  if (!body && !input.mediaAssetId) throw Errors.badRequest('Message is empty', 'MESSAGE_EMPTY');

  try {
    return await withTxRetry(() =>
      runTransaction(async (tx) => {
        const ticket = await tx.supportTicket.findUnique({
          where: { id: input.ticketId },
          include: { player: { select: { displayName: true } } },
        });
        if (!ticket) throw Errors.notFound('Ticket');
        if (ticket.playerId !== input.playerId) {
          throw Errors.forbidden('This conversation belongs to another player', 'TICKET_FORBIDDEN');
        }
        if (ticket.status === SupportTicketStatus.CLOSED) {
          throw Errors.conflict('This conversation is closed. Open a new chat.', 'TICKET_CLOSED');
        }
        if (ticket.status === SupportTicketStatus.RESOLVED) {
          const other = await tx.supportTicket.findFirst({
            where: {
              playerId: input.playerId,
              status: { in: [SupportTicketStatus.OPEN, SupportTicketStatus.PENDING] },
              id: { not: ticket.id },
            },
            select: { id: true },
          });
          if (other) {
            throw Errors.conflict('Another support conversation is open', 'TICKET_ACTIVE');
          }
        }

        const message = await tx.supportMessage.create({
          data: {
            ticketId: ticket.id,
            author: SupportMessageAuthor.PLAYER,
            authorUserId: input.playerId,
            body,
            mediaAssetId: input.mediaAssetId ?? null,
            telegramMessageId: input.telegramMessageId ?? null,
          },
        });
        const updated = await tx.supportTicket.update({
          where: { id: ticket.id },
          data: {
            status: SupportTicketStatus.OPEN,
            unreadForStaff: { increment: 1 },
            unreadForPlayer: 0,
            lastMessageAt: new Date(),
            lastPlayerMessageAt: new Date(),
            resolvedAt: null,
            ...(ticket.subject === DEFAULT_SUBJECT && body
              ? { subject: preview(body, 120) }
              : {}),
          },
        });
        await notifyStaff(
          tx,
          updated,
          ticket.player.displayName,
          preview(body || '[screenshot]'),
        );
        return { ticket: updated, message };
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const other = await findActiveSupportTicket(input.playerId);
      if (other) throw Errors.conflict('Another support conversation is open', 'TICKET_ACTIVE');
    }
    throw error;
  }
}

/** Player-initiated close: the thread becomes RESOLVED; a new message reopens it. */
export async function closeTicketByPlayer(input: {
  ticketId: string;
  playerId: string;
  systemBody: string;
}): Promise<{ ticket: SupportTicket; message: SupportMessage | null }> {
  return runTransaction(async (tx) => {
    const ticket = await tx.supportTicket.findUnique({ where: { id: input.ticketId } });
    if (!ticket) throw Errors.notFound('Ticket');
    if (ticket.playerId !== input.playerId) {
      throw Errors.forbidden('This conversation belongs to another player', 'TICKET_FORBIDDEN');
    }
    if (ticket.status === SupportTicketStatus.RESOLVED) return { ticket, message: null };
    if (ticket.status === SupportTicketStatus.CLOSED) {
      throw Errors.conflict('This conversation is closed', 'TICKET_CLOSED');
    }

    const message = await tx.supportMessage.create({
      data: {
        ticketId: ticket.id,
        author: SupportMessageAuthor.SYSTEM,
        body: cleanBody(input.systemBody),
      },
    });
    const updated = await tx.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: SupportTicketStatus.RESOLVED,
        resolvedAt: new Date(),
        lastMessageAt: new Date(),
      },
    });
    return { ticket: updated, message };
  });
}

export interface PlayerSupportSnapshot {
  wallet: {
    available: bigint;
    bonus: bigint;
    escrow: bigint;
    locked: bigint;
  } | null;
  deposits: Array<{
    code: string;
    amount: bigint;
    method: string;
    status: string;
    createdAt: Date;
  }>;
  withdrawals: Array<{
    amount: bigint;
    netAmount: bigint;
    method: string;
    status: string;
    createdAt: Date;
  }>;
}

/** Self-service context shown in the bot's "My account" view. */
export async function getPlayerSupportSnapshot(playerId: string): Promise<PlayerSupportSnapshot> {
  const [wallet, deposits, withdrawals] = await Promise.all([
    prisma.wallet.findUnique({
      where: { userId: playerId },
      select: { available: true, bonus: true, escrow: true, locked: true },
    }),
    prisma.depositRequest.findMany({
      where: { playerId, status: { in: ['PENDING', 'PROCESSING'] } },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { code: true, amount: true, method: true, status: true, createdAt: true },
    }),
    prisma.withdrawalRequest.findMany({
      where: { playerId, status: { in: ['ESCROWED', 'PROCESSING'] } },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { amount: true, netAmount: true, method: true, status: true, createdAt: true },
    }),
  ]);
  return { wallet, deposits, withdrawals };
}

// ─────────────────────────────── staff side ───────────────────────────────

export interface SupportTicketFilter {
  statuses?: SupportTicketStatus[];
  assignee?: 'me' | 'unassigned' | string;
  query?: string;
  page?: number;
}

export async function listSupportTickets(filter: SupportTicketFilter, viewerId: string) {
  const query = preview(filter.query, 64);
  const where: Prisma.SupportTicketWhereInput = {
    ...(filter.statuses?.length ? { status: { in: filter.statuses } } : {}),
    ...(filter.assignee === 'me'
      ? { assigneeId: viewerId }
      : filter.assignee === 'unassigned'
        ? { assigneeId: null }
        : filter.assignee
          ? { assigneeId: filter.assignee }
          : {}),
    ...(query
      ? {
          OR: [
            { code: { contains: query, mode: 'insensitive' } },
            { subject: { contains: query, mode: 'insensitive' } },
            {
              player: {
                OR: [
                  { displayName: { contains: query, mode: 'insensitive' } },
                  { phone: { contains: query } },
                  { telegramUsername: { contains: query, mode: 'insensitive' } },
                ],
              },
            },
          ],
        }
      : {}),
  };
  const page = Math.max(0, filter.page ?? 0);
  const [total, tickets] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip: page * SUPPORT_PAGE_SIZE,
      take: SUPPORT_PAGE_SIZE,
      include: {
        player: {
          select: { id: true, displayName: true, phone: true, telegramUsername: true },
        },
        assignee: { select: { id: true, displayName: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { author: true, body: true, mediaAssetId: true, createdAt: true },
        },
      },
    }),
  ]);
  return { total, tickets };
}

export async function getSupportTicketDetail(ticketId: string) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      player: {
        select: {
          id: true,
          displayName: true,
          phone: true,
          telegramUsername: true,
          locale: true,
          status: true,
          createdAt: true,
        },
      },
      assignee: { select: { id: true, displayName: true } },
      messages: { orderBy: { createdAt: 'asc' }, take: 300 },
    },
  });
  if (!ticket) throw Errors.notFound('Ticket');

  // Opening the conversation in the dashboard is the staff "read" marker.
  if (ticket.unreadForStaff > 0) {
    await prisma.supportTicket.updateMany({
      where: { id: ticket.id, unreadForStaff: { gt: 0 } },
      data: { unreadForStaff: 0 },
    });
    ticket.unreadForStaff = 0;
  }

  const [wallet, deposits, withdrawals] = await Promise.all([
    prisma.wallet.findUnique({
      where: { userId: ticket.playerId },
      select: { available: true, bonus: true, escrow: true, locked: true },
    }),
    prisma.depositRequest.findMany({
      where: { playerId: ticket.playerId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, code: true, amount: true, status: true, method: true, createdAt: true },
    }),
    prisma.withdrawalRequest.findMany({
      where: { playerId: ticket.playerId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        amount: true,
        netAmount: true,
        status: true,
        method: true,
        createdAt: true,
      },
    }),
  ]);
  return { ticket, wallet, deposits, withdrawals };
}

export async function claimSupportTicket(ticketId: string, staffUserId: string): Promise<SupportTicket> {
  return runTransaction(async (tx) => {
    const ticket = await tx.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw Errors.notFound('Ticket');
    if (
      ticket.status !== SupportTicketStatus.OPEN &&
      ticket.status !== SupportTicketStatus.PENDING
    ) {
      throw Errors.conflict('This conversation is already closed', 'TICKET_CLOSED');
    }
    if (ticket.assigneeId && ticket.assigneeId !== staffUserId) {
      throw Errors.conflict('Another agent already owns this conversation', 'TICKET_ASSIGNED');
    }
    return tx.supportTicket.update({
      where: { id: ticket.id },
      data: { assigneeId: staffUserId, claimedAt: ticket.claimedAt ?? new Date() },
    });
  });
}

/**
 * Staff reply. It claims the ticket when unassigned and leaves the thread
 * PENDING (waiting for the player). Delivery to Telegram happens in the
 * support-bot process so the API does not need the support bot's credentials.
 */
export async function replyToTicketAsStaff(input: {
  ticketId: string;
  staffUserId: string;
  body: string;
}): Promise<{ ticket: SupportTicket; message: SupportMessage }> {
  const body = cleanBody(input.body);
  if (!body) throw Errors.badRequest('Write a reply first', 'MESSAGE_EMPTY');

  return withTxRetry(() =>
    runTransaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { id: input.ticketId } });
      if (!ticket) throw Errors.notFound('Ticket');
      if (ticket.status === SupportTicketStatus.CLOSED) {
        throw Errors.conflict('This conversation is closed', 'TICKET_CLOSED');
      }
      if (ticket.status === SupportTicketStatus.RESOLVED) {
        const other = await tx.supportTicket.findFirst({
          where: {
            playerId: ticket.playerId,
            status: { in: [SupportTicketStatus.OPEN, SupportTicketStatus.PENDING] },
            id: { not: ticket.id },
          },
          select: { id: true },
        });
        if (other) {
          throw Errors.conflict("The player has another open conversation", 'TICKET_ACTIVE');
        }
      }

      const message = await tx.supportMessage.create({
        data: {
          ticketId: ticket.id,
          author: SupportMessageAuthor.STAFF,
          authorUserId: input.staffUserId,
          body,
        },
      });
      const claimed = ticket.assigneeId === null;
      const updated = await tx.supportTicket.update({
        where: { id: ticket.id },
        data: {
          status: SupportTicketStatus.PENDING,
          resolvedAt: null,
          unreadForPlayer: { increment: 1 },
          lastMessageAt: new Date(),
          lastStaffMessageAt: new Date(),
          ...(claimed ? { assigneeId: input.staffUserId, claimedAt: new Date() } : {}),
        },
      });
      return { ticket: updated, message };
    }),
  );
}

const RESOLVED_SYSTEM_BODY: Record<string, string> = {
  en: 'This conversation has been marked as resolved. Send a message to reopen it.',
  am: 'ይህ ውይይት እንደተፈታ ተመዝግቧል። እንደገና ለመክፈት መልእክት ይላኩ።',
};

export async function resolveSupportTicket(
  ticketId: string,
  staffUserId: string,
): Promise<{ ticket: SupportTicket; message: SupportMessage | null }> {
  return runTransaction(async (tx) => {
    const ticket = await tx.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw Errors.notFound('Ticket');
    if (ticket.status === SupportTicketStatus.RESOLVED || ticket.status === SupportTicketStatus.CLOSED) {
      return { ticket, message: null };
    }

    const message = await tx.supportMessage.create({
      data: {
        ticketId: ticket.id,
        author: SupportMessageAuthor.SYSTEM,
        authorUserId: staffUserId,
        body: RESOLVED_SYSTEM_BODY[ticket.locale] ?? RESOLVED_SYSTEM_BODY.en!,
      },
    });
    const updated = await tx.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: SupportTicketStatus.RESOLVED,
        resolvedAt: new Date(),
        unreadForPlayer: { increment: 1 },
        lastMessageAt: new Date(),
        ...(ticket.assigneeId ? {} : { assigneeId: staffUserId, claimedAt: new Date() }),
      },
    });
    return { ticket: updated, message };
  });
}

// ─────────────────────────── telegram delivery queue ───────────────────────────

/** Pending staff/system replies for the support bot to push. */
export async function pendingSupportDeliveries(limit = 10) {
  return prisma.supportMessage.findMany({
    where: {
      author: { in: [SupportMessageAuthor.STAFF, SupportMessageAuthor.SYSTEM] },
      deliveredAt: null,
      deliveryAttempts: { lt: DELIVERY_MAX_ATTEMPTS },
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: {
      ticket: { select: { id: true, code: true, telegramChatId: true } },
      authorUser: { select: { displayName: true } },
    },
  });
}

export async function markSupportDeliverySent(messageId: string): Promise<void> {
  await prisma.supportMessage.update({
    where: { id: messageId },
    data: { deliveredAt: new Date(), deliveryError: null },
  });
}

export async function markSupportDeliveryFailed(messageId: string, error: string): Promise<void> {
  await prisma.supportMessage.update({
    where: { id: messageId },
    data: {
      deliveryAttempts: { increment: 1 },
      deliveryError: error.slice(0, 300),
    },
  });
}

export { DELIVERY_MAX_ATTEMPTS };
