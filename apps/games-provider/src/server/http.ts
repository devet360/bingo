import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ZodError, z } from 'zod';
import type { AppConfig } from '../config';
import { adminRouter } from './adminHttp';
import { SessionEndedError, handshake } from './handshake';
import { OperatorError, type OperatorRegistry } from './operatorRegistry';
import type { Store } from './store';
import { WalletError } from './wallet';
import { ChatRainError, ChatRainManager } from './chatRain';

export interface AppDeps {
  config: AppConfig;
  store: Store;
  registry: OperatorRegistry;
}

// The client is emitted to `dist/client` next to this module's build output,
// while the process runs from the repo root.
const clientDir = path.resolve(fileURLToPath(new URL('../../dist/client', import.meta.url)));
const clientIndex = path.join(clientDir, 'index.html');
const SESSION_TTL_MS = 2 * 3600_000;
const SessionBody = z.object({
  token: z.string().uuid(),
  operator: z.string().min(1).max(64).optional(),
  game: z.string().min(1).max(32).optional(),
});

function roundId(pathId: string): number | null {
  if (!/^\d+$/.test(pathId)) return null;
  const id = Number(pathId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  const chatRain = new ChatRainManager(deps.config.chat);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    const origins = deps.config.allowedParentOrigins.join(' ');
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${origins}`.trim());
    next();
  });

  app.use(express.json({ limit: '32kb' }));

  app.use(
    '/api/admin',
    adminRouter({
      store: deps.store,
      registry: deps.registry,
      adminToken: deps.config.adminToken,
      consoleTokenSecret: deps.config.consoleTokenSecret,
    }),
  );

  app.get('/api/health', (_req, res) => {
    res.json({ data: { status: 'ok', game: 'crash' } });
  });

  app.post('/api/sessions/handshake', async (req, res, next) => {
    try {
      const { token, operator: operatorCode, game: gameId } = SessionBody.parse(req.body);
      const session = await handshake({
        token,
        operatorCode,
        gameId,
        config: deps.config,
        store: deps.store,
        registry: deps.registry,
      });
      res.json({
        data: {
          sessionId: session.token,
          operator: session.operatorCode,
          gameId: session.gameId,
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
      if (error instanceof OperatorError) {
        res.status(error.status).json({ error: { code: error.code } });
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
      // Only the canonical decimal form resolves: /rounds/0007 is not round 7.
      const round = id === null || String(id) !== req.params.id ? null : await deps.store.getRound(id);
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
      if (round.gameId === 'coinflip') {
        if (!round.coinOutcome) {
          res.status(409).json({ error: { code: 'ROUND_OUTCOME_PENDING' } });
          return;
        }
        res.json({
          data: {
            roundId: round.id,
            gameId: 'coinflip',
            outcome: round.coinOutcome,
            serverSeed: round.serverSeed,
            serverSeedHash: round.serverSeedHash,
            clientSeedComposite: round.clientSeedComposite,
            startedAt: round.startedAt,
            crashedAt: round.crashedAt,
          },
        });
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

  app.get('/api/catalogue', async (req, res, next) => {
    try {
      const code = typeof req.query.operator === 'string' ? req.query.operator : deps.config.defaultOperatorCode;
      const operator = await deps.store.getOperator(code);
      if (operator === null) {
        res.status(404).json({ error: { code: 'OPERATOR_NOT_FOUND' } });
        return;
      }
      res.json({
        data: {
          operator: { code: operator.code, name: operator.name },
          currency: operator.currency,
          localeDefault: operator.localeDefault,
          games: operator.enabledGames,
          limits: {
            minStake: operator.limits.minStake.toString(),
            maxStake: operator.limits.maxStake.toString(),
            maxWin: operator.limits.maxWin.toString(),
            maxBetsPerRound: operator.limits.maxBetsPerRound,
          },
          theme: operator.theme,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/chat/:roomId', async (req, res, next) => {
    try {
      const operator = typeof req.query.operator === 'string'
        ? req.query.operator
        : deps.config.defaultOperatorCode;
      res.json({ data: chatRain.recent(operator, req.params.roomId) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/chat/messages', async (req, res, next) => {
    try {
      const body = z.object({
        token: z.string().uuid(),
        roomId: z.string().min(1).max(64),
        message: z.string().min(1).max(2000),
      }).parse(req.body);
      const session = await deps.store.getSession(body.token);
      if (session === null || session.status !== 'OPEN') {
        res.status(410).json({ error: { code: 'SESSION_CLOSED' } });
        return;
      }
      const message = chatRain.post({
        operatorCode: session.operatorCode,
        roomId: body.roomId,
        session,
        body: body.message,
      });
      res.status(201).json({ data: message });
    } catch (error) {
      if (error instanceof ChatRainError) {
        res.status(400).json({ error: { code: error.code, message: error.message } });
        return;
      }
      next(error);
    }
  });

  app.post('/api/rain', async (req, res, next) => {
    try {
      const body = z.object({
        operator: z.string().min(1).max(64),
        amount: z.coerce.bigint().positive(),
        expiresAt: z.coerce.date(),
      }).parse(req.body);
      const operator = await deps.registry.get(body.operator);
      const recipients = await deps.store.listActiveSessionsByOperator(body.operator);
      const event = await chatRain.rain({
        operatorCode: body.operator,
        amount: body.amount,
        recipients,
        expiresAt: body.expiresAt,
        fund: async (funding) => {
          const raw = JSON.stringify({
            type: 'rain_credit',
            operator: funding.operatorCode,
            fundingId: funding.fundingId,
            amount: funding.amount.toString(),
            recipients: funding.recipients,
          });
          const signature = await deps.registry.signOutbound(body.operator, raw);
          const callback = new URL(operator.callbackUrl);
          callback.pathname = `/api/games/rain/${encodeURIComponent(body.operator)}/credit`;
          callback.search = '';
          callback.hash = '';
          const response = await fetch(callback, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-provider-signature': signature },
            body: raw,
            signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok) throw new Error(`RAIN_CREDIT rejected with HTTP ${response.status}`);
          const payload = await response.json() as { data?: { fundingId?: string } };
          if (!payload.data?.fundingId) throw new Error('RAIN_CREDIT returned no funding id');
          return { fundingId: payload.data.fundingId };
        },
      });
      res.status(201).json({ data: event });
    } catch (error) {
      if (error instanceof ChatRainError) {
        res.status(400).json({ error: { code: error.code, message: error.message } });
        return;
      }
      next(error);
    }
  });

  app.get('/provider-console', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Provider Console</title></head><body style="font-family:system-ui;margin:24px"><h1>Provider Console</h1><p id="scope">Loading scoped operators…</p><div id="operators"></div><script>
const token=${JSON.stringify(token)};
async function load(){const r=await fetch('/api/admin/operators',{headers:{authorization:'Bearer '+token}});const p=await r.json();const scope=document.getElementById('scope');const el=document.getElementById('operators');if(!r.ok){scope.textContent=p.error?.code||'Unauthorized';return}scope.textContent='Scoped operator view';for(const o of p.data||[]){const article=document.createElement('article');article.style.border='1px solid #ccc';article.style.padding='12px';article.style.margin='8px 0';article.textContent=o.name+' ('+o.code+') — '+o.status+' — games: '+(o.enabledGames||[]).join(', ');el.appendChild(article)}}load();
</script></body></html>`);
  });

  // Runs after the global frame-ancestors middleware so a per-operator policy
  // wins, and before static serving so the header is set on 404s too.
  app.use('/play', async (req, res, next) => {
    try {
      const code = typeof req.query.operator === 'string' ? req.query.operator : deps.config.defaultOperatorCode;
      const operator = await deps.store.getOperator(code);
      const origins = operator?.allowedOrigins.length
        ? operator.allowedOrigins
        : deps.config.allowedParentOrigins;
      res.setHeader(
        'Content-Security-Policy',
        `frame-ancestors 'self' ${origins.join(' ')}`.trim(),
      );
      next();
    } catch (error) {
      next(error);
    }
  });

  app.use('/play', express.static(clientDir));
  app.get(['/play', '/play/*'], (_req, res) => {
    // The client bundle is emitted by a later task. Until it exists, sending the
    // missing file would surface ENOENT as a 500; answer a plain 404 instead.
    if (!fs.existsSync(clientIndex)) {
      res.status(404).json({ error: { code: 'NOT_FOUND' } });
      return;
    }
    res.sendFile(clientIndex);
  });

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
    console.error('http: unhandled request error', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });

  return app;
}
