import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { User } from '@prisma/client';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { AppError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { updateLocale } from '../services/users';
import { storeMedia } from '../services/media';
import {
  appendPlayerMessage,
  closeTicketByPlayer,
  createSupportTicket,
  findActiveSupportTicket,
  getPlayerSupportSnapshot,
  isSupportOnline,
  markSupportDeliveryFailed,
  markSupportDeliverySent,
  pendingSupportDeliveries,
  supportHoursLabel,
} from '../services/support';
import { resolveBotLocale } from '../bot/messages';
import { supportCopy, type SupportLocale } from './copy';

const token = env.SUPPORT_BOT_TOKEN;
if (!token) {
  logger.fatal('SUPPORT_BOT_TOKEN is not set; the support bot cannot start');
  process.exit(1);
}

const bot = new Bot(token);

// ─────────────────────────────── helpers ───────────────────────────────

type PlayerUser = Pick<
  User,
  'id' | 'displayName' | 'phone' | 'phoneVerifiedAt' | 'locale' | 'role' | 'status' | 'telegramId'
>;

function localeFor(ctx: Context, stored?: string | null): SupportLocale {
  return resolveBotLocale(ctx.from?.language_code, stored) as SupportLocale;
}

function etb(minor: bigint): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = (absolute / 100n).toLocaleString('en-US');
  const cents = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${cents}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function walletUrl(): string | null {
  const base = env.TELEGRAM_WEBAPP_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/wallet`;
}

function menuText(locale: SupportLocale): string {
  const copy = supportCopy[locale];
  const note = isSupportOnline() ? '' : copy.offlineNote(supportHoursLabel());
  return `${copy.menuTitle}${note}`;
}

function menuKeyboard(locale: SupportLocale): InlineKeyboard {
  const buttons = supportCopy[locale].buttons;
  return new InlineKeyboard()
    .text(buttons.deposit, 'su:topic:DEPOSIT')
    .text(buttons.withdrawal, 'su:topic:WITHDRAWAL')
    .row()
    .text(buttons.account, 'su:account')
    .text(buttons.faq, 'su:faq')
    .row()
    .text(buttons.agent, 'su:chat:OTHER')
    .row()
    .text(buttons.language, 'su:lang');
}

function backKeyboard(locale: SupportLocale, extra?: InlineKeyboard): InlineKeyboard {
  const keyboard = extra ?? new InlineKeyboard();
  if (extra) keyboard.row();
  return keyboard.text(supportCopy[locale].buttons.back, 'su:menu');
}

function topicKeyboard(locale: SupportLocale, topic: 'DEPOSIT' | 'WITHDRAWAL'): InlineKeyboard {
  const copy = supportCopy[locale];
  const keyboard = new InlineKeyboard();
  const url = walletUrl();
  if (url) keyboard.webApp(copy.buttons.wallet, url).row();
  keyboard.text(copy.buttons.agent, `su:chat:${topic}`).row();
  keyboard.text(copy.buttons.back, 'su:menu');
  return keyboard;
}

function faqKeyboard(locale: SupportLocale): InlineKeyboard {
  const copy = supportCopy[locale];
  return new InlineKeyboard()
    .text(copy.faqButtons.deposit, 'su:faq:deposit')
    .text(copy.faqButtons.withdrawal, 'su:faq:withdrawal')
    .row()
    .text(copy.faqButtons.fees, 'su:faq:fees')
    .text(copy.faqButtons.account, 'su:faq:account')
    .row()
    .text(copy.buttons.back, 'su:menu');
}

function chatKeyboard(locale: SupportLocale): InlineKeyboard {
  const copy = supportCopy[locale];
  return new InlineKeyboard()
    .text(copy.buttons.endChat, 'su:end')
    .row()
    .text(copy.buttons.menu, 'su:menu');
}

async function sendScreen(ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const markup = keyboard ? { reply_markup: keyboard } : {};
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, markup);
      return;
    } catch {
      // The message may be a photo or too old to edit; fall back to a new one.
    }
  }
  await ctx.reply(text, markup);
}

async function findPlayer(ctx: Context): Promise<PlayerUser | null> {
  if (!ctx.from) return null;
  return prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from.id) },
    select: {
      id: true,
      displayName: true,
      phone: true,
      phoneVerifiedAt: true,
      locale: true,
      role: true,
      status: true,
      telegramId: true,
    },
  });
}

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private';
}

async function sendUnregistered(ctx: Context): Promise<void> {
  const username = env.TELEGRAM_BOT_USERNAME;
  const keyboard = username
    ? new InlineKeyboard().url(`Open @${username}`, `https://t.me/${username}`)
    : undefined;
  await ctx.reply(supportCopy.en.unregistered(username), { reply_markup: keyboard });
}

async function sendStaff(ctx: Context, role: User['role']): Promise<void> {
  const base = env.TELEGRAM_WEBAPP_URL;
  const path =
    role === 'SUPER_ADMIN' ? '/admin' : role === 'SUPPORT' ? '/support' : '/agent';
  const keyboard = base
    ? new InlineKeyboard().webApp('Open dashboard', `${base.replace(/\/+$/, '')}${path}`)
    : undefined;
  await ctx.reply(supportCopy.en.staff, { reply_markup: keyboard });
}

async function requirePlayer(
  ctx: Context,
): Promise<{ player: PlayerUser; locale: SupportLocale } | null> {
  if (!isPrivateChat(ctx)) {
    await ctx.reply('Please message me in a private chat.');
    return null;
  }
  const player = await findPlayer(ctx);
  if (!player) {
    await sendUnregistered(ctx);
    return null;
  }
  if (player.role !== 'PLAYER') {
    await sendStaff(ctx, player.role);
    return null;
  }
  return { player, locale: localeFor(ctx, player.locale) };
}

// ─────────────────────────────── rate limit ───────────────────────────────

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_MESSAGES = 15;
const rate = new Map<number, { start: number; count: number; warnedAt: number }>();

function allowMessage(chatId: number): boolean {
  const now = Date.now();
  const entry = rate.get(chatId);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    rate.set(chatId, { start: now, count: 1, warnedAt: entry?.warnedAt ?? 0 });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_MAX_MESSAGES;
}

function shouldWarn(chatId: number): boolean {
  const entry = rate.get(chatId);
  if (!entry) return false;
  if (Date.now() - entry.warnedAt < RATE_WINDOW_MS) return false;
  entry.warnedAt = Date.now();
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 10 * RATE_WINDOW_MS;
  for (const [chatId, entry] of rate) {
    if (entry.start < cutoff) rate.delete(chatId);
  }
}, 5 * RATE_WINDOW_MS).unref();

