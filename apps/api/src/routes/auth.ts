import { Router, type Request } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { Errors } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { serializeAgent, serializeUser, serializeWallet } from '../lib/serializers';
import { authenticate } from '../middleware/auth';
import { otpLimiter } from '../middleware/rateLimit';
import { verifyTelegramInitData } from '../services/telegram';
import {
  changePassword,
  findOtpUser,
  findOrCreateTelegramUser,
  linkPhone,
  linkTelegram,
  loginWithPassword,
  updateLocale,
} from '../services/users';
import { isStaffRole } from '../services/staff';
import { issueSession, rotateSession, revokeSession, type SessionMeta, type TokenPair } from '../services/sessions';
import { consumeOtp, requestOtp } from '../services/otp';
import { getPlayerWallet } from '../services/wallet';

const PHONE_RE = /^\+[1-9]\d{7,14}$/;

const TelegramSchema = z.object({
  initData: z.string().min(1).max(8192),
  startParam: z.string().max(64).optional(),
});

const PasswordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

const LocaleSchema = z.object({ locale: z.enum(['en', 'am']) });

const LoginSchema = z.object({
  identifier: z.string().min(3).max(254),
  password: z.string().min(1).max(128),
});

const OtpRequestSchema = z.object({
  identifier: z.string().min(3).max(254),
  channel: z.enum(['SMS', 'EMAIL', 'TELEGRAM']).optional(),
  purpose: z.enum(['LOGIN', 'LINK_PHONE', 'LINK_EMAIL']).default('LOGIN'),
});

const OtpVerifySchema = z.object({
  identifier: z.string().min(3).max(254),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  channel: z.enum(['SMS', 'EMAIL', 'TELEGRAM']).optional(),
  purpose: z.enum(['LOGIN', 'LINK_PHONE', 'LINK_EMAIL']).default('LOGIN'),
});

const RefreshSchema = z.object({ refreshToken: z.string().min(20).max(4096) });

const LinkPhoneSchema = z.object({
  phone: z.string().regex(PHONE_RE, 'Use E.164 format, e.g. +2348012345678'),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  password: z.string().min(8).max(128).optional(),
});

export const authRouter = Router();

function sessionMeta(req: Request, platform: SessionMeta['platform']): SessionMeta {
  return {
    platform,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  };
}

function tokenPayload(tokens: TokenPair) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresIn: env.JWT_ACCESS_TTL,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
}

authRouter.post(
  '/telegram',
  asyncHandler(async (req, res) => {
    const body = parse(TelegramSchema, req.body);
    const verified = verifyTelegramInitData(
      body.initData,
      env.BOT_TOKEN,
      env.TELEGRAM_LOGIN_MAX_AGE_SECS,
    );
    const user = await findOrCreateTelegramUser(verified.user, body.startParam ?? verified.startParam);
    // Staff and agents reach their dashboards through the same Mini App; the
    // account keeps its role, so the app routes by role after sign-in.
    const tokens = await issueSession(user, sessionMeta(req, 'TELEGRAM_MINI_APP'));
    res.json({ data: { ...tokenPayload(tokens), user: serializeUser(user) } });
  }),
);

authRouter.post(
  '/register',
  asyncHandler(async () => {
    throw Errors.forbidden(
      'Player accounts are created through the Telegram bot. Staff accounts are issued by a super admin.',
      'REGISTRATION_DISABLED',
    );
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = parse(LoginSchema, req.body);
    const user = await loginWithPassword(body.identifier, body.password);
    if (!isStaffRole(user.role) && !(env.testPlayerLoginEnabled && user.isTestPlayer)) {
      throw Errors.forbidden(
        'Players sign in through the Telegram Mini App. This login is for staff and enabled test players.',
        'PLAYER_WEB_LOGIN_DISABLED',
      );
    }
    const platform = body.identifier.includes('@') ? 'WEB' : 'ANDROID';
    const tokens = await issueSession(user, sessionMeta(req, platform));
    res.json({ data: { ...tokenPayload(tokens), user: serializeUser(user) } });
  }),
);

