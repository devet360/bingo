import { Router } from 'express';
import { asyncHandler } from '../lib/async';
import { authenticate } from '../middleware/auth';
import { env } from '../config/env';
import { minorToWire } from '../lib/money';
import {
  getReferralOverview,
  serializeReferralCommission,
} from '../services/referrals';

export const referralsRouter = Router();

referralsRouter.use(authenticate);

referralsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const overview = await getReferralOverview(req.auth!.userId, env.TELEGRAM_BOT_USERNAME ?? null);
    res.json({
      data: {
        code: overview.code,
        inviteLink: overview.inviteLink,
        commissionBps: overview.commissionBps,
        referredCount: overview.referredCount,
        activeReferrals: overview.activeReferrals,
        totalEarned: minorToWire(overview.totalEarned),
        recent: overview.recent.map(serializeReferralCommission),
      },
    });
  }),
);
