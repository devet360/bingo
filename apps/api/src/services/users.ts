import { UserRole, UserStatus, type User } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { provisionUserAccounts } from './accounts';
import { referralCode as newReferralCode } from '../lib/ids';
import { normalizePhone } from '../lib/phone';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../lib/crypto';
import { Errors } from '../lib/errors';
import { isUniqueViolation, runTransaction, withTxRetry } from '../lib/tx';
import type { TelegramInitUser } from './telegram';

export function telegramDisplayName(profile: TelegramInitUser): string {
  const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim();
  return name || profile.username || `Player ${profile.id}`;
}

async function resolveReferrer(code?: string): Promise<string | null> {
  if (!code) return null;
  const referrer = await prisma.user.findUnique({
    where: { referralCode: code.trim().toUpperCase() },
    select: { id: true },
  });
  return referrer?.id ?? null;
}

export async function findOrCreateTelegramUser(
  profile: TelegramInitUser,
  startParam?: string,
): Promise<User> {
  const telegramId = BigInt(profile.id);
  const existing = await prisma.user.findUnique({ where: { telegramId } });

  if (existing) {
    return runTransaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: existing.id },
        data: {
          lastLoginAt: new Date(),
          ...(profile.username ? { telegramUsername: profile.username } : {}),
          ...(profile.photo_url ? { avatarUrl: profile.photo_url } : {}),
        },
      });
      await provisionUserAccounts(tx, user.id);
      return user;
    });
  }

  const referredById = await resolveReferrer(startParam);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await runTransaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            telegramId,
            telegramUsername: profile.username ?? null,
            displayName: telegramDisplayName(profile),
            avatarUrl: profile.photo_url ?? null,
            locale: profile.language_code ?? 'en',
            role: UserRole.PLAYER,
            status: UserStatus.ACTIVE,
            referralCode: newReferralCode(),
            referredById,
            lastLoginAt: new Date(),
          },
        });
        await provisionUserAccounts(tx, user.id);
        return user;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'referralCode')) continue;
      // Concurrent first login for the same Telegram account: adopt the winner.
      if (isUniqueViolation(error, 'telegramId')) {
        const winner = await prisma.user.findUnique({ where: { telegramId } });
        if (winner) return winner;
      }
      throw error;
    }
  }

  throw Errors.internal('Could not allocate a unique referral code');
}

/**
 * The only player signup path: the Telegram bot asks for the user's own contact
 * and this stores the verified number on the Telegram identity. If an older
 * phone-only account exists for that number it is adopted instead of duplicated.
 */
export async function registerTelegramPhone(
  profile: TelegramInitUser,
  rawPhone: string,
  startParam?: string,
): Promise<User> {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    throw Errors.badRequest('Telegram shared an unusable phone number', 'PHONE_INVALID');
  }
  const telegramId = BigInt(profile.id);

  const [byTelegram, byPhone] = await Promise.all([
    prisma.user.findUnique({ where: { telegramId } }),
    prisma.user.findUnique({ where: { phone }, select: { id: true, role: true } }),
  ]);

  if (byTelegram && byTelegram.role !== UserRole.PLAYER) {
    throw Errors.forbidden('Staff accounts sign in on the web portal', 'STAFF_WEB_ONLY');
  }
  if (byPhone && byPhone.id !== byTelegram?.id) {
    if (byPhone.role !== UserRole.PLAYER) {
      throw Errors.conflict('That phone number belongs to a staff account', 'PHONE_TAKEN');
    }
    // Same number already verified on another Telegram account: never reassign.
    throw Errors.conflict('That phone number is already linked to another player', 'PHONE_TAKEN');
  }

  const verifiedAt = new Date();
  const profilePatch = {
    phone,
    phoneVerifiedAt: verifiedAt,
    lastLoginAt: verifiedAt,
    ...(profile.username ? { telegramUsername: profile.username } : {}),
    ...(profile.photo_url ? { avatarUrl: profile.photo_url } : {}),
  };

  if (byTelegram) {
    return prisma.user.update({ where: { id: byTelegram.id }, data: profilePatch });
  }

  // Legacy phone-only player (created before Telegram-only signup): adopt it so
  // its wallet and history stay intact.
  if (byPhone) {
    return prisma.user.update({
      where: { id: byPhone.id },
      data: { ...profilePatch, telegramId },
    });
  }

  const referredById = await resolveReferrer(startParam);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await runTransaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            telegramId,
            telegramUsername: profile.username ?? null,
            displayName: telegramDisplayName(profile),
            avatarUrl: profile.photo_url ?? null,
            locale: profile.language_code?.split('-')[0] ?? 'en',
            phone,
            phoneVerifiedAt: verifiedAt,
            role: UserRole.PLAYER,
            status: UserStatus.ACTIVE,
            referralCode: newReferralCode(),
            referredById,
            lastLoginAt: verifiedAt,
          },
        });
        await provisionUserAccounts(tx, user.id);
        return user;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'referralCode')) continue;
      if (isUniqueViolation(error, 'telegramId') || isUniqueViolation(error, 'phone')) {
        const winner = await prisma.user.findFirst({
          where: { OR: [{ telegramId }, { phone }] },
        });
        if (winner) return winner;
      }
      throw error;
    }
  }

  throw Errors.internal('Could not create the Telegram player');
}

