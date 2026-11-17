# Games Provider V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `apps/games-provider` — a single-instance crash game that settles every wager through bingo251's existing HMAC callback seam — plus the two bingo-side additions that let players launch it inside the Telegram Mini App.

**Architecture:** A port of the `game-provider/` prototype into the npm workspace, with its internal wallet, JWT, Firebase consoles, free bets, chat and rain deleted. Round pacing and provably-fair math are kept byte-identical. Money moves only through a signed wallet client and a durable outbox; Postgres stores rounds, bets, sessions and the outbox so boot recovery can refund any bet stranded by a restart.

**Tech Stack:** Node 22+, TypeScript 5, Express 4, `ws`, React 19 + Vite, Drizzle ORM 0.45 + `pg`, `node:test` with `tsx`, Dokku (Dockerfile + Procfile at repo root).

**Spec:** `docs/superpowers/specs/2026-11-17-games-provider-design.md`

## Global Constraints

- Money is `bigint` minor units everywhere (1 ETB = 100 minor); on the wire it is a decimal string. No float arithmetic on money.
- The provider never holds an authoritative wallet; `displayBalance` is a mirror of signed bingo replies.
- Single instance only: no clustering, no horizontal scaling (`dokku ps:scale web=1`).
- No secrets in the repo, in tests, or in docs. Operator HMAC secret arrives via env.
- Bingo-side changes are additive only: optional fields, new routes; existing callback behaviour must not change.
- V1 excludes bots (forced 0), chat, rain, free bets, provider portals, Firebase, JWT, guest sessions, top-up, keno and coin-flip.
- Every bet must end in a terminal wallet state; no code path may leave a charge unaccounted.
- Game UI ships EN + AM strings.
- Run commands from the repo root; commit after every task.

---

## Phase A — Bingo contract and embedding

### Task 1: Pure provider-contract helpers in bingo API

**Files:**
- Create: `apps/api/src/lib/providerContract.ts`
- Modify: `apps/api/src/services/gameProviders.ts` (remove local `buildLaunchUrl`, use helpers in `launchGame` and `handleProviderCallback`)
- Test: `apps/api/tests/providerContract.test.ts`

**Interfaces:**
- Consumes: `signBalance(secret, {sessionId, currency, balance, timestamp, nonce})` from `apps/api/src/lib/providerCallback.ts` (already exists).
- Produces: `buildLaunchUrl(template, {token, lang, currency})`, `buildBalanceReply(input)`, `withBalance(data, balance)` — used by Task 2 (session endpoint) and by the provider app's contract tests.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/providerContract.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildBalanceReply, buildLaunchUrl, withBalance } from '../src/lib/providerContract';

test('launch url substitutes the real currency, not the legacy CREDIT literal', () => {
  const url = buildLaunchUrl('https://crash.example/play?token={token}&lang={lang}&currency={currency}', {
    token: 'f1f1f1f1-1111-4111-8111-111111111111',
    lang: 'am',
    currency: 'ETB',
  });
  assert.equal(
    url,
    'https://crash.example/play?token=f1f1f1f1-1111-4111-8111-111111111111&lang=am&currency=ETB',
  );
});

test('launch url is null without a template and encodes the token', () => {
  assert.equal(buildLaunchUrl(null, { token: 'a b', lang: 'en', currency: 'ETB' }), null);
  assert.equal(
    buildLaunchUrl('https://x/play?t={sessionId}', { token: 'a b', lang: 'en', currency: 'ETB' }),
    'https://x/play?t=a%20b',
  );
});

test('balance reply signs the exact sessionId.currency.balance.timestamp.nonce string', () => {
  const reply = buildBalanceReply({
    secret: 'test-secret',
    sessionId: 's-1',
    currency: 'ETB',
    balance: 12345n,
    minStake: 100n,
    maxStake: 100000n,
    maxWin: 3000000n,
    timestamp: 1763400000,
    nonce: 'n-1',
  });
  const expected = createHmac('sha256', 'test-secret')
    .update('s-1.ETB.12345.1763400000.n-1')
    .digest('hex');
  assert.equal(reply.signature, expected);
  assert.equal(reply.balance, '12345');
  assert.equal(reply.minStake, '100');
  assert.equal(reply.maxStake, '100000');
  assert.equal(reply.maxWin, '3000000');
});

test('balance reply omits limits that are not configured', () => {
  const reply = buildBalanceReply({
    secret: 's',
    sessionId: 's-1',
    currency: 'ETB',
    balance: 0n,
    minStake: null,
    maxStake: null,
    maxWin: null,
    timestamp: 1,
    nonce: 'n',
  });
  assert.equal('minStake' in reply, false);
  assert.equal('maxWin' in reply, false);
});

