import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ZodError, z } from 'zod';
import type { AppConfig } from '../config';
import { SessionEndedError, handshake } from './handshake';
import type { Store } from './store';
import { WalletError, type WalletClient } from './wallet';

export interface AppDeps {
  config: AppConfig;
  store: Store;
  wallet: WalletClient;
}

// The client is emitted to `dist/client` next to this module's build output,
// while the process runs from the repo root.
const clientDir = path.resolve(fileURLToPath(new URL('../../dist/client', import.meta.url)));
const SESSION_TTL_MS = 2 * 3600_000;
const SessionBody = z.object({ token: z.string().uuid() });

function roundId(pathId: string): number | null {
  if (!/^\d+$/.test(pathId)) return null;
  const id = Number(pathId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    const origins = deps.config.allowedParentOrigins.join(' ');
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${origins}`.trim());
    next();
  });

  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ data: { status: 'ok', game: 'crash' } });
  });

  app.post('/api/sessions/handshake', async (req, res, next) => {
    try {
      const { token } = SessionBody.parse(req.body);
      const session = await handshake({
        token,
        config: deps.config,
        store: deps.store,
        wallet: deps.wallet,
      });
      res.json({
        data: {
          sessionId: session.token,
          gameId: 'crash',
          currency: session.currency,
          balance: session.displayBalance.toString(),
          limits: {
            minStake: session.minStake.toString(),
            maxStake: session.maxStake.toString(),
            maxWin: session.maxWin.toString(),
          },
          expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        },
      });
    } catch (error) {
      if (error instanceof SessionEndedError) {
        res.status(410).json({ error: { code: 'SESSION_CLOSED' } });
        return;
      }
      // A parse or signature failure is a broken wallet call, not a dead session.
      if (error instanceof WalletError) {
        res.status(502).json({ error: { code: 'WALLET_UNAVAILABLE' } });
        return;
      }
      next(error);
    }
  });

  app.post('/api/sessions/close', async (req, res, next) => {
    try {
      const { token } = SessionBody.parse(req.body);
      await deps.store.closeSession(token);
      res.json({ data: { closed: true } });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/rounds/:id/proof', async (req, res, next) => {
    try {
      const id = roundId(req.params.id);
      const round = id === null ? null : await deps.store.getRound(id);
      if (round === null) {
        res.status(404).json({ error: { code: 'ROUND_NOT_FOUND' } });
        return;
      }
      if (round.status === 'ABANDONED') {
        res.status(409).json({ error: { code: 'ROUND_ABANDONED' } });
        return;
      }
      if (round.status !== 'CRASHED') {
        res.status(409).json({ error: { code: 'ROUND_NOT_FINISHED' } });
        return;
      }
      res.json({
        data: {
          roundId: round.id,
          serverSeed: round.serverSeed,
          serverSeedHash: round.serverSeedHash,
          clientSeedComposite: round.clientSeedComposite,
          crashPoint: round.crashPoint,
          startedAt: round.startedAt,
          flewAt: round.flewAt,
          crashedAt: round.crashedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.use('/play', express.static(clientDir));
  app.get(['/play', '/play/*'], (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));

  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if ((error as { type?: unknown } | null)?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON' } });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
      return;
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });

  return app;
}