// ─────────────────────────────── screens ───────────────────────────────

async function openMenu(ctx: Context, locale: SupportLocale): Promise<void> {
  await sendScreen(ctx, menuText(locale), menuKeyboard(locale));
}

async function openTopic(
  ctx: Context,
  locale: SupportLocale,
  topic: 'DEPOSIT' | 'WITHDRAWAL',
): Promise<void> {
  const copy = supportCopy[locale];
  const text = topic === 'DEPOSIT' ? copy.depositBody : copy.withdrawalBody;
  const title = topic === 'DEPOSIT' ? copy.depositTitle : copy.withdrawalTitle;
  await sendScreen(ctx, `${title}\n\n${text}`, topicKeyboard(locale, topic));
}

async function openFaq(ctx: Context, locale: SupportLocale): Promise<void> {
  const copy = supportCopy[locale];
  await sendScreen(ctx, `${copy.faqTitle}\n\n${copy.faqBody}`, faqKeyboard(locale));
}

function statusLabel(locale: SupportLocale, status: string): string {
  const labels: Record<string, Record<SupportLocale, string>> = {
    PENDING: { en: 'waiting for an agent', am: 'ወኪል በመጠበቅ ላይ' },
    PROCESSING: { en: 'agent is processing', am: 'ወኪሉ በሂደት ላይ' },
    ESCROWED: { en: 'waiting for an agent', am: 'ወኪል በመጠበቅ ላይ' },
  };
  return labels[status]?.[locale] ?? status.toLowerCase().replaceAll('_', ' ');
}