test('withBalance appends the post-movement balance as a string', () => {
  assert.deepEqual(withBalance({ accepted: true, replayed: false }, 900n), {
    accepted: true,
    replayed: false,
    balance: '900',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @bingo/api`
Expected: FAIL — `Cannot find module '../src/lib/providerContract'`.

- [ ] **Step 3: Write the module**

```ts
// apps/api/src/lib/providerContract.ts
import { signBalance } from './providerCallback';

export interface LaunchContext {
  token: string;
  lang: string;
  currency: string;
}

export function buildLaunchUrl(template: string | null, ctx: LaunchContext): string | null {
  if (!template) return null;
  return template
    .replaceAll('{token}', encodeURIComponent(ctx.token))
    .replaceAll('{sessionId}', encodeURIComponent(ctx.token))
    .replaceAll('{lang}', encodeURIComponent(ctx.lang))
    .replaceAll('{currency}', encodeURIComponent(ctx.currency));
}

export interface BalanceReplyInput {
  secret: string;
  sessionId: string;
  currency: string;
  balance: bigint;
  minStake: bigint | null;
  maxStake: bigint | null;
  maxWin: bigint | null;
  timestamp: number;
  nonce: string;
}

/** Signed balance payload. Limits are optional so older providers keep working. */
export function buildBalanceReply(input: BalanceReplyInput) {
  return {
    currency: input.currency,
    balance: input.balance.toString(),
    timestamp: input.timestamp,
    nonce: input.nonce,
    signature: signBalance(input.secret, {
      sessionId: input.sessionId,
      currency: input.currency,
      balance: input.balance,
      timestamp: input.timestamp,
      nonce: input.nonce,
    }),
    ...(input.minStake !== null ? { minStake: input.minStake.toString() } : {}),
    ...(input.maxStake !== null ? { maxStake: input.maxStake.toString() } : {}),
    ...(input.maxWin !== null ? { maxWin: input.maxWin.toString() } : {}),
  };
}

export function withBalance<T extends Record<string, unknown>>(
  data: T,
  balance: bigint,
): T & { balance: string } {
  return { ...data, balance: balance.toString() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @bingo/api`
Expected: PASS (5 new tests plus the existing suite).

- [ ] **Step 5: Wire the helpers into `gameProviders.ts`**

Delete the local `buildLaunchUrl` (lines ~220-227) and import the helper. In `launchGame`:

```ts
launchUrl: buildLaunchUrl(game.launchUrlTemplate, {
  token: externalSessionId,
  lang: input.lang,
  currency: game.provider.currency,
}),
```

In the `payload.type === 'balance'` branch replace the reply literal with:

```ts
const maxWin = await resolveMaxWin(provider, context.game);
await writeCallbackLog(audit, 200);
return {
  status: 200,
  data: buildBalanceReply({
    secret: provider.webhookSecret!,
    sessionId: payload.sessionId,
    currency: provider.currency,
    balance: available,
    minStake: context.game?.minStake ?? null,
    maxStake: context.game?.maxStake ?? null,
    maxWin,
    timestamp,
    nonce,
  }),
};
```

For both movement replies (`rollback` and the `bet`/`win` tail), read the balance and wrap:

```ts
const walletAfter = await prisma.wallet.findUnique({
  where: { userId: session.userId },
  select: { available: true },
});
const balanceNow = walletAfter?.available ?? 0n;
```

then `return { status: replayed ? 200 : 201, data: withBalance({ accepted: true, replayed }, balanceNow) };`

- [ ] **Step 6: Run the full API suite and typecheck**

Run: `npm run test -w @bingo/api && npm run typecheck -w @bingo/api`
Expected: all tests pass; no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/providerContract.ts apps/api/tests/providerContract.test.ts apps/api/src/services/gameProviders.ts
git commit -m "feat(api): add provider contract helpers with limits and post-movement balance"
```

---

### Task 2: Owner-scoped session lookup endpoint

**Files:**
- Modify: `apps/api/src/services/gameProviders.ts` (add `getOpenSessionForUser`)
- Modify: `apps/api/src/routes/games.ts` (add `GET /sessions/:sessionId`)

**Interfaces:**
- Produces: `GET /api/games/sessions/:sessionId` → the serialized session (`serializeSession`: `id`, `status`, `launchUrl`, `expiresAt`, …), used by the play page in Task 3.

- [ ] **Step 1: Add the service function**

```ts
export async function getOpenSessionForUser(
  userId: string,
  sessionId: string,
): Promise<ProviderSession> {
  const session = await prisma.providerSession.findFirst({
    where: { id: sessionId, userId },
  });
  if (!session) throw Errors.notFound('Game session');
  if (session.expiresAt <= new Date()) {
    throw Errors.gone('Game session has expired', 'SESSION_EXPIRED');
  }
  return session;
}
```

- [ ] **Step 2: Add the route above the `/:gameId/launch` route**

```ts
gamesRouter.get(
  '/sessions/:sessionId',
  asyncHandler(async (req, res) => {
    const session = await getOpenSessionForUser(req.auth!.userId, req.params.sessionId);
    res.json({ data: serializeSession(session) });
  }),
);
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck -w @bingo/api`
Expected: no errors. (No unit test: this path is DB-backed; it is exercised by the browser check in Task 3 and the manual E2E in Task 17.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/games.ts apps/api/src/services/gameProviders.ts
git commit -m "feat(api): expose owner-scoped provider session lookup"
```

---

### Task 3: Embedded play page and lobby hand-off

**Files:**
- Create: `apps/web/src/app/games/play/[sessionId]/page.tsx`
- Modify: `apps/web/src/lib/api.ts` (add `fetchGameSession`)
- Modify: `apps/web/src/components/shell.tsx` (treat `/games/play/` as immersive)
- Modify: `apps/web/src/app/games/page.tsx` (router push instead of `window.open`)
- Modify: `apps/web/src/lib/i18n.tsx` (new keys)

**Interfaces:**
- Consumes: `GET /api/games/sessions/:sessionId` from Task 2; `haptic`, `getTelegramWebApp` from `apps/web/src/lib/telegram.ts`; `useI18n`.
- Produces: route `/games/play/<sessionId>`, parent side of the `bingo:theme` / `bingo:haptic` / `bingo:locale` / `bingo:exit` bridge expected by the provider client (Task 16).

- [ ] **Step 1: Add the API client function** (next to `launchGame` in `apps/web/src/lib/api.ts`)

```ts
export function fetchGameSession(sessionId: string): Promise<ProviderSession> {
  return apiRequest(`/games/sessions/${sessionId}`);
}
```

`apiRequest` already unwraps the `{ data }` envelope, and `ProviderSession` is already imported in that file.

- [ ] **Step 2: Add i18n keys** (`games.sessionEnded`, `games.sessionEndedBody`, `games.returnToLobby`)

```ts
en: { ...,
  'games.sessionEnded': 'Game session ended',
  'games.sessionEndedBody': 'Return to the lobby to start a new round.',
  'games.returnToLobby': 'Back to games',
},
am: { ...,
  'games.sessionEnded': 'የጨዋታው ክፍለ ጊዜ አብቅቷል',
  'games.sessionEndedBody': 'አዲስ ዙር ለመጀመር ወደ መጫወቻ ክፍሉ ይመለሱ።',
  'games.returnToLobby': 'ወደ ጨዋታዎች',
},
```

- [ ] **Step 3: Write the play page**

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { fetchGameSession } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { haptic, getTelegramWebApp } from '@/lib/telegram';
import { Button, Spinner } from '@/components/ui';

// No build-time env: the provider origin is derived from the session's
// launchUrl at runtime (ruling recorded during execution), so the deployed
// image never falls back to a placeholder host.

export default function PlayGamePage() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const { t, lang } = useI18n();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const exit = useCallback(() => router.replace('/games'), [router]);

  useEffect(() => {
    let cancelled = false;
    fetchGameSession(params.sessionId)
      .then((session) => {
        if (!cancelled) setLaunchUrl(session.launchUrl);
      })
      .catch(() => {
        if (!cancelled) setEnded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [params.sessionId]);

  const postTheme = useCallback(() => {
    const styles = getComputedStyle(document.documentElement);
    const rgb = (name: string) => `rgb(${styles.getPropertyValue(name).trim().split(/\s+/).join(',')})`;
    frameRef.current?.contentWindow?.postMessage(
      {
        type: 'bingo:theme',
        payload: {
          scheme: document.documentElement.dataset.theme ?? 'dark',
          bg: rgb('--c-ink'),
          panel: rgb('--c-panel'),
          text: rgb('--c-text'),
          hint: rgb('--c-muted'),
          button: rgb('--c-mint'),
          buttonText: rgb('--c-on-accent'),
          gold: rgb('--c-gold'),
          danger: rgb('--c-danger'),
          safeBottom: 0,
          viewportHeight: window.innerHeight,
        },
      },
      PROVIDER_ORIGIN,
    );
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== PROVIDER_ORIGIN) return;
      if (event.data?.type === 'bingo:haptic') {
        haptic(event.data.payload === 'success' ? 'success' : event.data.payload === 'error' ? 'error' : 'tap');
      }
      if (event.data?.type === 'bingo:exit') exit();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [exit]);

  useEffect(() => {
    if (!launchUrl) return;
    postTheme();
    const frame = frameRef.current;
    const send = () => {
      postTheme();
      frame?.contentWindow?.postMessage({ type: 'bingo:locale', payload: lang }, PROVIDER_ORIGIN);
    };
    frame?.addEventListener('load', send);
    const timer = window.setTimeout(send, 300);
    return () => {
      frame?.removeEventListener('load', send);
      window.clearTimeout(timer);
    };
  }, [launchUrl, lang, postTheme]);

  useEffect(() => {
    const back = getTelegramWebApp()?.BackButton;
    back?.show?.();
    back?.onClick?.(exit);
    return () => back?.offClick?.(exit);
  }, [exit]);

  if (ended) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="font-display text-lg font-bold">{t('games.sessionEnded')}</p>
        <p className="text-sm text-muted">{t('games.sessionEndedBody')}</p>
        <Button onClick={exit}>{t('games.returnToLobby')}</Button>
      </div>
    );
  }

  if (!launchUrl) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="h-6 w-6 text-mint" />
      </div>
    );
  }

  return (
    <iframe
      ref={frameRef}
      src={launchUrl}
      title="Crash"
      allow="fullscreen"
      className="fixed inset-0 h-dvh w-full border-0 bg-ink"
    />
  );
}
```

The provider origin for `postMessage` comes from `new URL(session.launchUrl).origin` at runtime; there is no `NEXT_PUBLIC_*` variable to configure (see ruling in the SDD ledger).

- [ ] **Step 4: Make the shell immersive for the play route**

In `apps/web/src/components/shell.tsx` replace both `pathname.startsWith('/room/')` checks that control chrome with a shared predicate:

```ts
const immersive = pathname.startsWith('/room/') || pathname.startsWith('/games/play/');
```

Use `immersive` where `inRoom` was used for padding, header hiding and bottom-nav hiding. Keep the Telegram back-button hook keyed on `immersive`, pushing `/games` from the play route and `/` from rooms:

```ts
useTelegramBackButton(() => {
  haptic('tap');
  router.push(pathname.startsWith('/games/play/') ? '/games' : '/');
}, pathname.startsWith('/room/') || pathname.startsWith('/games/play/'));
```

- [ ] **Step 5: Lobby pushes instead of opening a tab**

In `apps/web/src/app/games/page.tsx`, replace:

```ts
window.open(session.launchUrl, '_blank', 'noopener,noreferrer');
```

with:

```ts
router.push(`/games/play/${session.id}`);
```

Import `useRouter` from `next/navigation` and keep the existing `launchUrl` null check.

- [ ] **Step 6: Verify**

Run: `npm run typecheck -w @bingo/web && npm run build -w @bingo/web`
Expected: clean. Then `npm run web:dev`, open `/games`, press Play for the crash card and confirm the route renders a full-viewport iframe (the provider app is not deployed yet, so a network error page inside the frame is expected at this stage).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/games apps/web/src/components/shell.tsx apps/web/src/lib/api.ts apps/web/src/lib/i18n.tsx apps/web/.env.example docs/DEPLOY.md
git commit -m "feat(web): embed provider games in a chrome-free iframe route"
```

---

## Phase B — Provider foundation

### Task 4: Scaffold the workspace app

**Files:**
- Create: `apps/games-provider/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `server.ts`
- Create: `apps/games-provider/src/config.ts`, `apps/games-provider/src/server/http.ts`
- Test: `apps/games-provider/tests/health.test.ts`
- Modify: root `package.json` scripts

**Interfaces:**
- Produces: `loadConfig(env)` → `AppConfig`; `createApp(deps)` → Express app; `health` route `GET /api/health`. Later tasks extend `AppDeps`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@bingo/games-provider",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch server.ts",
    "build": "vite build",
    "start": "node --import tsx server.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "node --import tsx --test tests/*.test.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "dotenv": "^17.2.3",
    "drizzle-orm": "^0.45.4",
    "express": "^4.21.2",
    "lucide-react": "^0.546.0",
    "motion": "^12.23.24",
    "pg": "^8.23.1",
    "pino": "^9.5.0",
    "tsx": "^4.21.0",
    "ws": "^8.23.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.14.0",
    "@types/pg": "^8.23.1",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@types/ws": "^8.18.2",
    "@vitejs/plugin-react": "^6.1.1",
    "drizzle-kit": "^0.31.11",
    "react": "^19.0.1",
    "react-dom": "^19.0.1",
    "tailwindcss": "^4.3.3",
    "typescript": "^5.6.3",
    "vite": "^8.3.0"
  }
}
```

- [ ] **Step 2: Add root scripts and install**

In root `package.json` `scripts`, add:

```json
"games:dev": "npm run dev -w @bingo/games-provider",
"games:build": "npm run build -w @bingo/games-provider",
"games:test": "npm run test -w @bingo/games-provider",
"games:typecheck": "npm run typecheck -w @bingo/games-provider",
```

Run: `npm install`
Expected: lockfile updated, `node_modules/@bingo/games-provider` linked.

- [ ] **Step 3: Write the failing health test**

```ts
// apps/games-provider/tests/health.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/http';
import { loadConfig } from '../src/config';

const config = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  OPERATOR_CALLBACK_URL: 'https://bingo.example/api/games/callback/stratos',
  OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
});

test('health endpoint reports ok', async () => {
  const server = createApp({ config }).listen(0);
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { status: 'ok', game: 'crash' } });
  server.close();
});

test('config forces bots off in v1', () => {
  assert.equal(config.botCount, 0);
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: 'postgres://x',
        OPERATOR_CALLBACK_URL: 'https://bingo.example/cb',
        OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
        BOT_COUNT: '5',
      }),
    /BOT_COUNT must be 0/,
  );
});

test('config parses minor-unit limit overrides', () => {
  const custom = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CALLBACK_URL: 'https://bingo.example/cb',
    OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
    GAME_MIN_STAKE: '50',
    GAME_MAX_STAKE: '25000',
    GAME_MAX_WIN: '500000',
  });
  assert.equal(custom.limits.minStake, 50n);
  assert.equal(custom.limits.maxStake, 25000n);
  assert.equal(custom.limits.maxWin, 500000n);
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npm run games:test`
Expected: FAIL — cannot find `../src/server/http`.

- [ ] **Step 5: Implement config and app**

```ts
// apps/games-provider/src/config.ts
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  OPERATOR_CODE: z.string().min(1).default('bingo251'),
  OPERATOR_CALLBACK_URL: z.string().url(),
  OPERATOR_HMAC_SECRET: z.string().min(16),
  OPERATOR_CURRENCY: z.string().length(3).default('ETB'),
  ALLOWED_PARENT_ORIGINS: z.string().default(''),
  GAME_MIN_STAKE: z.coerce.bigint().default(100n),
  GAME_MAX_STAKE: z.coerce.bigint().default(100_000n),
  GAME_MAX_WIN: z.coerce.bigint().default(3_000_000n),
  BOT_COUNT: z.coerce.number().int().min(0).default(0),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.parse(env);
  if (parsed.BOT_COUNT !== 0) throw new Error('BOT_COUNT must be 0 in V1');
  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    operator: {
      code: parsed.OPERATOR_CODE,
      callbackUrl: parsed.OPERATOR_CALLBACK_URL,
      hmacSecret: parsed.OPERATOR_HMAC_SECRET,
      currency: parsed.OPERATOR_CURRENCY.toUpperCase(),
    },
    allowedParentOrigins: parsed.ALLOWED_PARENT_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    limits: {
      minStake: parsed.GAME_MIN_STAKE,
      maxStake: parsed.GAME_MAX_STAKE,
      maxWin: parsed.GAME_MAX_WIN,
    },
    botCount: 0 as const,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
```

```ts
// apps/games-provider/src/server/http.ts
import express from 'express';
import type { AppConfig } from '../config';

export interface AppDeps {
  config: AppConfig;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/api/health', (_req, res) => {
    res.json({ data: { status: 'ok', game: 'crash' } });
  });
  void deps;
  return app;
}
```

- [ ] **Step 6: Add the minimal build config**

Production runs the TypeScript entry directly through `tsx` (`start` script above), so `tsc` only typechecks and `vite` only builds the client. Both must live in `dependencies` because the runtime image prunes dev dependencies.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "types": ["node", "vite/client"],
    "baseUrl": ".",
    "paths": { "@/*": ["./*"] }
  },
  "include": ["server.ts", "src", "tests", "vite.config.ts"],
  "exclude": ["dist"]
}
```

`vite.config.ts` (prototype config, minus HMR switches, client emitted to `dist/client`):

```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  build: { outDir: 'dist/client', emptyOutDir: true },
});
```

The `@` alias points at the app root, matching the prototype, so the client files copied in Task 16 keep their `@/src/...` imports.

`index.html`: copy the prototype's, change the `<title>` to `Crash`, keep `<div id="root">` and `/src/main.tsx`.

`server.ts` (placeholder for now, replaced in Task 15):

```ts
import 'dotenv/config';
import { loadConfig } from './src/config';
import { createApp } from './src/server/http';

const config = loadConfig();
createApp({ config }).listen(config.port, () => {
  console.log(`games-provider listening on ${config.port}`);
});
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npm run games:test && npm run games:typecheck`
Expected: 3 tests pass; no type errors.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json apps/games-provider
git commit -m "feat(games-provider): scaffold workspace app with config and health check"
```

---

### Task 5: Domain types, money helpers, store interface and memory store

**Files:**
- Create: `apps/games-provider/src/domain/types.ts`, `apps/games-provider/src/domain/money.ts`, `apps/games-provider/src/server/store.ts`, `apps/games-provider/src/test/memoryStore.ts`
- Test: `apps/games-provider/tests/money.test.ts`

**Interfaces:**
- Produces: `BetStatus`, `RoundStatus`, `OutboxStatus`, `Store` (methods listed below), `payoutFor(stake, multiplier, maxWin)`, `formatMinor(minor)`, `parseStakeToMinor(text)`, `createMemoryStore()`. Consumed by every later server task and by tests.

- [ ] **Step 1: Write the failing money test**

```ts
// apps/games-provider/tests/money.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMinor, parseStakeToMinor, payoutFor } from '../src/domain/money';

test('payout uses integer hundredths, never floats', () => {
  assert.equal(payoutFor(1000n, 2.54, 1_000_000n), 2540n);
  assert.equal(payoutFor(333n, 1.5, 1_000_000n), 499n);
});

test('payout is clamped to the max win', () => {
  assert.equal(payoutFor(1000n, 50, 30_000n), 30_000n);
});

test('stake parsing rejects zero, negatives, fractions beyond 2dp and junk', () => {
  assert.equal(parseStakeToMinor('12.5'), 1250n);
  assert.equal(parseStakeToMinor('12,000'), 1_200_000n);
  assert.equal(parseStakeToMinor('0'), null);
  assert.equal(parseStakeToMinor('-5'), null);
  assert.equal(parseStakeToMinor('1.234'), null);
  assert.equal(parseStakeToMinor('abc'), null);
});

test('formatMinor renders two decimals', () => {
  assert.equal(formatMinor(2540n), '25.40');
  assert.equal(formatMinor(0n), '0.00');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run games:test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement money and types**

```ts
// apps/games-provider/src/domain/money.ts
/** Payout in minor units: stake × multiplier(hundredths), floored, capped. */
export function payoutFor(stake: bigint, multiplier: number, maxWin: bigint): bigint {
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new Error(`Invalid cashout multiplier: ${multiplier}`);
  }
  const hundredths = BigInt(Math.round(multiplier * 100));
  const raw = (stake * hundredths) / 100n;
  return raw > maxWin ? maxWin : raw;
}

export function parseStakeToMinor(text: string): bigint | null {
  const cleaned = text.trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return minor > 0n ? minor : null;
}

export function formatMinor(minor: bigint): string {
  const whole = (minor / 100n).toString();
  const fraction = (minor % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}
```

```ts
// apps/games-provider/src/domain/types.ts
export type RoundStatus = 'BETTING' | 'FLYING' | 'CRASHED' | 'ABANDONED';
export type BetStatus =
  | 'PLACING'
  | 'ACTIVE'
  | 'CASHED'
  | 'LOST'
  | 'CANCELLED'
  | 'REJECTED'
  | 'UNRESOLVED';
export type OutboxType = 'WIN' | 'ROLLBACK';
export type OutboxStatus = 'PENDING' | 'SENT' | 'CAP_REJECTED' | 'DEAD';

export interface OperatorRecord {
  code: string;
  name: string;
  callbackUrl: string;
  hmacSecret: string;
  currency: string;
  enabled: boolean;
}

export interface SessionRecord {
  token: string;
  operatorCode: string;
  currency: string;
  minStake: bigint;
  maxStake: bigint;
  maxWin: bigint;
  displayBalance: bigint;
  status: 'OPEN' | 'CLOSED';
  createdAt: Date;
  lastHandshakeAt: Date;
}

export interface RoundRecord {
  id: number;
  serverSeed: string;
  serverSeedHash: string;
  clientSeedComposite: string | null;
  crashPoint: number | null;
  status: RoundStatus;
  startedAt: Date;
  flewAt: Date | null;
  crashedAt: Date | null;
}

export interface BetRecord {
  id: string;
  roundId: number;
  operatorCode: string;
  sessionToken: string;
  panel: 0 | 1;
  stake: bigint;
  autoCashout: number | null;
  status: BetStatus;
  cashoutMultiplier: number | null;
  payout: bigint | null;
  betTxnId: string;
  winTxnId: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

export interface OutboxRecord {
  id: string;
  operatorCode: string;
  type: OutboxType;
  txnId: string;
  sessionToken: string;
  amount: bigint;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 4: Define the store interface**

```ts
// apps/games-provider/src/server/store.ts
import type {
  BetRecord,
  OperatorRecord,
  OutboxRecord,
  RoundRecord,
  SessionRecord,
} from '../domain/types';

export type NewRound = Pick<RoundRecord, 'serverSeed' | 'serverSeedHash' | 'startedAt'>;
export type NewBet = Omit<BetRecord, 'id' | 'createdAt' | 'settledAt'>;
export type NewOutbox = Pick<
  OutboxRecord,
  'operatorCode' | 'type' | 'txnId' | 'sessionToken' | 'amount'
>;

export interface Store {
  getOperator(code: string): Promise<OperatorRecord | null>;
  upsertOperator(operator: OperatorRecord): Promise<void>;

  getSession(token: string): Promise<SessionRecord | null>;
  saveSession(session: SessionRecord): Promise<void>;
  closeSession(token: string): Promise<void>;
  setSessionBalance(token: string, balance: bigint): Promise<void>;

  createRound(input: NewRound): Promise<RoundRecord>;
  startFlight(id: number, input: { crashPoint: number; clientSeedComposite: string; at: Date }): Promise<void>;
  finishRound(id: number, input: { status: 'CRASHED' | 'ABANDONED'; at: Date }): Promise<void>;
  getRound(id: number): Promise<RoundRecord | null>;
  lastUnfinishedRound(): Promise<RoundRecord | null>;

  insertBet(bet: NewBet): Promise<BetRecord>;
  updateBet(id: string, patch: Partial<Pick<BetRecord, 'status' | 'cashoutMultiplier' | 'payout' | 'winTxnId' | 'settledAt'>>): Promise<void>;
  getBet(roundId: number, sessionToken: string, panel: 0 | 1): Promise<BetRecord | null>;
  listBetsForRound(roundId: number): Promise<BetRecord[]>;
  listUnsettledBets(): Promise<BetRecord[]>;

  enqueueOutbox(entry: NewOutbox): Promise<OutboxRecord | null>;
  claimDueOutbox(now: Date, limit: number): Promise<OutboxRecord[]>;
  markOutbox(id: string, status: OutboxStatus, error?: string | null): Promise<void>;
  rescheduleOutbox(id: string, nextAttemptAt: Date, error: string): Promise<void>;
  pendingOutboxCount(): Promise<number>;
}
```

- [ ] **Step 5: Implement the memory store**

`apps/games-provider/src/test/memoryStore.ts` — Maps for operators/sessions/rounds/bets/outbox; auto-increment round ids; `enqueueOutbox` returns `null` when `(operatorCode, type, txnId)` already exists; `claimDueOutbox` filters `status === 'PENDING' && nextAttemptAt <= now`, sorted by `nextAttemptAt`, limited; timestamps via injected `now` (`createMemoryStore({ now: () => Date })`); `listUnsettledBets` returns `ACTIVE`/`PLACING`/`UNRESOLVED` bets. Keep every method a one-liner over the maps so tests can inspect state directly (`store.dump()`).

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run games:test && npm run games:typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/games-provider/src/domain apps/games-provider/src/server/store.ts apps/games-provider/src/test apps/games-provider/tests/money.test.ts
git commit -m "feat(games-provider): add domain types, money helpers and store contract"
```

---

### Task 6: Drizzle schema, migrations and Postgres store

**Files:**
- Create: `apps/games-provider/src/db/schema.ts`, `apps/games-provider/src/db/index.ts`, `apps/games-provider/src/db/storePostgres.ts`, `apps/games-provider/drizzle.config.ts`
- Test: manual generation check only (DB-backed; covered by Task 15 smoke script)

**Interfaces:**
- Produces: `createPostgresStore(db)` implementing `Store`; `migrate(db)` used at boot.

- [ ] **Step 1: Write the schema**

```ts
// apps/games-provider/src/db/schema.ts
import {
  bigint, bigserial, boolean, index, integer, numeric, pgEnum, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';

export const roundStatus = pgEnum('round_status', ['BETTING', 'FLYING', 'CRASHED', 'ABANDONED']);
export const betStatus = pgEnum('bet_status', ['PLACING', 'ACTIVE', 'CASHED', 'LOST', 'CANCELLED', 'REJECTED', 'UNRESOLVED']);
export const outboxType = pgEnum('outbox_type', ['WIN', 'ROLLBACK']);
export const outboxStatus = pgEnum('outbox_status', ['PENDING', 'SENT', 'CAP_REJECTED', 'DEAD']);

export const operators = pgTable('operators', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  callbackUrl: text('callback_url').notNull(),
  hmacSecret: text('hmac_secret').notNull(),
  currency: text('currency').notNull(),
  enabled: boolean('enabled').notNull().default(true),
});

export const sessions = pgTable('sessions', {
  token: uuid('token').primaryKey(),
  operatorCode: text('operator_code').notNull(),
  currency: text('currency').notNull(),
  minStake: bigint('min_stake', { mode: 'bigint' }).notNull(),
  maxStake: bigint('max_stake', { mode: 'bigint' }).notNull(),
  maxWin: bigint('max_win', { mode: 'bigint' }).notNull(),
  displayBalance: bigint('display_balance', { mode: 'bigint' }).notNull().default(0n),
  status: text('status').notNull().default('OPEN'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastHandshakeAt: timestamp('last_handshake_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rounds = pgTable('rounds', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  serverSeed: text('server_seed').notNull(),
  serverSeedHash: text('server_seed_hash').notNull(),
  clientSeedComposite: text('client_seed_composite'),
  crashPoint: numeric('crash_point', { precision: 12, scale: 2 }),
  status: roundStatus('status').notNull().default('BETTING'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  flewAt: timestamp('flew_at', { withTimezone: true }),
  crashedAt: timestamp('crashed_at', { withTimezone: true }),
});

export const bets = pgTable('bets', {
  id: uuid('id').primaryKey(),
  roundId: bigint('round_id', { mode: 'number' }).notNull(),
  operatorCode: text('operator_code').notNull(),
  sessionToken: uuid('session_token').notNull(),
  panel: integer('panel').notNull(),
  stake: bigint('stake', { mode: 'bigint' }).notNull(),
  autoCashout: numeric('auto_cashout', { precision: 12, scale: 2 }),
  status: betStatus('status').notNull(),
  cashoutMultiplier: numeric('cashout_multiplier', { precision: 12, scale: 2 }),
  payout: bigint('payout', { mode: 'bigint' }),
  betTxnId: uuid('bet_txn_id').notNull(),
  winTxnId: uuid('win_txn_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, (table) => ({
  roundBet: unique('bets_round_session_panel').on(table.roundId, table.sessionToken, table.panel),
  statusIdx: index('bets_status_idx').on(table.status),
}));

export const walletOutbox = pgTable('wallet_outbox', {
  id: uuid('id').primaryKey(),
  operatorCode: text('operator_code').notNull(),
  type: outboxType('type').notNull(),
  txnId: uuid('txn_id').notNull(),
  sessionToken: uuid('session_token').notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  status: outboxStatus('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  dedupe: unique('outbox_dedupe').on(table.operatorCode, table.type, table.txnId),
  dueIdx: index('outbox_due_idx').on(table.status, table.nextAttemptAt),
}));

export const walletCalls = pgTable('wallet_calls', {
  id: uuid('id').primaryKey(),
  type: text('type').notNull(),
  sessionToken: uuid('session_token'),
  txnId: text('txn_id'),
  httpStatus: integer('http_status'),
  latencyMs: integer('latency_ms'),
  requestHash: text('request_hash'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Add pool + migration helper**

```ts
// apps/games-provider/src/db/index.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

export function createDb(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool);
  return {
    db,
    pool,
    async migrate() {
      await migrate(db, { migrationsFolder: 'apps/games-provider/drizzle' });
    },
    async close() {
      await pool.end();
    },
  };
}

export type Database = ReturnType<typeof createDb>['db'];
```

- [ ] **Step 3: Implement `createPostgresStore(db)`** using Drizzle queries matching the `Store` interface one-for-one. Notable details:
  - `claimDueOutbox`: `SELECT ... WHERE status='PENDING' AND next_attempt_at <= now ORDER BY next_attempt_at LIMIT $n FOR UPDATE SKIP LOCKED`, wrapped in a transaction that flips claimed rows to `PENDING` with `nextAttemptAt = now + 60s` so two drainers cannot double-send (single instance, but the guard is cheap).
  - `enqueueOutbox`: `insert ... onConflictDoNothing({ target: [operatorCode, type, txnId] }) returning *`; `undefined` result → `null`.
  - `lastUnfinishedRound`: latest row with `status IN ('BETTING','FLYING')`.
  - `listUnsettledBets`: `status IN ('PLACING','ACTIVE','UNRESOLVED')`.

- [ ] **Step 4: Write `drizzle.config.ts`**

```ts
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './apps/games-provider/src/db/schema.ts',
  out: './apps/games-provider/drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
  verbose: true,
});
```

- [ ] **Step 5: Generate the migration and typecheck**

Run: `DATABASE_URL=postgres://placeholder npm run db:generate -w @bingo/games-provider`
Expected: SQL file created under `apps/games-provider/drizzle/` (generation does not connect).

Run: `npm run games:typecheck`
Expected: clean. Commit the generated SQL.

- [ ] **Step 6: Commit**

```bash
git add apps/games-provider/src/db apps/games-provider/drizzle apps/games-provider/drizzle.config.ts
git commit -m "feat(games-provider): add drizzle schema, migrations and postgres store"
```

---

### Task 7: Wallet client, signatures and fake bingo server

**Files:**
- Create: `apps/games-provider/src/server/wallet.ts`, `apps/games-provider/src/test/fakeBingo.ts`
- Test: `apps/games-provider/tests/wallet.test.ts`

**Interfaces:**
- Produces: `WalletClient` interface, `HttpWalletClient`, `WalletError` (`{status: number|null, code: string}`), `signBody(secret, raw)`, `verifyBalanceReply(secret, sessionToken, reply, nowMs)`. Consumed by handshake (Task 13), bets (Task 10) and outbox (Task 11).

- [ ] **Step 1: Write the failing test**

```ts
// apps/games-provider/tests/wallet.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBingo } from '../src/test/fakeBingo';
import { HttpWalletClient, WalletError, verifyBalanceReply } from '../src/server/wallet';

const SECRET = 'test-hmac-secret-value';

async function clientFor(fake: Awaited<ReturnType<typeof createFakeBingo>>) {
  return new HttpWalletClient({ callbackUrl: `${fake.url}/api/games/callback/stratos`, hmacSecret: SECRET, timeoutMs: 500 });
}

test('handshake returns a verified balance with limits', async () => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 50_000n, currency: 'ETB' });
  const client = await clientFor(fake);
  const reply = await client.balance(fake.token, 'nonce-1');
  verifyBalanceReply(SECRET, fake.token, reply, Date.now());
  assert.equal(reply.balance, 50_000n);
  assert.equal(reply.minStake, 100n);
  assert.equal(reply.maxWin, 3_000_000n);
  await fake.close();
});

test('a tampered balance reply is rejected', async () => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 50_000n, currency: 'ETB' });
  const client = await clientFor(fake);
  const reply = await client.balance(fake.token, 'nonce-1');
  assert.throws(
    () => verifyBalanceReply(SECRET, fake.token, { ...reply, balance: 999_999n }, Date.now()),
    (error: unknown) => error instanceof WalletError && error.code === 'BALANCE_SIGNATURE_INVALID',
  );
  await fake.close();
});

test('bet rejection surfaces the bingo error code', async () => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 100n, currency: 'ETB' });
  const client = await clientFor(fake);
  await assert.rejects(
    client.bet({ sessionToken: fake.token, txnId: '11111111-1111-4111-8111-111111111111', amount: 500n, roundId: '1' }),
    (error: unknown) => error instanceof WalletError && error.code === 'INSUFFICIENT_FUNDS' && error.status === 409,
  );
  await fake.close();
});

test('a replayed bet is reported as replayed and does not double-debit', async () => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 10_000n, currency: 'ETB' });
  const client = await clientFor(fake);
  const input = { sessionToken: fake.token, txnId: '22222222-2222-4222-8222-222222222222', amount: 1000n, roundId: '1' };
  const first = await client.bet(input);
  const second = await client.bet(input);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(fake.state().balance, 9_000n);
  await fake.close();
});

test('timeouts become a TIMEOUT WalletError', async () => {
  const fake = await createFakeBingo({ hmacSecret: SECRET, balance: 10_000n, currency: 'ETB', betDelayMs: 200 });
  const client = new HttpWalletClient({ callbackUrl: `${fake.url}/api/games/callback/stratos`, hmacSecret: SECRET, timeoutMs: 30 });
  await assert.rejects(
    client.bet({ sessionToken: fake.token, txnId: '33333333-3333-4333-8333-333333333333', amount: 100n, roundId: '1' }),
    (error: unknown) => error instanceof WalletError && error.code === 'TIMEOUT' && error.status === null,
  );
  await fake.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run games:test`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the wallet client**

```ts
// apps/games-provider/src/server/wallet.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export class WalletError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

export interface MovementInput {
  sessionToken: string;
  txnId: string;
  amount: bigint;
  roundId: string;
}

export interface BalanceReply {
  currency: string;
  balance: bigint;
  balanceRaw: string;
  timestamp: number;
  nonce: string;
  signature: string;
  minStake: bigint | null;
  maxStake: bigint | null;
  maxWin: bigint | null;
}

export interface MovementReply {
  accepted: boolean;
  replayed: boolean;
  balance: bigint | null;
}

export interface WalletClient {
  balance(sessionToken: string, nonce: string): Promise<BalanceReply>;
  bet(input: MovementInput): Promise<MovementReply>;
  win(input: MovementInput): Promise<MovementReply>;
  rollback(input: MovementInput): Promise<MovementReply>;
}

export function signBody(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function balanceSignatureInput(input: {
  sessionId: string;
  currency: string;
  balance: string;
  timestamp: number;
  nonce: string;
}): string {
  return `${input.sessionId}.${input.currency}.${input.balance}.${input.timestamp}.${input.nonce}`;
}

export function verifyBalanceReply(
  secret: string,
  sessionToken: string,
  reply: BalanceReply,
  nowMs: number,
  skewMs = 120_000,
): void {
  const expected = createHmac('sha256', secret)
    .update(
      balanceSignatureInput({
        sessionId: sessionToken,
        currency: reply.currency,
        balance: reply.balanceRaw,
        timestamp: reply.timestamp,
        nonce: reply.nonce,
      }),
    )
    .digest();
  const given = Buffer.from(reply.signature.toLowerCase(), 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new WalletError(502, 'BALANCE_SIGNATURE_INVALID', 'Balance reply signature mismatch');
  }
  if (Math.abs(nowMs - reply.timestamp * 1000) > skewMs) {
    throw new WalletError(502, 'BALANCE_STALE', 'Balance reply timestamp outside allowed skew');
  }
}

interface WalletConfig {
  callbackUrl: string;
  hmacSecret: string;
  timeoutMs?: number;
}

export class HttpWalletClient implements WalletClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly cfg: WalletConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.timeoutMs = cfg.timeoutMs ?? 3000;
  }

  private async post(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    let response: Response;
    try {
      response = await this.fetchImpl(this.cfg.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-provider-signature': signBody(this.cfg.hmacSecret, raw) },
        body: raw,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const code = (error as Error)?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
      throw new WalletError(null, code, `Wallet call failed: ${(error as Error)?.message ?? code}`);
    }
    const payload = (await response.json().catch(() => ({}))) as {
      data?: Record<string, unknown>;
      error?: { code?: string; message?: string };
    };
    if (!response.ok) {
      throw new WalletError(
        response.status,
        payload.error?.code ?? 'WALLET_HTTP_ERROR',
        payload.error?.message ?? `Wallet responded ${response.status}`,
      );
    }
    return payload.data ?? {};
  }

  async balance(sessionToken: string, nonce: string): Promise<BalanceReply> {
    const data = await this.post({ type: 'balance', sessionId: sessionToken, nonce });
    const balanceRaw = String(data.balance);
    const opt = (value: unknown) => (value === undefined || value === null ? null : BigInt(String(value)));
    return {
      currency: String(data.currency),
      balance: BigInt(balanceRaw),
      balanceRaw,
      timestamp: Number(data.timestamp),
      nonce: String(data.nonce ?? nonce),
      signature: String(data.signature),
      minStake: opt(data.minStake),
      maxStake: opt(data.maxStake),
      maxWin: opt(data.maxWin),
    };
  }

  private async movement(type: 'bet' | 'win' | 'rollback', input: MovementInput): Promise<MovementReply> {
    const data = await this.post({
      type,
      sessionId: input.sessionToken,
      txnId: input.txnId,
      amount: input.amount.toString(),
      roundId: input.roundId,
    });
    return {
      accepted: Boolean(data.accepted),
      replayed: Boolean(data.replayed),
      balance: data.balance === undefined ? null : BigInt(String(data.balance)),
    };
  }

  bet(input: MovementInput) { return this.movement('bet', input); }
  win(input: MovementInput) { return this.movement('win', input); }
  rollback(input: MovementInput) { return this.movement('rollback', input); }
}
```

- [ ] **Step 4: Implement the fake bingo server**

`apps/games-provider/src/test/fakeBingo.ts`: an `http.createServer` that verifies the signature over the raw body with the same secret, enforces bingo's shapes (`sessionId` UUID, positive integer `amount`, currency match), keeps a session balance and a `Set` of `type:txnId` applied keys, applies `bet` (reject when balance < amount → `409 {error:{code:'INSUFFICIENT_FUNDS'}}`), `win`, `rollback` (404 when the bet was never applied), signs the balance reply with `balanceSignatureInput`, and exposes `url`, `token` (a fixed UUID), `state()`, `setLimits()`, `close()`. Support `betDelayMs` for the timeout test. It must return `{ data: ... }` envelopes exactly like bingo.

- [ ] **Step 5: Run tests**

Run: `npm run games:test`
Expected: 5 tests pass.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run games:typecheck`

```bash
git add apps/games-provider/src/server/wallet.ts apps/games-provider/src/test/fakeBingo.ts apps/games-provider/tests/wallet.test.ts
git commit -m "feat(games-provider): add signed operator wallet client with fake-bingo contract tests"
```

---

## Phase C — Gameplay core

### Task 8: Provably-fair math port

**Files:**
- Create: `apps/games-provider/src/domain/provablyFair.ts`
- Test: `apps/games-provider/tests/provablyFair.test.ts`

**Interfaces:**
- Produces: `multiplierAtElapsedMs(ms)`, `elapsedMsForMultiplier(m)`, `deriveCrashPointFromSha512Hex(hex)`, `buildCombinedSeedInput(serverSeed, [s1,s2,s3])`, `sha256Hex(input)`, `sha512Hex(input)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/games-provider/tests/provablyFair.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCombinedSeedInput, deriveCrashPointFromSha512Hex, elapsedMsForMultiplier,
  multiplierAtElapsedMs, sha512Hex,
} from '../src/domain/provablyFair';

test('curve matches the prototype pacing', () => {
  assert.equal(multiplierAtElapsedMs(0), 1);
  assert.equal(multiplierAtElapsedMs(11_500), 1.99);
  assert.equal(multiplierAtElapsedMs(11_560), 2);
  assert.equal(multiplierAtElapsedMs(38_380), 10);
});

test('elapsed and multiplier round-trip within one tick', () => {
  const ms = elapsedMsForMultiplier(5);
  assert.ok(multiplierAtElapsedMs(ms) >= 5);
  assert.ok(multiplierAtElapsedMs(ms - 60) <= 5);
});

test('derivation is deterministic for a digest', async () => {
  const digest = await sha512Hex(buildCombinedSeedInput('seed-a', ['1', '2', '3']));
  const a = deriveCrashPointFromSha512Hex(digest);
  const b = deriveCrashPointFromSha512Hex(digest);
  assert.equal(a.crashPoint, b.crashPoint);
  assert.ok(a.crashPoint >= 1);
});

test('one digest in 33 crashes instantly at 1.00x', async () => {
  for (let i = 0; i < 500; i += 1) {
    const digest = await sha512Hex(`probe-${i}`);
    const value = Number.parseInt(digest.slice(0, 13), 16);
    if (value % 33 !== 0) continue;
    assert.equal(deriveCrashPointFromSha512Hex(digest).crashPoint, 1);
    return;
  }
  assert.fail('no instant-crash digest found in 500 probes');
});

test('crash point never exceeds 100000x', async () => {
  for (let i = 0; i < 200; i += 1) {
    const digest = await sha512Hex(`cap-${i}`);
    assert.ok(deriveCrashPointFromSha512Hex(digest).crashPoint <= 100_000);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run games:test`
Expected: FAIL — module missing.

- [ ] **Step 3: Port the math**

Copy `multiplayer`-independent functions from `C:\Users\mekon\Documents\Projects\game-provider\src\shared\provablyFairCore.ts` verbatim into `src/domain/provablyFair.ts`, replacing the WebCrypto helpers with `node:crypto`:

```ts
import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha512Hex(input: string): string {
  return createHash('sha512').update(input).digest('hex');
}

export function deriveCrashPoint(digestHex: string): number {
  return deriveCrashPointFromSha512Hex(digestHex).crashPoint;
}
```

Keep `TWO_POW_52`, the `% 33` branch, the formula and the 100,000 cap unchanged.

- [ ] **Step 4: Run tests**

Run: `npm run games:test`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/games-provider/src/domain/provablyFair.ts apps/games-provider/tests/provablyFair.test.ts
git commit -m "feat(games-provider): port provably-fair crash math"
```

---

### Task 9: Round engine

**Files:**
- Create: `apps/games-provider/src/server/roundEngine.ts`
- Test: `apps/games-provider/tests/roundEngine.test.ts`

**Interfaces:**
- Produces: `RoundEngine` with `start()`, `stop()`, `placeBet(input)`, `cancelBet(input)`, `cashout(input)`, `snapshot()`. Consumed by Tasks 10, 13, 14, 15.
- Consumes: `Store`, `WalletClient`, `payoutFor`, `provablyFair`, `createMemoryStore`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/games-provider/tests/roundEngine.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoundEngine } from '../src/server/roundEngine';
import { createMemoryStore } from '../src/test/memoryStore';

function engine(store = createMemoryStore()) {
  const events: string[] = [];
  const instance = new RoundEngine({
    store,
    wallet: {} as never, // this test only exercises rounds, not bets
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 500 },
    operatorCode: 'bingo251',
    randomSeed: () => 'server-seed-fixed',
    clientSeeds: () => ['a', 'b', 'c'],
    onEvent: (event) => events.push(event.type),
  });
  return { instance, store, events };
}

test('a round is persisted before its betting broadcast', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { instance, store, events } = engine();
  await instance.start();
  const rounds = store.dump().rounds;
  assert.equal(rounds.length, 0); // created on the first loop tick
  await instance.tickOnce();
  assert.equal(store.dump().rounds.length, 1);
  assert.equal(events[0], 'round:betting');
  instance.stop();
});

test('takeoff persists the crash point before broadcasting it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { instance, store, events } = engine();
  await instance.start();
  await instance.tickOnce();
  await instance.tickOnce(5_500); // advance into FLYING
  const round = store.dump().rounds[0]!;
  assert.equal(round.status, 'FLYING');
  assert.ok(round.crashPoint && round.crashPoint >= 1);
  assert.ok(round.clientSeedComposite?.includes('a:b:c'));
  assert.deepEqual(events, ['round:betting', 'round:flying']);
  instance.stop();
});

test('crash persists the result and reveals the seed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { instance, store } = engine();
  await instance.start();
  await instance.tickOnce();
  await instance.tickOnce(5_500);
  const flightMs = instance.currentFlightMs();
  await instance.tickOnce(5_500 + flightMs);
  const round = store.dump().rounds[0]!;
  assert.equal(round.status, 'CRASHED');
  assert.ok(round.crashedAt);
  assert.equal(round.serverSeed, 'server-seed-fixed');
  instance.stop();
});

test('snapshot never exposes the crash point while flying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const { instance } = engine();
  await instance.start();
  await instance.tickOnce();
  await instance.tickOnce(5_500);
  assert.equal(instance.snapshot().crashPoint, null);
  assert.ok(instance.snapshot().multiplier >= 1);
  instance.stop();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run games:test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the engine**

Port `C:\Users\mekon\Documents\Projects\game-provider\server\crashEngine.ts`, with these mandatory changes:

1. Constructor takes `{ store, wallet, limits, operatorCode, randomSeed, clientSeeds, onEvent, now?, betManager? }`.
2. Phase transitions are `await`ed; the round row is committed before `onEvent({type:'round:betting'})`, the crash point before `round:flying`, and the result before `round:crashed` / `round:result`.
3. `roundId` is `store.createRound(...).id` — delete the fallback counter.
4. Expose `tickOnce(afterMs?)` (used by tests; production uses `setTimeout`/`setInterval`) and `currentFlightMs()`.
5. `snapshot()` returns `{ roundId, phase, multiplier, elapsedMs, bettingEndsInMs, players: [] }` and **never** `crashPoint` unless phase is `CRASHED`, where it also returns `serverSeed`, `serverSeedHash`, `clientSeedComposite`.
6. Bots are removed from the loop; `limits.maxBetsPerRound` rejects extra bet frames.
7. `stop()` clears timers; `start()` is idempotent.

The engine owns the timer chain; bet handling delegates to `betManager` (Task 10) once it exists — until then the three bet methods throw `new Error('bet handling not wired')`, replaced in Task 10.

- [ ] **Step 4: Run tests**

Run: `npm run games:test`
Expected: 4 tests pass.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run games:typecheck`

```bash
git add apps/games-provider/src/server/roundEngine.ts apps/games-provider/tests/roundEngine.test.ts
git commit -m "feat(games-provider): add persistence-first round engine"
```

---

### Task 10: Bet manager state machine

**Files:**
- Create: `apps/games-provider/src/server/betManager.ts`
- Modify: `apps/games-provider/src/server/roundEngine.ts` (delegate bet methods)
- Test: `apps/games-provider/tests/betManager.test.ts`

**Interfaces:**
- Produces: `BetManager` with `place({round, session, panel, stake, autoCashout})`, `cancel({round, session, panel})`, `cashout({round, session, panel, multiplier})`, `settleRound({round, maxWin})`.
- Consumes: `Store`, `WalletClient`, `payoutFor`, `randomUUID`.

- [ ] **Step 1: Write the failing test** — cover six behaviours with the memory store and an inline fake wallet:

```ts
// apps/games-provider/tests/betManager.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { BetManager } from '../src/server/betManager';
import { WalletError, type WalletClient, type MovementReply } from '../src/server/wallet';
import { createMemoryStore } from '../src/test/memoryStore';
import type { BetRecord, RoundRecord, SessionRecord } from '../src/domain/types';

function fixture(walletOverrides: Partial<WalletClient> = {}) {
  const store = createMemoryStore();
  const calls: Array<{ kind: string; amount: bigint; txnId: string }> = [];
  const wallet: WalletClient = {
    balance: async () => { throw new Error('unused'); },
    bet: async (input) => {
      calls.push({ kind: 'bet', amount: input.amount, txnId: input.txnId });
      return { accepted: true, replayed: false, balance: 9_000n } satisfies MovementReply;
    },
    win: async (input) => {
      calls.push({ kind: 'win', amount: input.amount, txnId: input.txnId });
      return { accepted: true, replayed: false, balance: 12_540n } satisfies MovementReply;
    },
    rollback: async (input) => {
      calls.push({ kind: 'rollback', amount: input.amount, txnId: input.txnId });
      return { accepted: true, replayed: false, balance: 10_000n } satisfies MovementReply;
    },
    ...walletOverrides,
  };
  const round: RoundRecord = {
    id: 1, serverSeed: 's', serverSeedHash: 'h', clientSeedComposite: null, crashPoint: null,
    status: 'BETTING', startedAt: new Date(0), flewAt: null, crashedAt: null,
  };
  const session: SessionRecord = {
    token: '11111111-1111-4111-8111-111111111111', operatorCode: 'bingo251', currency: 'ETB',
    minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, displayBalance: 10_000n,
    status: 'OPEN', createdAt: new Date(0), lastHandshakeAt: new Date(0),
  };
  const manager = new BetManager({
    store, wallet, limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 2 },
    now: () => new Date(1_000), newId: () => crypto.randomUUID(),
  });
  return { store, wallet, calls, round, session, manager };
}

test('a bet persists PLACING then ACTIVE and calls the wallet once', async () => {
  const { manager, store, calls, round, session } = fixture();
  const bet = await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null });
  assert.equal(bet.status, 'ACTIVE');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.kind, 'bet');
  assert.equal(calls[0]!.amount, 1_000n);
  assert.equal(store.dump().bets.length, 1);
});

test('out-of-range stakes are rejected without a wallet call', async () => {
  const { manager, calls, round, session } = fixture();
  for (const stake of [50n, 200_000n]) {
    await assert.rejects(manager.place({ round, session, panel: 0, stake, autoCashout: null }), /stake/i);
  }
  assert.equal(calls.length, 0);
});

test('a wallet 409 marks the bet REJECTED and surfaces the code', async () => {
  const { manager, round, session } = fixture({
    bet: async () => { throw new WalletError(409, 'INSUFFICIENT_FUNDS', 'no funds'); },
  });
  await assert.rejects(
    manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null }),
    (error: unknown) => error instanceof WalletError && error.code === 'INSUFFICIENT_FUNDS',
  );
});

test('a wallet timeout leaves the bet UNRESOLVED', async () => {
  const { manager, store, round, session } = fixture({
    bet: async () => { throw new WalletError(null, 'TIMEOUT', 'slow'); },
  });
  await assert.rejects(
    manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null }),
    (error: unknown) => error instanceof WalletError && error.code === 'TIMEOUT',
  );
  assert.equal(store.dump().bets[0]!.status, 'UNRESOLVED');
});

test('cashout stores the multiplier and enqueues a win with a fresh txn id', async () => {
  const { manager, store, round, session } = fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null });
  const winning = { ...round, status: 'FLYING' as const, crashPoint: 5 };
  await manager.cashout({ round: winning, session, panel: 0, multiplier: 2.54 });
  const bet = store.dump().bets[0]!;
  assert.equal(bet.status, 'CASHED');
  assert.equal(bet.payout, 2_540n);
  assert.notEqual(bet.winTxnId, bet.betTxnId);
  const outbox = store.dump().outbox;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.type, 'WIN');
  assert.equal(outbox[0]!.amount, 2_540n);
});

test('cancel before takeoff enqueues a rollback for the stake', async () => {
  const { manager, store, round, session } = fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: null });
  await manager.cancel({ round, session, panel: 0 });
  const bet = store.dump().bets[0]!;
  assert.equal(bet.status, 'CANCELLED');
  assert.equal(store.dump().outbox[0]!.type, 'ROLLBACK');
  assert.equal(store.dump().outbox[0]!.amount, 1_000n);
});

