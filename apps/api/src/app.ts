import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { asyncHandler } from './lib/async';
import { openApiDocument } from './docs/openapi';
import { errorHandler, notFoundHandler } from './middleware/error';
import { authLimiter } from './middleware/rateLimit';
import { authRouter } from './routes/auth';
import { agentsRouter } from './routes/agents';
import { walletRouter } from './routes/wallet';
import { agentRouter } from './routes/agent';
import { adminRouter } from './routes/admin';
import { staffReadRouter } from './routes/staffRead';
import { bingoRouter } from './routes/bingo';
import { marketingRouter } from './routes/marketing';
import { bonusesRouter } from './routes/bonuses';
import { referralsRouter } from './routes/referrals';
import { gamesRouter } from './routes/games';
import { mediaRouter } from './routes/media';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Every monetary value is a bigint; serialize as decimal strings, never floats.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );

  // JSON-only API; Swagger UI at /docs needs its inline scripts, so no CSP here.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    cors({
      origin: env.corsOrigins.length > 0 ? env.corsOrigins : false,
      credentials: true,
    }),
  );
  // Client-side receipt verification posts the bank's own response (PDFs from
  // M-Pesa) as base64, so this subtree needs more room than the rest of the API.
  app.use('/wallet/deposits', express.json({ limit: '8mb' }));
  // Agents submit payment screenshots inline on the proof endpoint.
  app.use('/agent/withdrawals', express.json({ limit: '8mb' }));
  // Keep the exact bytes of every JSON body: provider webhooks sign them.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({ status: 'ready' });
      } catch {
        res.status(503).json({ status: 'unavailable', dependency: 'postgres' });
      }
    }),
  );

  app.use('/auth', authLimiter, authRouter);
  app.use('/agents', agentsRouter);
  app.use('/wallet', walletRouter);
  app.use('/agent', agentRouter);
  app.use('/support', staffReadRouter);
  // Support-level reads are also reachable by a super admin, then admin-only routes.
  app.use('/admin', staffReadRouter, adminRouter);
  app.use('/bingo', bingoRouter);
  app.use('/marketing', marketingRouter);
  app.use('/bonuses', bonusesRouter);
  app.use('/referrals', referralsRouter);
  app.use('/games', gamesRouter);
  app.use('/media', mediaRouter);

  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, { customSiteTitle: 'Bingo 251 API' }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