async function openAccount(ctx: Context, locale: SupportLocale, player: PlayerUser): Promise<void> {
  const copy = supportCopy[locale];
  const snapshot = await getPlayerSupportSnapshot(player.id);
  const text = `${copy.accountTitle}\n\n${copy.accountBody({
    name: player.displayName,
    phone: player.phone ?? '—',
    verified: Boolean(player.phoneVerifiedAt),
    available: snapshot.wallet ? etb(snapshot.wallet.available) : '0.00',
    bonus: snapshot.wallet ? etb(snapshot.wallet.bonus) : '0.00',
    locked: snapshot.wallet ? etb(snapshot.wallet.locked) : '0.00',
    deposits: snapshot.deposits.map(
      (deposit) =>
        `${deposit.code} · ${etb(deposit.amount)} ETB · ${statusLabel(locale, deposit.status)}`,
    ),
    withdrawals: snapshot.withdrawals.map(
      (withdrawal) =>
        `${etb(withdrawal.netAmount)} ETB · ${statusLabel(locale, withdrawal.status)}`,
    ),
  })}`;
  const keyboard = new InlineKeyboard();
  const url = walletUrl();
  if (url) keyboard.webApp(copy.buttons.wallet, url).row();
  keyboard.text(copy.buttons.agent, 'su:chat:OTHER').row();
  keyboard.text(copy.buttons.back, 'su:menu');
  await sendScreen(ctx, text, keyboard);
}

async function startChat(
  ctx: Context,
  player: PlayerUser,
  locale: SupportLocale,
  topic: 'DEPOSIT' | 'WITHDRAWAL' | 'ACCOUNT' | 'PAYMENTS' | 'OTHER',
): Promise<void> {
  const copy = supportCopy[locale];
  if (!ctx.chat) return;
  try {
    const { ticket, created } = await createSupportTicket({
      playerId: player.id,
      telegramChatId: BigInt(ctx.chat.id),
      topic,
      locale,
    });
    const text = created
      ? isSupportOnline()
        ? copy.agentOnline(ticket.code)
        : copy.agentOffline(ticket.code, supportHoursLabel())
      : copy.agentResumed(ticket.code);
    await sendScreen(ctx, text, chatKeyboard(locale));
  } catch (error) {
    if (error instanceof AppError && error.status === 429) {
      await ctx.reply(copy.rateLimited);
      return;
    }
    if (error instanceof AppError && error.status === 403) {
      await ctx.reply(copy.error);
      return;
    }
    throw error;
  }
}

// ─────────────────────────────── handlers ───────────────────────────────

bot.command(['start', 'menu'], async (ctx) => {
  const identity = await requirePlayer(ctx);
  if (!identity) return;
  const payload = (ctx.match ?? '').trim().toLowerCase();
  if (payload.includes('deposit')) {
    await openTopic(ctx, identity.locale, 'DEPOSIT');
    return;
  }
  if (payload.includes('withdraw')) {
    await openTopic(ctx, identity.locale, 'WITHDRAWAL');
    return;
  }
  await ctx.reply(supportCopy[identity.locale].welcome(identity.player.displayName));
  await openMenu(ctx, identity.locale);
});

bot.command('help', async (ctx) => {
  const identity = await requirePlayer(ctx);
  if (!identity) return;
  await openFaq(ctx, identity.locale);
});

bot.command('ticket', async (ctx) => {
  const identity = await requirePlayer(ctx);
  if (!identity) return;
  await startChat(ctx, identity.player, identity.locale, 'OTHER');
});

bot.command('end', async (ctx) => {
  const identity = await requirePlayer(ctx);
  if (!identity) return;
  const ticket = await findActiveSupportTicket(identity.player.id);
  if (!ticket) {
    await ctx.reply(supportCopy[identity.locale].chatClosed);
    return;
  }
  await closeTicketByPlayer({
    ticketId: ticket.id,
    playerId: identity.player.id,
    systemBody:
      identity.locale === 'am'
        ? 'ተጫዋቹ ውይይቱን ጨርሷል።'
        : 'The player ended this conversation.',
  });
  await ctx.reply(supportCopy[identity.locale].chatClosed);
});