test('settling a crashed round marks uncashed ACTIVE bets LOST and caps payouts', async () => {
  const { manager, store, round, session } = fixture();
  await manager.place({ round, session, panel: 0, stake: 1_000n, autoCashout: 1.0 });
  await manager.settleRound({ round: { ...round, status: 'CRASHED', crashPoint: 1 }, maxWin: 30_000n });
  assert.equal(store.dump().bets[0]!.status, 'LOST');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run games:test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `BetManager`**

Rules to encode exactly:

```ts
async place({ round, session, panel, stake, autoCashout }) {
  if (round.status !== 'BETTING') throw new Error('Betting is closed');
  if (stake < limits.minStake || stake > limits.maxStake) throw new Error('Stake outside limits');
  if (autoCashout !== null && autoCashout < 1) throw new Error('Invalid auto cashout');
  const existing = await store.getBet(round.id, session.token, panel);
  if (existing) return existing;                       // idempotent frame replay
  if ((await store.listBetsForRound(round.id)).length >= limits.maxBetsPerRound) {
    throw new Error('Round bet limit reached');
  }
  const bet = await store.insertBet({
    roundId: round.id, operatorCode: session.operatorCode, sessionToken: session.token, panel,
    stake, autoCashout, status: 'PLACING', cashoutMultiplier: null, payout: null,
    betTxnId: newId(), winTxnId: null,
  });
  try {
    const reply = await wallet.bet({ sessionToken: session.token, txnId: bet.betTxnId, amount: stake, roundId: String(round.id) });
    await store.updateBet(bet.id, { status: 'ACTIVE' });
    if (reply.balance !== null) await store.setSessionBalance(session.token, reply.balance);
    return { ...bet, status: 'ACTIVE' as const };
  } catch (error) {
    const walletError = error as WalletError;
    const status = walletError.status === null ? 'UNRESOLVED' : 'REJECTED';
    await store.updateBet(bet.id, { status });
    throw error;
  }
}
```

`cashout` requires `round.status === 'FLYING'`, the bet `ACTIVE`, then:

```ts
const payout = payoutFor(bet.stake, multiplier, session.maxWin);
const winTxnId = newId();
await store.updateBet(bet.id, { status: 'CASHED', cashoutMultiplier: multiplier, payout, winTxnId, settledAt: now() });
await store.enqueueOutbox({ operatorCode: session.operatorCode, type: 'WIN', txnId: winTxnId, sessionToken: session.token, amount: payout });
```

`cancel` requires `round.status === 'BETTING'` and an `ACTIVE` bet; sets `CANCELLED` and enqueues a `ROLLBACK` with the **bet's** txnId and stake. `settleRound` marks remaining `ACTIVE` bets `LOST` (with `settledAt`) and leaves `CASHED`/`CANCELLED` untouched. A payout is additionally clamped to `round.maxWin` passed in.

Then replace the three throwing methods in `RoundEngine` with delegation to a `BetManager` injected via the constructor.

- [ ] **Step 4: Run tests**

Run: `npm run games:test`
Expected: 7 bet tests and 4 engine tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/games-provider/src/server/betManager.ts apps/games-provider/src/server/roundEngine.ts apps/games-provider/tests/betManager.test.ts
git commit -m "feat(games-provider): add bet state machine wired into the round engine"
```

---

### Task 11: Outbox worker

**Files:**
- Create: `apps/games-provider/src/server/outbox.ts`
- Test: `apps/games-provider/tests/outbox.test.ts`

**Interfaces:**
- Produces: `OutboxWorker` with `drainOnce(now)` → `{ sent, retried, capped, dead }`; `start(intervalMs)`, `stop()`. Consumed by boot (Task 15).

- [ ] **Step 1: Write the failing test** — seed the memory store with four outbox rows and a fake wallet that returns: success, `409 WIN_LIMIT_EXCEEDED`, `409 SESSION_CLOSED`, `500`. Assert `sent=1, capped=1, dead=1, retried=1`, that the retried row's `attempts` incremented and `nextAttemptAt` moved, and that a `SENT` row is not claimed again.

- [ ] **Step 2: Run to verify failure**

Run: `npm run games:test`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
async drainOnce(now: Date) {
  const due = await store.claimDueOutbox(now, 20);
  const summary = { sent: 0, retried: 0, capped: 0, dead: 0 };
  for (const row of due) {
    const input = { sessionToken: row.sessionToken, txnId: row.txnId, amount: row.amount, roundId: '' };
    try {
      if (row.type === 'WIN') await wallet.win(input);
      else await wallet.rollback(input);
      await store.markOutbox(row.id, 'SENT');
      summary.sent += 1;
    } catch (error) {
      const err = error as WalletError;
      if (err.code === 'WIN_LIMIT_EXCEEDED') {
        await store.markOutbox(row.id, 'CAP_REJECTED', err.code);
        summary.capped += 1;
      } else if (err.status !== null && err.status >= 400 && err.status < 500 &&
                 (err.code === 'SESSION_CLOSED' || err.code === 'TRANSACTION_ROLLED_BACK')) {
        await store.markOutbox(row.id, 'DEAD', err.code);
        summary.dead += 1;
      } else {
        const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
        await store.rescheduleOutbox(row.id, new Date(now.getTime() + delayMs), err.code);
        summary.retried += 1;
      }
    }
  }
  return summary;
}
```

`start` runs `drainOnce` every 1s with an overlap guard (`running` flag); `stop` clears the timer.

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npm run games:test && npm run games:typecheck`

```bash
git add apps/games-provider/src/server/outbox.ts apps/games-provider/tests/outbox.test.ts
git commit -m "feat(games-provider): add durable wallet outbox worker"
```

---

### Task 12: Boot recovery

**Files:**
- Create: `apps/games-provider/src/server/recovery.ts`
- Test: `apps/games-provider/tests/recovery.test.ts`

**Interfaces:**
- Produces: `runRecovery({ store, wallet, now })` → `{ abandonedRoundId, refundedBets, resolvedIndeterminate }`. Consumed by boot (Task 15) before `engine.start()`.

- [ ] **Step 1: Write the failing test** — seed the memory store with: a `FLYING` round with two `ACTIVE` bets, one `CASHED` bet with a `PENDING` win, and one `UNRESOLVED` bet. Assert: round becomes `ABANDONED`; two `ROLLBACK` outbox rows exist for the active bets; the cashout's win row is untouched; the unresolved bet's `bet` call is replayed (fake wallet records it) and a rollback is enqueued only when the replay reports accepted.

- [ ] **Step 2: Run to verify failure**

Run: `npm run games:test`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export async function runRecovery({ store, wallet, now }: RecoveryDeps) {
  const summary = { abandonedRoundId: null as number | null, refundedBets: 0, resolvedIndeterminate: 0 };

  const unfinished = await store.lastUnfinishedRound();
  if (unfinished) {
    await store.finishRound(unfinished.id, { status: 'ABANDONED', at: now() });
    summary.abandonedRoundId = unfinished.id;
    for (const bet of await store.listBetsForRound(unfinished.id)) {
      if (bet.status !== 'ACTIVE') continue;
      await store.updateBet(bet.id, { status: 'CANCELLED', settledAt: now() });
      await store.enqueueOutbox({
        operatorCode: bet.operatorCode, type: 'ROLLBACK', txnId: bet.betTxnId,
        sessionToken: bet.sessionToken, amount: bet.stake,
      });
      summary.refundedBets += 1;
    }
  }

  for (const bet of await store.listUnsettledBets()) {
    if (bet.status !== 'UNRESOLVED' && bet.status !== 'PLACING') continue;
    try {
      await wallet.bet({ sessionToken: bet.sessionToken, txnId: bet.betTxnId, amount: bet.stake, roundId: String(bet.roundId) });
      await store.enqueueOutbox({
        operatorCode: bet.operatorCode, type: 'ROLLBACK', txnId: bet.betTxnId,
        sessionToken: bet.sessionToken, amount: bet.stake,
      });
      await store.updateBet(bet.id, { status: 'CANCELLED', settledAt: now() });
    } catch (error) {
      const err = error as WalletError;
      if (err.code === 'TRANSACTION_ROLLED_BACK') {
        // The bet landed and was already refunded before the restart; no second rollback.
        await store.updateBet(bet.id, { status: 'CANCELLED', settledAt: now() });
      } else if (err.status !== null && err.status >= 400 && err.status < 500) {
        await store.updateBet(bet.id, { status: 'REJECTED', settledAt: now() });
      }
      // transport errors leave the row UNRESOLVED; the next boot retries
    }
    summary.resolvedIndeterminate += 1;
  }

  return summary;
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npm run games:test && npm run games:typecheck`

```bash
git add apps/games-provider/src/server/recovery.ts apps/games-provider/tests/recovery.test.ts
git commit -m "feat(games-provider): refund interrupted rounds on boot"
```

---

## Phase D — API surface and deployment

### Task 13: Handshake, session close and proof endpoints

**Files:**
- Create: `apps/games-provider/src/server/handshake.ts`
- Modify: `apps/games-provider/src/server/http.ts`
- Test: `apps/games-provider/tests/http.test.ts`

**Interfaces:**
- Produces: `POST /api/sessions/handshake` → `{ data: { sessionId, currency, balance, limits, expiresAt } }`; `POST /api/sessions/close`; `GET /api/rounds/:id/proof`. `AppDeps` becomes `{ config, store, wallet }` (the engine is attached at the socket layer in Task 14, not inside the HTTP app).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/games-provider/tests/http.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createFakeBingo } from '../src/test/fakeBingo';
import { createMemoryStore } from '../src/test/memoryStore';
import { createApp } from '../src/server/http';
import { HttpWalletClient } from '../src/server/wallet';
import { loadConfig } from '../src/config';

async function boot(fake: Awaited<ReturnType<typeof createFakeBingo>>) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CALLBACK_URL: `${fake.url}/api/games/callback/stratos`,
    OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
  });
  const store = createMemoryStore();
  const wallet = new HttpWalletClient({ callbackUrl: config.operator.callbackUrl, hmacSecret: config.operator.hmacSecret });
  const server = createApp({ config, store, wallet }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, store };
}

