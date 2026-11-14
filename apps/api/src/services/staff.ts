import { UserRole, UserStatus, type User } from '@prisma/client';
import { randomBytes, randomInt } from 'node:crypto';
import { Errors } from '../lib/errors';
import { isUniqueViolation, runTransaction, withTxRetry } from '../lib/tx';
import { referralCode as newReferralCode } from '../lib/ids';
import { hashPassword } from '../lib/crypto';
import { prisma } from '../lib/prisma';
import { provisionUserAccounts } from './accounts';
import type { TelegramInitUser } from './telegram';

export const STAFF_ROLES: UserRole[] = [UserRole.SUPPORT, UserRole.AGENT, UserRole.SUPER_ADMIN];

const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function isStaffRole(role: UserRole): boolean {
  return role !== UserRole.PLAYER;
}

export function generateTemporaryPassword(): string {
  let value = '';
  for (let index = 0; index < 16; index += 1) {
    value += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  }
  return value;
}

export interface CreateStaffInput {
  role: UserRole;
  displayName: string;
  email?: string;
  phone?: string;
  password?: string;
}

/**
 * Creates a staff login. Staff never self-register: the super admin console is
 * the only entry point, and passwords are temporary until the first change.
 */
export async function createStaff(input: CreateStaffInput): Promise<{ user: User; temporaryPassword: string }> {
  if (!STAFF_ROLES.includes(input.role)) {
    throw Errors.badRequest('Only support, agent or super admin accounts can be created here', 'INVALID_ROLE');
  }
  if (!input.email && !input.phone) {
    throw Errors.badRequest('An email or phone number is required for staff login', 'LOGIN_IDENTIFIER_REQUIRED');
  }

  const temporaryPassword = input.password ?? generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const email = input.email?.trim().toLowerCase();

  try {
    const user = await withTxRetry(() =>
      runTransaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            phone: input.phone,
            passwordHash,
            mustChangePassword: true,
            displayName: input.displayName.trim(),
            role: input.role,
            status: UserStatus.ACTIVE,
            kycStatus: 'VERIFIED',
            referralCode: newReferralCode(),
          },
        });
        await provisionUserAccounts(tx, created.id);
        return created;
      }),
    );
    return { user, temporaryPassword };
  } catch (error) {
    if (isUniqueViolation(error, 'phone')) {
      throw Errors.conflict('That phone number is already in use', 'PHONE_TAKEN');
    }
    if (isUniqueViolation(error, 'email')) {
      throw Errors.conflict('That email is already in use', 'EMAIL_TAKEN');
    }
    throw error;
  }
}

export async function resetStaffPassword(userId: string): Promise<{ temporaryPassword: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user || !isStaffRole(user.role)) throw Errors.notFound('Staff member');
  const temporaryPassword = generateTemporaryPassword();
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true },
  });
  return { temporaryPassword };
}

export async function setStaffStatus(userId: string, status: UserStatus): Promise<User> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user || !isStaffRole(user.role)) throw Errors.notFound('Staff member');
    const updated = await tx.user.update({ where: { id: userId }, data: { status } });
    if (status === UserStatus.SUSPENDED) {
      await tx.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return updated;
  });
}

/** Admin types the Telegram id directly. Null unlinks the account. */
export async function setStaffTelegram(userId: string, telegramId: string | null): Promise<User> {
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!target || !isStaffRole(target.role)) throw Errors.notFound('Staff member');

  if (telegramId) {
    const value = BigInt(telegramId);
    const owner = await prisma.user.findUnique({
      where: { telegramId: value },
      select: { id: true },
    });
    if (owner && owner.id !== userId) {
      throw Errors.conflict('That Telegram account is already linked to another user', 'TELEGRAM_TAKEN');
    }
    return prisma.user.update({
      where: { id: userId },
      data: { telegramId: value, telegramLinkToken: null, telegramLinkExpiresAt: null },
    });
  }

  return prisma.user.update({
    where: { id: userId },
    data: { telegramId: null, telegramLinkToken: null, telegramLinkExpiresAt: null },
  });
}

const STAFF_LINK_TTL_MS = 15 * 60_000;

/**
 * One-time code for the staff member to prove they own the Telegram account:
 * they open t.me/<bot>?start=staff_<token> and the bot writes the id.
 */
export async function createStaffTelegramLink(
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!target || !isStaffRole(target.role)) throw Errors.notFound('Staff member');

  const token = randomBytes(18).toString('base64url');
  const expiresAt = new Date(Date.now() + STAFF_LINK_TTL_MS);
  await prisma.user.update({
    where: { id: userId },
    data: { telegramLinkToken: token, telegramLinkExpiresAt: expiresAt },
  });
  return { token, expiresAt };
}

export async function consumeStaffTelegramLink(
  token: string,
  profile: TelegramInitUser,
): Promise<User> {
  const user = await prisma.user.findFirst({
    where: {
      telegramLinkToken: token,
      telegramLinkExpiresAt: { gt: new Date() },
      role: { in: STAFF_ROLES },
    },
  });
  if (!user) {
    throw Errors.gone('This staff link has expired. Ask an admin for a new one.', 'TELEGRAM_LINK_INVALID');
  }

  const telegramId = BigInt(profile.id);
  const owner = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (owner && owner.id !== user.id) {
    throw Errors.conflict('That Telegram account is already linked to another user', 'TELEGRAM_TAKEN');
  }

  return prisma.user.update({
    where: { id: user.id },
    data: {
      telegramId,
      telegramUsername: profile.username ?? null,
      ...(profile.photo_url ? { avatarUrl: profile.photo_url } : {}),
      telegramLinkToken: null,
      telegramLinkExpiresAt: null,
    },
  });
}