export interface PasswordRegistration {
  phone?: string;
  email?: string;
  password: string;
  displayName: string;
  referralCode?: string;
}

export async function registerWithPassword(input: PasswordRegistration): Promise<User> {
  assertPasswordPolicy(input.password);
  const passwordHash = await hashPassword(input.password);
  const referredById = await resolveReferrer(input.referralCode);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await withTxRetry(() =>
        runTransaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              phone: input.phone,
              email: input.email?.toLowerCase(),
              passwordHash,
              displayName: input.displayName,
              referralCode: newReferralCode(),
              referredById,
              lastLoginAt: new Date(),
            },
          });
          await provisionUserAccounts(tx, user.id);
          return user;
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error, 'referralCode')) continue;
      if (isUniqueViolation(error, 'phone')) {
        throw Errors.conflict('That phone number is already registered', 'PHONE_TAKEN');
      }
      if (isUniqueViolation(error, 'email')) {
        throw Errors.conflict('That email is already registered', 'EMAIL_TAKEN');
      }
      throw error;
    }
  }

  throw Errors.internal('Could not allocate a unique referral code');
}

export async function findUserByIdentifier(identifier: string): Promise<User | null> {
  return prisma.user.findFirst({
    where: { OR: [{ phone: identifier }, { email: identifier.toLowerCase() }] },
  });
}

export async function loginWithPassword(identifier: string, password: string): Promise<User> {
  const user = await findUserByIdentifier(identifier);
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    throw Errors.unauthorized('Invalid credentials');
  }
  if (user.status !== UserStatus.ACTIVE) {
    throw Errors.forbidden('Account is not active', 'ACCOUNT_INACTIVE');
  }
  return prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
}

export async function linkTelegram(userId: string, profile: TelegramInitUser): Promise<User> {
  const telegramId = BigInt(profile.id);
  const owner = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
  if (owner && owner.id !== userId) {
    throw Errors.conflict(
      'This Telegram account is already linked to another player',
      'TELEGRAM_ALREADY_LINKED',
    );
  }
  return prisma.user.update({
    where: { id: userId },
    data: {
      telegramId,
      telegramUsername: profile.username ?? null,
      ...(profile.photo_url ? { avatarUrl: profile.photo_url } : {}),
    },
  });
}

export async function linkPhone(userId: string, phone: string, password?: string): Promise<User> {
  const owner = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (owner && owner.id !== userId) {
    throw Errors.conflict('That phone number belongs to another player', 'PHONE_TAKEN');
  }
  const passwordHash = password ? await hashPassword(password) : undefined;
  return prisma.user.update({
    where: { id: userId },
    data: { phone, ...(passwordHash ? { passwordHash } : {}) },
  });
}

/** OTP is a login aid for existing accounts only; signup happens in the bot. */
export async function findOtpUser(identifier: string): Promise<User> {
  const existing = await findUserByIdentifier(identifier);
  if (!existing) {
    throw Errors.unauthorized('No account uses this phone or email. Sign up through Telegram.');
  }
  if (existing.status !== UserStatus.ACTIVE) {
    throw Errors.forbidden('Account is not active', 'ACCOUNT_INACTIVE');
  }
  return prisma.user.update({ where: { id: existing.id }, data: { lastLoginAt: new Date() } });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user?.passwordHash) {
    throw Errors.badRequest('This account has no password set', 'PASSWORD_NOT_SET');
  }
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw Errors.unauthorized('Current password is incorrect');
  }
  assertPasswordPolicy(newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
  });
}

export async function updateLocale(userId: string, locale: 'en' | 'am'): Promise<User> {
  return prisma.user.update({ where: { id: userId }, data: { locale } });
}