test('handshake stores the session and returns signed limits', async () => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 50_000n, currency: 'ETB' });
  const { server, base, store } = await boot(fake);
  const response = await fetch(`${base}/api/sessions/handshake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: fake.token }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.balance, '50000');
  assert.equal(body.data.limits.minStake, '100');
  assert.equal(store.dump().sessions.length, 1);
  server.close(); await fake.close();
});

test('a closed bingo session answers 410', async () => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB', sessionOpen: false });
  const { server, base } = await boot(fake);
  const response = await fetch(`${base}/api/sessions/handshake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: fake.token }),
  });
  assert.equal(response.status, 410);
  server.close(); await fake.close();
});

test('proof is available only after the round crashed', async () => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB' });
  const { server, base, store } = await boot(fake);
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: new Date() });
  const flying = await fetch(`${base}/api/rounds/${round.id}/proof`);
  assert.equal(flying.status, 409);
  await store.startFlight(round.id, { crashPoint: 2.5, clientSeedComposite: 'a:b:c', at: new Date() });
  await store.finishRound(round.id, { status: 'CRASHED', at: new Date() });
  const ok = await fetch(`${base}/api/rounds/${round.id}/proof`);
  const body = await ok.json();
  assert.equal(body.data.serverSeed, 's');
  assert.equal(body.data.crashPoint, 2.5);
  server.close(); await fake.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run games:test`
Expected: FAIL (routes missing).

- [ ] **Step 3: Implement `handshake.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config';
import type { Store } from './store';
import { WalletError, verifyBalanceReply, type WalletClient } from './wallet';

