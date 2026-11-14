import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { Errors } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { authenticate, requireVerifiedPhone } from '../middleware/auth';
import {
  applyWalletCallback,
  closeSession,
  launchGame,
  listPlayableGames,
  serializeSession,
  verifyCallbackSignature,
} from '../services/gameProviders';

const LaunchSchema = z.object({ lang: z.enum(['en', 'am']).default('en') });

const CallbackSchema = z.object({
  sessionId: z.string().uuid(),
  type: z.enum(['bet', 'win', 'rollback']),
  txnId: z.string().min(1).max(128),
  amount: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String),
  currency: z.string().max(16).optional(),
  roundId: z.string().max(128).optional(),
});

export const gamesRouter = Router();

/** Providers sign the exact bytes they send; the shared secret is per provider. */
gamesRouter.post(
  '/callback/:providerCode',
  asyncHandler(async (req, res) => {
    const provider = await prisma.gameProvider.findUnique({
      where: { code: req.params.providerCode },
    });
    if (!provider) throw Errors.notFound('Provider');
    const signature = req.header('x-provider-signature');
    if (!verifyCallbackSignature(provider, req.rawBody, signature)) {
      throw Errors.forbidden('Invalid provider signature', 'SIGNATURE_INVALID');
    }
    const payload = parse(CallbackSchema, req.body);
    const result = await applyWalletCallback(provider.code, payload);
    res.status(result.replayed ? 200 : 201).json({ data: { accepted: true, replayed: result.replayed } });
  }),
);

gamesRouter.use(authenticate);

gamesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const providers = await listPlayableGames();
    res.json({ data: providers });
  }),
);

gamesRouter.post(
  '/:gameId/launch',
  requireVerifiedPhone,
  asyncHandler(async (req, res) => {
    const body = parse(LaunchSchema, req.body);
    const session = await launchGame({
      userId: req.auth!.userId,
      gameId: req.params.gameId,
      lang: body.lang,
    });
    res.status(201).json({ data: serializeSession(session) });
  }),
);

gamesRouter.post(
  '/sessions/:sessionId/close',
  asyncHandler(async (req, res) => {
    await closeSession(req.auth!.userId, req.params.sessionId);
    res.json({ data: { closed: true } });
  }),
);
