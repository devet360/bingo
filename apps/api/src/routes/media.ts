import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { authenticate } from '../middleware/auth';
import { assertMediaAccess, readMedia } from '../services/media';

const AssetParams = z.object({ assetId: z.string().uuid() });

export const mediaRouter = Router();

mediaRouter.get(
  '/public/:assetId',
  asyncHandler(async (req, res) => {
    const params = parse(AssetParams, req.params);
    const asset = await prisma.mediaAsset.findUnique({ where: { id: params.assetId } });
    if (!asset || asset.purpose !== 'provider-game-thumbnail') throw Errors.notFound('Media');
    const buffer = await readMedia(asset);
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Disposition', 'inline');
    res.send(buffer);
  }),
);

mediaRouter.use(authenticate);

/**
 * Payment evidence is private: the response is fetched with the caller's
 * bearer token and never cached by shared proxies.
 */
mediaRouter.get(
  '/:assetId',
  asyncHandler(async (req, res) => {
    const params = parse(AssetParams, req.params);
    const asset = await prisma.mediaAsset.findUnique({ where: { id: params.assetId } });
    if (!asset) throw Errors.notFound('Media');
    await assertMediaAccess(asset, { userId: req.auth!.userId, role: req.auth!.role });
    const buffer = await readMedia(asset);
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('Content-Disposition', 'inline');
    res.send(buffer);
  }),
);