export class SessionEndedError extends Error {
  constructor(message = 'Game session is closed') { super(message); this.name = 'SessionEndedError'; }
}

export async function handshake(input: {
  token: string; config: AppConfig; store: Store; wallet: WalletClient; now?: Date;
}) {
  const now = input.now ?? new Date();
  const nonce = randomUUID();
  let reply;
  try {
    reply = await input.wallet.balance(input.token, nonce);
  } catch (error) {
    if (error instanceof WalletError && error.status !== null && error.status >= 400 && error.status < 500) {
      throw new SessionEndedError();
    }
    throw error;
  }
  verifyBalanceReply(input.config.operator.hmacSecret, input.token, reply, now.getTime());
  if (reply.currency !== input.config.operator.currency) {
    throw new Error(`Currency mismatch: bingo settles ${reply.currency}`);
  }
  const session = {
    token: input.token,
    operatorCode: input.config.operator.code,
    currency: reply.currency,
    minStake: reply.minStake ?? input.config.limits.minStake,
    maxStake: reply.maxStake ?? input.config.limits.maxStake,
    maxWin: reply.maxWin ?? input.config.limits.maxWin,
    displayBalance: reply.balance,
    status: 'OPEN' as const,
    createdAt: now,
    lastHandshakeAt: now,
  };
  await input.store.saveSession(session);
  return session;
}
```

- [ ] **Step 4: Extend `http.ts`**

Add `express.json({ limit: '32kb' })`, the static client + SPA fallback in production, the three endpoints, and CSP headers. The client is emitted to `apps/games-provider/dist/client`, while the process runs from the repo root, so resolve the directory from this module:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = path.resolve(fileURLToPath(new URL('../../dist/client', import.meta.url)));
app.use('/play', express.static(clientDir));
app.get(['/play', '/play/*'], (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
```

