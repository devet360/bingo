import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { authenticate, requireVerifiedPhone } from '../middleware/auth';
import { moneyLimiter } from '../middleware/rateLimit';
import { serializeWallet } from '../lib/serializers';
import {
  getActiveBonus,
  listBonusHistory,
  redeemPromoCode,
  serializeBonus,
} from '../services/bonuses';
import { getPlayerWallet } from '../services/wallet';

const RedeemSchema = z.object({ code: z.string().trim().min(3).max(32) });

export const bonusesRouter = Router();

bonusesRouter.use(authenticate);

bonusesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.auth!.userId;
    const [active, history, wallet] = await Promise.all([
      getActiveBonus(userId),
      listBonusHistory(userId),
      getPlayerWallet(userId),
    ]);
    res.json({
      data: {
        active: active ? serializeBonus(active) : null,
        history: history.map(serializeBonus),
        wallet: serializeWallet(wallet),
      },
    });
  }),
);

/** Promo code redemption requires the Telegram-verified phone, like all play. */
bonusesRouter.post(
  '/redeem',
  requireVerifiedPhone,
  moneyLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(RedeemSchema, req.body);
    const bonus = await redeemPromoCode(req.auth!.userId, body.code);
    const wallet = await getPlayerWallet(req.auth!.userId);
    res.status(201).json({ data: { bonus: serializeBonus(bonus), wallet: serializeWallet(wallet) } });
  }),
);