bot.on('callback_query:data', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const identity = await requirePlayer(ctx);
  if (!identity) return;
  const { player, locale } = identity;
  const data = ctx.callbackQuery.data;
  const copy = supportCopy[locale];

  if (data === 'su:menu') {
    await openMenu(ctx, locale);
    return;
  }
  if (data === 'su:lang') {
    const next: SupportLocale = locale === 'en' ? 'am' : 'en';
    await updateLocale(player.id, next);
    await sendScreen(
      ctx,
      `${supportCopy[next].menuTitle}${
        isSupportOnline() ? '' : supportCopy[next].offlineNote(supportHoursLabel())
      }`,
      menuKeyboard(next),
    );
    return;
  }
  if (data === 'su:account') {
    await openAccount(ctx, locale, player);
    return;
  }
  if (data === 'su:faq') {
    await openFaq(ctx, locale);
    return;
  }
  if (data.startsWith('su:faq:')) {
    const key = data.slice('su:faq:'.length) as 'deposit' | 'withdrawal' | 'fees' | 'account';
    const body = copy.faq[key];
    if (!body) return;
    const keyboard = new InlineKeyboard()
      .text(copy.buttons.agent, 'su:chat:OTHER')
      .row()
      .text(copy.buttons.back, 'su:faq');
    await sendScreen(ctx, body, keyboard);
    return;
  }
  if (data.startsWith('su:topic:')) {
    const topic = data.slice('su:topic:'.length);
    if (topic === 'DEPOSIT' || topic === 'WITHDRAWAL') {
      await openTopic(ctx, locale, topic);
    }
    return;
  }
  if (data === 'su:chat' || data.startsWith('su:chat:')) {
    const raw = data.startsWith('su:chat:') ? data.slice('su:chat:'.length) : 'OTHER';
    const topic =
      raw === 'DEPOSIT' || raw === 'WITHDRAWAL' || raw === 'ACCOUNT' || raw === 'PAYMENTS'
        ? raw
        : 'OTHER';
    await startChat(ctx, player, locale, topic);
    return;
  }
  if (data === 'su:end') {
    const ticket = await findActiveSupportTicket(player.id);
    if (!ticket) {
      await sendScreen(ctx, copy.chatClosed, new InlineKeyboard().text(copy.buttons.menu, 'su:menu'));
      return;
    }
    await closeTicketByPlayer({
      ticketId: ticket.id,
      playerId: player.id,
      systemBody:
        locale === 'am' ? 'ተጫዋቹ ውይይቱን ጨርሷል።' : 'The player ended this conversation.',
    });
    await sendScreen(ctx, copy.chatClosed, new InlineKeyboard().text(copy.buttons.menu, 'su:menu'));
  }
});

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  if (!ctx.chat) return;
  if (!allowMessage(ctx.chat.id)) {
    if (shouldWarn(ctx.chat.id)) {
      await ctx.reply(supportCopy[localeFor(ctx)].rateLimited);
    }
    return;
  }
  const identity = await requirePlayer(ctx);
  if (!identity) return;
  const { player, locale } = identity;
  if (!text) {
    await ctx.reply(supportCopy[locale].unsupported);
    return;
  }

  const ticket = await findActiveSupportTicket(player.id);
  if (!ticket) {
    await ctx.reply(supportCopy[locale].waitingHint);
    await openMenu(ctx, locale);
    return;
  }

  try {
    await appendPlayerMessage({
      ticketId: ticket.id,
      playerId: player.id,
      body: text,
      telegramMessageId: BigInt(ctx.message.message_id),
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'TICKET_CLOSED') {
      await ctx.reply(supportCopy[locale].chatClosed);
      return;
    }
    if (error instanceof AppError && error.code === 'TICKET_ACTIVE') {
      const active = await findActiveSupportTicket(player.id);
      await ctx.reply(
        supportCopy[locale].agentResumed(active?.code ?? ''),
      );
      return;
    }
    if (error instanceof AppError && error.status === 429) {
      await ctx.reply(supportCopy[locale].rateLimited);
      return;
    }
    throw error;
  }
});

