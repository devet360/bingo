import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { authenticate, requireVerifiedPhone } from '../middleware/auth';
import {
  closeSession,
  getOpenSessionForUser,
  handleProviderCallback,
  launchGame,
  listPlayableGames,
  serializeSession,
} from '../services/gameProviders';

const LaunchSchema = z.object({ lang: z.enum(['en', 'am']).default('en') });

export const gamesRouter = Router();

/**
 * Providers sign the exact bytes they send; the shared secret is per provider.
 * Balances are signed back with a timestamp and nonce so the reply cannot be
 * replayed by a third party.
 */
gamesRouter.post(
  '/callback/:providerCode',
  asyncHandler(async (req, res) => {
    const result = await handleProviderCallback({
      providerCode: req.params.providerCode,
      rawBody: req.rawBody,
      signature: req.header('x-provider-signature'),
      body: req.body,
      ip: req.ip,
    });
    res.status(result.status).json({ data: result.data });
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

gamesRouter.get(
  '/sessions/:sessionId',
  asyncHandler(async (req, res) => {
    const session = await getOpenSessionForUser(req.auth!.userId, req.params.sessionId);
    res.json({ data: serializeSession(session) });
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