```ts
app.use((_req, res, next) => {
  const origins = deps.config.allowedParentOrigins.join(' ');
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${origins}`.trim());
  next();
});
```

Handshake route: validate `{token}` is a UUID (`z.string().uuid()`), call `handshake`, respond `{data:{sessionId, currency, balance: displayBalance.toString(), limits:{minStake, maxStake, maxWin}, expiresAt: new Date(Date.now()+2*3600_000).toISOString()}}`; map `SessionEndedError` → 410 `{error:{code:'SESSION_CLOSED'}}`; map any `WalletError` whose `status` is `null` (transport/timeout) or ≥ 500 → 502 `{error:{code:'WALLET_UNAVAILABLE'}}`.

Close route: validate `{token}` as a UUID, call `store.closeSession(token)` (no error when the token is unknown — closing twice is a no-op), respond `{data:{closed:true}}`.

Proof route: 404 unknown, 409 `ROUND_NOT_FINISHED` unless `CRASHED`, else `{data:{roundId, serverSeed, serverSeedHash, clientSeedComposite, crashPoint, startedAt, flewAt, crashedAt}}`.

- [ ] **Step 5: Run tests**

Run: `npm run games:test`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/games-provider/src/server/handshake.ts apps/games-provider/src/server/http.ts apps/games-provider/tests/http.test.ts
git commit -m "feat(games-provider): add session handshake and round proof endpoints"
```