bot.on('message:photo', async (ctx) => {
  if (!ctx.chat) return;
  if (!allowMessage(ctx.chat.id)) {
    if (shouldWarn(ctx.chat.id)) {
      await ctx.reply(supportCopy[localeFor(ctx)].rateLimited);
    }
    return;
  }
  const identity = await requirePlayer(ctx);
  if (!identity) return;
  const { player, locale } = identity;
  const copy = supportCopy[locale];
  const ticket = await findActiveSupportTicket(player.id);
  if (!ticket) {
    await ctx.reply(copy.photoHint);
    return;
  }

  try {
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    if (!largest) {
      await ctx.reply(copy.photoFailed);
      return;
    }
    const file = await ctx.api.getFile(largest.file_id);
    if (!file.file_path) {
      await ctx.reply(copy.photoFailed);
      return;
    }
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!response.ok) {
      await ctx.reply(copy.photoFailed);
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > env.MEDIA_MAX_BYTES) {
      await ctx.reply(copy.photoTooLarge);
      return;
    }
    const asset = await storeMedia({
      base64: buffer.toString('base64'),
      uploadedById: player.id,
      purpose: 'support',
      originalName: `telegram-${ctx.message.message_id}.jpg`,
    });
    await appendPlayerMessage({
      ticketId: ticket.id,
      playerId: player.id,
      body: ctx.message.caption?.trim() ?? '',
      mediaAssetId: asset.id,
      telegramMessageId: BigInt(ctx.message.message_id),
    });
  } catch (error) {
    if (error instanceof AppError && error.status === 400) {
      await ctx.reply(copy.photoTooLarge);
      return;
    }
    if (error instanceof AppError && error.code === 'TICKET_CLOSED') {
      await ctx.reply(copy.chatClosed);
      return;
    }
    logger.warn({ err: error }, 'support bot photo failed');
    await ctx.reply(copy.photoFailed);
  }
});

bot.on('message', async (ctx) => {
  if (ctx.message.text || ctx.message.photo) return;
  const identity = await requirePlayer(ctx);
  if (!identity) return;
  await ctx.reply(supportCopy[identity.locale].unsupported);
});

bot.catch(async (error) => {
  logger.error({ err: error.error, update: error.ctx.update.update_id }, 'support bot error');
  try {
    await error.ctx.reply(supportCopy[localeFor(error.ctx)].error);
  } catch {
    // The chat may be gone; nothing else to do.
  }
});

// ─────────────────────────── staff reply delivery ───────────────────────────

let delivering = false;

async function deliverPending(): Promise<void> {
  if (delivering) return;
  delivering = true;
  try {
    const pending = await pendingSupportDeliveries(10);
    for (const message of pending) {
      const chatId = message.ticket.telegramChatId.toString();
      const label =
        message.author === 'STAFF' && message.authorUser
          ? `${message.authorUser.displayName} · ${message.ticket.code}`
          : message.ticket.code;
      const text =
        message.author === 'SYSTEM'
          ? `<i>${escapeHtml(message.body)}</i>`
          : `<b>${escapeHtml(label)}</b>\n${escapeHtml(message.body)}`;
      try {
        await bot.api.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
        await markSupportDeliverySent(message.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'send failed';
        await markSupportDeliveryFailed(message.id, reason);
        logger.warn(
          { ticket: message.ticket.code, messageId: message.id },
          'support reply delivery failed',
        );
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'support delivery sweep failed');
  } finally {
    delivering = false;
  }
}

// ─────────────────────────────── startup ───────────────────────────────

async function main(): Promise<void> {
  const commandsEn = [
    { command: 'start', description: 'Open the support menu' },
    { command: 'menu', description: 'Main menu' },
    { command: 'ticket', description: 'Talk to an agent' },
    { command: 'help', description: 'Help & FAQ' },
    { command: 'end', description: 'End the chat' },
  ];
  const commandsAm = [
    { command: 'start', description: 'የድጋፍ ምናሌ ክፈት' },
    { command: 'menu', description: 'ዋና ምናሌ' },
    { command: 'ticket', description: 'ከወኪል ጋር ተወያይ' },
    { command: 'help', description: 'እርዳታና ጥያቄዎች' },
    { command: 'end', description: 'ውይይቱን ጨርስ' },
  ];
  await bot.api
    .setMyCommands(commandsEn)
    .catch((error) => logger.warn({ err: error }, 'support setMyCommands failed'));
  await bot.api
    .setMyCommands(commandsAm, { language_code: 'am' })
    .catch((error) => logger.warn({ err: error }, 'support setMyCommands(am) failed'));

  const timer = setInterval(() => void deliverPending(), 3_000);
  timer.unref();

  logger.info('support bot started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'support bot shutting down');
    clearInterval(timer);
    await bot.stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.start({ allowed_updates: ['message', 'callback_query'] });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'support bot failed to start');
  process.exit(1);
});
