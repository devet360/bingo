import type { OtpChannel, OtpPurpose } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { constantTimeEqualHex, hmacHex } from '../lib/crypto';
import { numericCode } from '../lib/ids';
import { AppError, Errors } from '../lib/errors';
import { logger } from '../lib/logger';

const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_WINDOW_MS = 10 * 60_000;
const OTP_MAX_PER_WINDOW = 3;

function hashCode(identifier: string, purpose: OtpPurpose, code: string): string {
  return hmacHex(env.OTP_HASH_PEPPER, `${identifier}:${purpose}:${code}`);
}

export interface RequestOtpResult {
  expiresAt: Date;
  devCode?: string;
}

export async function requestOtp(input: {
  identifier: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
  ip?: string;
}): Promise<RequestOtpResult> {
  const since = new Date(Date.now() - OTP_WINDOW_MS);
  const recent = await prisma.otpCode.count({
    where: { identifier: input.identifier, purpose: input.purpose, createdAt: { gte: since } },
  });
  if (recent >= OTP_MAX_PER_WINDOW) {
    throw Errors.tooManyRequests('Too many codes requested. Try again in a few minutes.');
  }

  const code = numericCode(6);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.otpCode.create({
    data: {
      identifier: input.identifier,
      channel: input.channel,
      purpose: input.purpose,
      codeHash: hashCode(input.identifier, input.purpose, code),
      maxAttempts: OTP_MAX_ATTEMPTS,
      expiresAt,
      ip: input.ip,
    },
  });

  // Delivery adapter (SMS/email/Telegram) lands in a later phase.
  logger.info(
    { identifier: input.identifier, channel: input.channel, purpose: input.purpose },
    'OTP issued',
  );

  return { expiresAt, ...(env.isProd ? {} : { devCode: code }) };
}

export async function consumeOtp(input: {
  identifier: string;
  purpose: OtpPurpose;
  code: string;
}): Promise<void> {
  const otp = await prisma.otpCode.findFirst({
    where: {
      identifier: input.identifier,
      purpose: input.purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) {
    throw new AppError(400, 'OTP_NOT_FOUND', 'No active code for this destination, request a new one');
  }
  if (otp.attempts >= otp.maxAttempts) {
    throw new AppError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many wrong attempts, request a new code');
  }

  const matches = constantTimeEqualHex(
    hashCode(input.identifier, input.purpose, input.code),
    otp.codeHash,
  );

  if (!matches) {
    await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw new AppError(400, 'OTP_INVALID', 'Incorrect code');
  }

  // Atomic single-use claim: a second concurrent verify loses here.
  const claimed = await prisma.otpCode.updateMany({
    where: { id: otp.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw new AppError(400, 'OTP_ALREADY_USED', 'This code was already used');
  }
}