authRouter.post(
  '/otp/request',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(OtpRequestSchema, req.body);
    const channel = body.channel ?? (body.identifier.includes('@') ? 'EMAIL' : 'SMS');
    if (channel === 'EMAIL' && !body.identifier.includes('@')) {
      throw Errors.badRequest('EMAIL channel requires an email identifier', 'INVALID_IDENTIFIER');
    }
    if (channel === 'SMS' && !PHONE_RE.test(body.identifier)) {
      throw Errors.badRequest('SMS channel requires an E.164 phone number', 'INVALID_IDENTIFIER');
    }
    const result = await requestOtp({
      identifier: body.identifier,
      channel,
      purpose: body.purpose,
      ip: req.ip,
    });
    res.json({ data: { sent: true, expiresAt: result.expiresAt, devCode: result.devCode } });
  }),
);

authRouter.post(
  '/otp/verify',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(OtpVerifySchema, req.body);
    const channel = body.channel ?? (body.identifier.includes('@') ? 'EMAIL' : 'SMS');
    await consumeOtp({ identifier: body.identifier, purpose: body.purpose, code: body.code });
    if (body.purpose !== 'LOGIN') {
      throw Errors.badRequest(
        'Use the authenticated link endpoints to attach this destination',
        'WRONG_OTP_PURPOSE',
      );
    }
    const user = await findOtpUser(body.identifier);
    if (!isStaffRole(user.role)) {
      throw Errors.forbidden(
        'Players sign in through the Telegram Mini App. This login is for staff only.',
        'PLAYER_WEB_LOGIN_DISABLED',
      );
    }
    const tokens = await issueSession(user, sessionMeta(req, channel === 'EMAIL' ? 'WEB' : 'ANDROID'));
    res.json({ data: { ...tokenPayload(tokens), user: serializeUser(user) } });
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const body = parse(RefreshSchema, req.body);
    const tokens = await rotateSession(body.refreshToken, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ data: tokenPayload(tokens) });
  }),
);

authRouter.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    await revokeSession(req.auth!.sessionId, req.auth!.userId);
    res.json({ data: { loggedOut: true } });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.auth!.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Errors.notFound('User');
    const wallet = await getPlayerWallet(userId);
    const agent = await prisma.agentProfile.findUnique({ where: { userId } });
    res.json({
      data: {
        user: serializeUser(user),
        wallet: serializeWallet(wallet),
        agent: agent ? serializeAgent(agent, { includeBalances: true }) : null,
      },
    });
  }),
);

authRouter.post(
  '/password',
  authenticate,
  asyncHandler(async (req, res) => {
    const body = parse(PasswordChangeSchema, req.body);
    await changePassword(req.auth!.userId, body.currentPassword, body.newPassword);
    res.json({ data: { changed: true } });
  }),
);

authRouter.patch(
  '/locale',
  authenticate,
  asyncHandler(async (req, res) => {
    const body = parse(LocaleSchema, req.body);
    const user = await updateLocale(req.auth!.userId, body.locale);
    res.json({ data: { user: serializeUser(user) } });
  }),
);

authRouter.post(
  '/link/telegram',
  authenticate,
  asyncHandler(async (req, res) => {
    const body = parse(TelegramSchema, req.body);
    const verified = verifyTelegramInitData(
      body.initData,
      env.BOT_TOKEN,
      env.TELEGRAM_LOGIN_MAX_AGE_SECS,
    );
    const user = await linkTelegram(req.auth!.userId, verified.user);
    res.json({ data: { user: serializeUser(user) } });
  }),
);

authRouter.post(
  '/link/phone',
  authenticate,
  asyncHandler(async (req, res) => {
    const body = parse(LinkPhoneSchema, req.body);
    await consumeOtp({ identifier: body.phone, purpose: 'LINK_PHONE', code: body.code });
    const user = await linkPhone(req.auth!.userId, body.phone, body.password);
    res.json({ data: { user: serializeUser(user) } });
  }),
);
