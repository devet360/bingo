import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UserRole } from '@prisma/client';
import { verifyAccessToken } from '../services/jwt';
import { getActiveAgentByUserId } from '../services/agents';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';

export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(Errors.unauthorized());
    return;
  }
  try {
    const claims = verifyAccessToken(header.slice(7));
    req.auth = { userId: claims.sub, role: claims.role, sessionId: claims.sid };
    next();
  } catch (error) {
    next(error);
  }
};

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(Errors.unauthorized());
      return;
    }
    if (!roles.includes(req.auth.role)) {
      next(Errors.forbidden('Insufficient role', 'ROLE_FORBIDDEN'));
      return;
    }
    next();
  };
}

/** Play money and withdrawals require the Telegram-verified phone number. */
export async function requireVerifiedPhone(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw Errors.unauthorized();
    const user = await prisma.user.findUnique({
      where: { id: req.auth.userId },
      select: { phoneVerifiedAt: true },
    });
    if (!user?.phoneVerifiedAt) {
      throw Errors.forbidden(
        'Verify your phone number in the Telegram bot before playing',
        'PHONE_VERIFICATION_REQUIRED',
      );
    }
    next();
  } catch (error) {
    next(error);
  }
}

/** Loads the caller's active AgentProfile into req.agent. */
export async function requireAgent(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw Errors.unauthorized();
    req.agent = await getActiveAgentByUserId(req.auth.userId);
    next();
  } catch (error) {
    next(error);
  }
}