---

### Task 14: WebSocket gateway

**Files:**
- Create: `apps/games-provider/src/server/socket.ts`
- Modify: `apps/games-provider/src/server/http.ts` (attach server) or `server.ts` (create `WebSocketServer` on the HTTP server)
- Test: `apps/games-provider/tests/socket.test.ts`

**Interfaces:**
- Produces: `attachSocket({ server, store, engine, wallet, config })`; message contracts `auth`, `bet:place`, `bet:cancel`, `bet:cashout` and server events `snapshot`, `round:betting`, `round:tick`, `round:crashed`, `bet:update`, `balance:update`, `session:ended`, `error`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/games-provider/tests/socket.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createFakeBingo } from '../src/test/fakeBingo';
import { createMemoryStore } from '../src/test/memoryStore';
import { HttpWalletClient } from '../src/server/wallet';
import { loadConfig } from '../src/config';
import { handshake } from '../src/server/handshake';
import { startTestServer } from '../src/test/server';

test('a client must auth before betting, and snapshots hide the crash point', async () => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 10_000n, currency: 'ETB' });
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CALLBACK_URL: `${fake.url}/api/games/callback/stratos`,
    OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
  });
  const store = createMemoryStore();
  const wallet = new HttpWalletClient({ callbackUrl: config.operator.callbackUrl, hmacSecret: config.operator.hmacSecret });
  await handshake({ token: fake.token, config, store, wallet });
  // boot an http+socket server through the shared helper `startTestServer({config, store, wallet})`
  // (exported from src/test/server.ts in this task; see step 3)
  const { url, close } = await startTestServer({ config, store, wallet });
  const ws = new WebSocket(url);
  const messages: any[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => ws.on('open', resolve));

  ws.send(JSON.stringify({ type: 'bet:place', panel: 0, stake: '1000' }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.at(-1)?.type, 'error');
  assert.equal(messages.at(-1)?.code, 'NOT_AUTHED');

  ws.send(JSON.stringify({ type: 'auth', token: fake.token }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const snapshot = messages.find((m) => m.type === 'snapshot');
  assert.ok(snapshot);
  assert.equal('crashPoint' in snapshot ? snapshot.crashPoint : null, null);

  ws.close(); await close(); await fake.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run games:test`
Expected: FAIL.

- [ ] **Step 3: Implement `socket.ts` and `src/test/server.ts`**

`attachSocket` keeps a `Map<WebSocket, {sessionToken?: string}>`, rejects any non-`auth` frame before auth with `{type:'error', code:'NOT_AUTHED'}`, validates `auth` by `store.getSession(token)` (closed/unknown → `{type:'session:ended'}` + close), sends `snapshot` on success, forwards `bet:place`/`bet:cancel`/`bet:cashout` to `engine` (mapping `WalletError` codes to `{type:'error', code, message}`), and broadcasts engine events to authed sockets. Heartbeat: `ping` every 30s, terminate unresponsive sockets.

`startTestServer` creates an HTTP server from `createApp`, attaches the socket and a `RoundEngine` on an ephemeral port, returns `{ url, close }`.

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npm run games:test && npm run games:typecheck`

```bash
git add apps/games-provider/src/server/socket.ts apps/games-provider/src/test/server.ts apps/games-provider/tests/socket.test.ts
git commit -m "feat(games-provider): add authenticated websocket gateway"
```

---

### Task 15: Boot sequence, deployment artifacts and smoke script

**Files:**
- Modify: `apps/games-provider/server.ts`
- Create: `Dockerfile.games`, `Procfile.games`, `apps/games-provider/.env.example`, `apps/games-provider/README.md`, `apps/games-provider/scripts/smoke.ts`
- Modify: `docs/DEPLOY.md` (new section)
- Modify: root `package.json` (`games:smoke`)

**Interfaces:**
- Produces: production boot order `migrate → seed operator → runRecovery → outbox.start → engine.start → listen`; graceful `SIGTERM`.

- [ ] **Step 1: Write the boot entry**

```ts
// apps/games-provider/server.ts
import 'dotenv/config';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './src/config';
import { createDb } from './src/db';
import { createPostgresStore } from './src/db/storePostgres';
import { createApp } from './src/server/http';
import { attachSocket } from './src/server/socket';
import { HttpWalletClient } from './src/server/wallet';
import { OutboxWorker } from './src/server/outbox';
import { runRecovery } from './src/server/recovery';
import { RoundEngine } from './src/server/roundEngine';
import { BetManager } from './src/server/betManager';

const config = loadConfig();
const database = createDb(config.databaseUrl);
await database.migrate();
const store = createPostgresStore(database.db);
await store.upsertOperator({
  code: config.operator.code,
  name: 'Bingo 251',
  callbackUrl: config.operator.callbackUrl,
  hmacSecret: config.operator.hmacSecret,
  currency: config.operator.currency,
  enabled: true,
});
const wallet = new HttpWalletClient({ callbackUrl: config.operator.callbackUrl, hmacSecret: config.operator.hmacSecret });
const outbox = new OutboxWorker({ store, wallet });
await runRecovery({ store, wallet, now: () => new Date() });
outbox.start(1000);
const limits = { ...config.limits, maxBetsPerRound: 200 };
const betManager = new BetManager({ store, wallet, limits, now: () => new Date(), newId: () => randomUUID() });
const engine = new RoundEngine({ store, wallet, betManager, operatorCode: config.operator.code, limits, randomSeed: () => randomUUID(), clientSeeds: () => ['slot-1', 'slot-2', 'slot-3'], onEvent: () => {} });
const server = createServer(createApp({ config, store, wallet }));
attachSocket({ server, store, engine, wallet, config });
server.listen(config.port, () => console.log(`games-provider listening on ${config.port}`));
await engine.start();

const shutdown = async () => {
  engine.stop();
  outbox.stop();
  server.close();
  await database.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

Wire `onEvent` to the socket broadcaster (Task 14 exposes `broadcast`).

- [ ] **Step 2: Write deployment files**

`Procfile.games`:

```
web: node --import tsx apps/games-provider/server.ts
```

`Dockerfile.games` mirrors `Dockerfile.api`: `COPY package.json package-lock.json`, the three workspace manifests (`apps/api`, `apps/web`, `apps/games-provider`), `npm ci`, `COPY apps/games-provider apps/games-provider`, `RUN npm run build -w @bingo/games-provider && npm prune --omit=dev`, then a runtime image with `apps/games-provider` (including its built `dist/client`), `EXPOSE 3001`, and `CMD ["node", "--import", "tsx", "apps/games-provider/server.ts"]`. `vite` and `tsx` are production dependencies, so pruning keeps them.

`.env.example` (placeholders only):

```
PORT=3001
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME
OPERATOR_CODE=bingo251
OPERATOR_CALLBACK_URL=https://api.example.com/api/games/callback/stratos
OPERATOR_HMAC_SECRET=REPLACE_WITH_BINGO_PROVIDER_SECRET
OPERATOR_CURRENCY=ETB
ALLOWED_PARENT_ORIGINS=https://app.example.com
GAME_MIN_STAKE=100
GAME_MAX_STAKE=100000
GAME_MAX_WIN=3000000
BOT_COUNT=0
```

- [ ] **Step 3: Document Dokku setup** in `docs/DEPLOY.md`

```bash
dokku apps:create bingo-crash
dokku postgres:create bingo-crash-db
dokku postgres:link bingo-crash-db bingo-crash
dokku builder-dockerfile:set bingo-crash dockerfile-path Dockerfile.games
dokku ps:set bingo-crash procfile-path Procfile.games
dokku ports:set bingo-crash http:80:3001
dokku ps:scale bingo-crash web=1
git remote add dokku-crash dokku@YOUR_VPS:bingo-crash
```

plus the `dokku config:set bingo-crash …` block (placeholder values, secret typed by the operator), domain + letsencrypt, and a note that scaling above 1 is unsupported.

- [ ] **Step 4: Write the smoke script**

`scripts/smoke.ts` connects to `DATABASE_URL`, applies migrations, inserts a fake session and round, runs `runRecovery` twice (assert idempotent), and prints a summary. Registered as `games:smoke` in root scripts.

- [ ] **Step 5: Verify build**

Run: `npm run games:build`
Expected: `apps/games-provider/dist/client/index.html` exists. The boot path itself is exercised in the acceptance run (Task 17) because it needs a database.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile.games Procfile.games apps/games-provider package.json docs/DEPLOY.md
git commit -m "feat(games-provider): add boot sequence and Dokku deployment artifacts"
```

---

## Phase E — Client and acceptance

### Task 16: Strip the client to the game surface and wire the bridge

**Files:**
- Copy from prototype: `src/client/components/aviator/**`, `src/client/hooks/useAviatorSocket.ts`, `src/client/utils/soundEngine.ts`, `src/client/index.css`
- Create: `apps/games-provider/src/main.tsx`, `apps/games-provider/src/client/App.tsx`, `apps/games-provider/src/client/bridge.ts`, `apps/games-provider/src/client/i18n.ts`
- Delete from the copy: `components/operator`, `components/superadmin`, `components/portal`, `ProvablyFairModal` retained (proof verify still useful), all Firebase/JWT references

**Interfaces:**
- Consumes: handshake API, WS messages from Task 14, `bingo:theme` / `bingo:locale` / `bingo:haptic` / `bingo:exit` from Task 3.
- Produces: the `/play` SPA entry.

- [ ] **Step 1: Write `bridge.ts`** — accepts parent messages only when `event.origin` equals the origin of `document.referrer` (the bingo play page that framed us), applying colors to CSS variables:

```ts
export interface ThemeMessage {
  type: 'bingo:theme';
  payload: { scheme: 'dark' | 'light'; bg: string; panel: string; text: string; hint: string; button: string; buttonText: string; gold: string; danger: string; safeBottom: number; viewportHeight: number };
}

export function installBridge(handlers: { onLocale: (lang: 'en' | 'am') => void }) {
  window.addEventListener('message', (event) => {
    const parent = document.referrer ? new URL(document.referrer).origin : null;
    if (!parent || event.origin !== parent) return;
    if (event.data?.type === 'bingo:theme') {
      const payload = (event.data as ThemeMessage).payload;
      const root = document.documentElement;
      root.dataset.scheme = payload.scheme;
      root.style.setProperty('--g-bg', payload.bg);
      root.style.setProperty('--g-panel', payload.panel);
      root.style.setProperty('--g-text', payload.text);
      root.style.setProperty('--g-hint', payload.hint);
      root.style.setProperty('--g-accent', payload.button);
      root.style.setProperty('--g-on-accent', payload.buttonText);
      root.style.setProperty('--g-gold', payload.gold);
      root.style.setProperty('--g-danger', payload.danger);
    }
    if (event.data?.type === 'bingo:locale') handlers.onLocale(event.data.payload);
  });
}

export function haptic(kind: 'tap' | 'success' | 'error') {
  window.parent.postMessage({ type: 'bingo:haptic', payload: kind }, '*');
}

export function exitGame() {
  window.parent.postMessage({ type: 'bingo:exit' }, '*');
}
```

Posting to `'*'` is acceptable only because the parent validates the provider origin; document this in a code comment for the reviewer.

- [ ] **Step 2: Strip `App.tsx`** to a single `AviatorWorkspace` render, delete the TopBar/nav/views, remove the top-up button and profile/rename calls; replace palette classes with the CSS variables (`bg-[var(--g-bg)]`, `text-[var(--g-text)]`, etc.) and keep the canvas visuals.

- [ ] **Step 3: Wire boot** — read `token` and `lang` from the query string, `POST /api/sessions/handshake`, show a terminal "session ended" screen on 410, then `useAviatorSocket(token)` (adapted to the new message names), and send `bingo:exit` on session end.

- [ ] **Step 4: Add EN/AM strings** in `i18n.ts`:

```ts
export const strings = {
  en: { place: 'Place bet', cashout: 'Cash out', next: 'Next round in', balance: 'Balance', crashed: 'Crashed at', ended: 'Session ended', back: 'Back to games', tap: 'Tap to bet' },
  am: { place: 'ውርርድ አስቀምጥ', cashout: 'አሁን ውጣ', next: 'ቀጣዩ ዙር በ', balance: 'ቀሪ ሂሳብ', crashed: 'የተቋረጠበት', ended: 'ክፍለ ጊዜው አብቅቷል', back: 'ወደ ጨዋታዎች', tap: 'ለመወራረድ ይንኩ' },
} as const;
```

Trigger `haptic('tap')` on bet, `haptic('success')` on cashout, `haptic('error')` on rejection.

- [ ] **Step 5: Verify build and browser**

Run: `npm run games:build`
Expected: clean build, no Firebase/JWT/recharts imports remain (`grep -r "firebase\|jsonwebtoken\|recharts" apps/games-provider/src || echo clean`).

Run `npm run games:dev` and open `http://localhost:3000/play?token=<uuid>` against a running fake bingo or the deployed bingo; verify the game renders, a bet places, and the theme falls back gracefully without a parent.

- [ ] **Step 6: Commit**

```bash
git add apps/games-provider/src apps/games-provider/index.html
git commit -m "feat(games-provider): ship the game client with telegram bridge and bilingual UI"
```

---

### Task 17: Acceptance run and V2 gate

**Files:**
- Create: `docs/superpowers/plans/2026-11-17-games-provider-v1-acceptance.md` (checklist results, filled during the run)
- Modify: `docs/superpowers/specs/2026-11-17-games-provider-design.md` (mark status `implemented`, add the GET-session endpoint to the bingo-side list)

**Interfaces:** none (verification only).

- [ ] **Step 1: Run every suite**

```bash
npm run test -w @bingo/api
npm run games:test
npm run typecheck
npm run games:typecheck
npm run games:build
```

Expected: all green. Record the counts in the acceptance file.

- [ ] **Step 2: Deploy bingo changes** (user-run; paste the exact commands from Task 1-3's commits and `docs/DEPLOY.md`).

- [ ] **Step 3: Deploy provider** (user-run; `git push dokku-crash main` after the Dokku setup commands).

- [ ] **Step 4: Register the provider and game in bingo admin**

Provider: code `stratos`, kind matching other integrated providers, currency `ETB`, `webhookSecret` = the same value as `OPERATOR_HMAC_SECRET`, `apiBaseUrl` = provider origin.
Game: `externalId` `crash`, name `Crash`, category `Crash`, `launchUrlTemplate` `https://<crash-host>/play?token={token}&lang={lang}&currency={currency}`, minStake `100`, maxStake `100000`, maxWin `3000000`, enabled.

- [ ] **Step 5: Manual E2E in Telegram** — record each result:
  1. Launch from the lobby inside the TMA; iframe fills the screen; theme matches bingo.
  2. Place a bet, cash out at ~2x; bingo history shows the bet and the win with the same amounts.
  3. Lose a round; only the bet appears.
  4. Cancel a bet during betting; refund appears.
  5. Close and reopen the game; session restores.
  6. Kill the provider mid-flight (`dokku ps:stop bingo-crash`, then start); after restart the interrupted round's stakes are refunded and a new round starts.
  7. Open a finished round's proof endpoint and verify it in the browser.
  8. Switch language in bingo; the game's strings switch.
  9. Resize to 360px width; no horizontal scroll.

- [ ] **Step 6: Fix anything that fails, then mark the design implemented**

- [ ] **Step 7: Write the V2 requirements document** — `docs/superpowers/specs/<date>-games-provider-v2-requirements.md` covering: bots with exposure caps, second game, per-operator theming, chat + rain, provider admin console, multi-instance story, additional operators. Do not write any V2 code. Present it for review and testing; V2 implementation begins only after explicit approval.

- [ ] **Step 8: Commit**

```bash
git add docs
git commit -m "docs: record games-provider v1 acceptance and mark design implemented"
```

---

## Self-review notes

- **Spec coverage:** every spec section maps to a task — §3 boundaries → Tasks 4-6, 15; §4 wallet contract → Tasks 7, 13; §5 engine/states/recovery → Tasks 8-12; §6 client/bridge → Tasks 3, 16; §7 bingo changes → Tasks 1-3; §8 deployment → Task 15; §9 testing → per-task tests + Task 17; §10 rollout → Task 17; §11 V2 gate → Task 17.
- **Type consistency:** `WalletClient.balance/bet/win/rollback`, `Store` methods, `BetRecord.status`, and `OutboxStatus` names are used identically across Tasks 5-15. `MovementReply.balance` is nullable; every consumer null-checks it. `AppDeps` is `{config, store, wallet}` everywhere; the engine reaches HTTP only through `attachSocket`.
- **Runtime shape:** production runs `server.ts` through `tsx` (top-level await, extensionless ESM imports), so `tsc` is typecheck-only and `vite` emits `dist/client` alone. `tsx` and `vite` are production dependencies because the image prunes dev dependencies. The static client path is resolved from `import.meta.url`, not the process cwd.
- **Command shape:** filtered runs are avoided because `npm run test -w … -- <file>` appends to `node --test`'s glob; the plan runs whole suites (`npm run test -w @bingo/api`, `npm run games:test`) instead. Suites are unit-only, so the cost is negligible.
- **Money edge cases covered:** a `TRANSACTION_ROLLED_BACK` replay during recovery ends `CANCELLED` with no second rollback; a transport failure leaves the bet `UNRESOLVED` for the next boot; win settlement keeps the fresh win txn id so rollback lookup by bet txn id stays unambiguous.
- **Known gap:** the Postgres store (Task 6) is not unit-tested; it is covered by the smoke script and the acceptance run. This is deliberate — the local environment has no database, and a fake DB would test the fake.
- **Deliberate staging:** Task 9 ships `RoundEngine` with bet methods that throw; Task 10 replaces them with `BetManager` delegation. The Task 9 tests never touch bets, so each task still ends green.
- **Deliberate deviation:** the plan adds `GET /api/games/sessions/:sessionId` (Task 2), which the design doc lists only implicitly under the play page; the design doc is updated in Task 17.
