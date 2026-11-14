import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { authenticate } from '../middleware/auth';
import { listActiveCampaigns, serializeCampaign } from '../services/campaigns';

const CampaignQuery = z.object({ locale: z.enum(['en', 'am']).default('en') });

export const marketingRouter = Router();

marketingRouter.use(authenticate);

/** Banners and popups targeted at the signed-in player's role and language. */
marketingRouter.get(
  '/campaigns',
  asyncHandler(async (req, res) => {
    const query = parse(CampaignQuery, req.query);
    const campaigns = await listActiveCampaigns(req.auth!.role, query.locale);
    res.json({ data: campaigns.map(serializeCampaign) });
  }),
);
