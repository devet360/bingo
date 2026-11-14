import { Bot, InlineKeyboard, Keyboard, type Context } from 'grammy';
import type { User } from '@prisma/client';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/errors';
import { registerTelegramPhone } from '../services/users';
import { resolveBotLocale, botCopy, type BotLocale } from './messages';

const bot = new Bot(env.BOT_TOKEN);

// Telegram does not echo the /start payload on the contact message, so hold it
// briefly per chat to keep referral attribution.
const pendingStartParams = new Map<number, { param: string; expiresAt: number }>();

function takeStartParam(telegramId: number): string | undefined {
  const entry = pendingStartParams.get(telegramId);
  pendingStartParams.delete(telegramId);
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry.param;
}

function webAppUrl(): string | null {
  return env.TELEGRAM_WEBAPP_URL ?? null;
}

function playKeyboard(locale: BotLocale): InlineKeyboard | undefined {
  const url = webAppUrl();
  if (!url) return undefined;
  return new InlineKeyboard().webApp(botCopy[locale].playButton, url);
}

function shareContactKeyboard(locale: BotLocale): Keyboard {
  return new Keyboard()
    .requestContact(botCopy[locale].shareContactButton)
    .resized()
    .oneTime();
}

async function localeFor(ctx: Context, user?: Pick<User, 'locale'> | null): Promise<BotLocale> {
  if (user) return resolveBotLocale(ctx.from?.language_code, user.locale);
  if (!ctx.from) return 'en';
  const known = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from.id) },
    select: { locale: true },
  });
  return resolveBotLocale(ctx.from.language_code, known?.locale);
}

async function openGame(ctx: Context, locale: BotLocale, intro: string): Promise<void> {
  const keyboard = playKeyboard(locale);
  if (!keyboard) {
    await ctx.reply(intro);
    await ctx.reply(botCopy[locale].appNotConfigured);
    return;
  }
  await ctx.reply(intro, { reply_markup: keyboard });
}

async function sendWelcome(ctx: Context): Promise<void> {
  const locale = await localeFor(ctx);
  const telegramId = ctx.from ? BigInt(ctx.from.id) : null;
  const user = telegramId
    ? await prisma.user.findUnique({
        where: { telegramId },
        select: { phoneVerifiedAt: true, role: true },
      })
    : null;

  if (user && user.role !== 'PLAYER') {
    await ctx.reply(botCopy[locale].staffWebOnly);
    return;
  }

  if (user?.phoneVerifiedAt) {
    await openGame(ctx, locale, botCopy[locale].welcomeBack);
    return;
  }

  await ctx.reply(botCopy[locale].welcomeVerify, {
    reply_markup: shareContactKeyboard(locale),
  });
}

bot.command('start', async (ctx) => {
  const payload = ctx.match?.trim();
  if (ctx.from && payload) {
    pendingStartParams.set(ctx.from.id, { param: payload, expiresAt: Date.now() + 10 * 60_000 });
  }
  await sendWelcome(ctx);
});

bot.command('verify', async (ctx) => {
  const locale = await localeFor(ctx);
  await ctx.reply(botCopy[locale].contactButtonHint, {
    reply_markup: shareContactKeyboard(locale),
  });
});

bot.command('help', async (ctx) => {
  const locale = await localeFor(ctx);
  await ctx.reply(botCopy[locale].help);
});

bot.on('message:contact', async (ctx) => {
  const locale = await localeFor(ctx);
  const contact = ctx.message.contact;
  const sender = ctx.from;

  if (!sender || contact.user_id !== sender.id) {
    await ctx.reply(botCopy[locale].notOwnContact, {
      reply_markup: shareContactKeyboard(locale),
    });
    return;
  }

  try {
    const user = await registerTelegramPhone(
      {
        id: sender.id,
        first_name: sender.first_name,
        last_name: sender.last_name,
        username: sender.username,
        language_code: sender.language_code,
        is_premium: sender.is_premium,
      },
      contact.phone_number,
      takeStartParam(sender.id),
    );
    const savedLocale = resolveBotLocale(sender.language_code, user.locale);
    const keyboard = playKeyboard(savedLocale);
    const text = botCopy[savedLocale].contactSaved(user.phone ?? contact.phone_number);
    if (keyboard) {
      await ctx.reply(text, { reply_markup: keyboard });
    } else {
      await ctx.reply(`${text}\n\n${botCopy[savedLocale].appNotConfigured}`);
    }
  } catch (error) {
    if (error instanceof AppError && error.code === 'PHONE_TAKEN') {
      await ctx.reply(botCopy[locale].phoneTaken);
      return;
    }
    if (error instanceof AppError && error.code === 'PHONE_INVALID') {
      await ctx.reply(botCopy[locale].invalidPhone, {
        reply_markup: shareContactKeyboard(locale),
      });
      return;
    }
    if (error instanceof AppError && error.code === 'STAFF_WEB_ONLY') {
      await ctx.reply(botCopy[locale].staffWebOnly);
      return;
    }
    throw error;
  }
});

bot.on('message', async (ctx) => {
  if (ctx.message.contact) return;
  await sendWelcome(ctx);
});

bot.catch((error) => {
  logger.error({ err: error.error, update: error.ctx.update.update_id }, 'telegram bot error');
});

async function main(): Promise<void> {
  const commandsEn = [
    { command: 'start', description: 'Open Bingo Hall' },
    { command: 'verify', description: 'Verify your phone number' },
    { command: 'help', description: 'How to play' },
  ];
  const commandsAm = [
    { command: 'start', description: 'ቢንጎ አዳራሽ ክፈት' },
    { command: 'verify', description: 'ስልክ ቁጥርዎን ያረጋግጡ' },
    { command: 'help', description: 'እንዴት እንደሚጫወቱ' },
  ];
  await bot.api.setMyCommands(commandsEn).catch((error) => logger.warn({ err: error }, 'setMyCommands failed'));
  await bot.api
    .setMyCommands(commandsAm, { language_code: 'am' })
    .catch((error) => logger.warn({ err: error }, 'setMyCommands(am) failed'));

  const url = webAppUrl();
  if (url) {
    await bot.api
      .setChatMenuButton({
        menu_button: { type: 'web_app', text: 'Bingo', web_app: { url } },
      })
      .catch((error) => logger.warn({ err: error }, 'setChatMenuButton failed'));
  } else {
    logger.warn('TELEGRAM_WEBAPP_URL is not set; the bot cannot open the Mini App');
  }

  logger.info('telegram bot started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'telegram bot shutting down');
    await bot.stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.start({ allowed_updates: ['message'] });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'telegram bot failed to start');
  process.exit(1);
});
