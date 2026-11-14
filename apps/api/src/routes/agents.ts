import { Router } from 'express';
import { PaymentMethod } from '@prisma/client';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { asyncHandler } from '../lib/async';
import { serializeAgent } from '../lib/serializers';
import { Errors } from '../lib/errors';
import { authenticate } from '../middleware/auth';
import { findAgentByCode, listPublicAgents } from '../services/agents';

const ListSchema = z.object({
  region: z.string().max(64).optional(),
  method: z.nativeEnum(PaymentMethod).optional(),
});

export const agentsRouter = Router();

agentsRouter.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const query = parse(ListSchema, req.query);
    const agents = await listPublicAgents(query);
    res.json({ data: agents.map((agent) => serializeAgent(agent)) });
  }),
);

agentsRouter.get(
  '/:agentCode',
  authenticate,
  asyncHandler(async (req, res) => {
    const agent = await findAgentByCode(req.params.agentCode);
    if (!agent || agent.status !== 'ACTIVE') throw Errors.notFound('Agent');
    res.json({ data: serializeAgent(agent) });
  }),
);
