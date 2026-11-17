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
- Modify: `apps/games-provider/src/server/store.ts` (add `listSettledBetsMissingOutbox()`)
- Modify: `apps/games-provider/src/db/storePostgres.ts` (implement it)
- Modify: `apps/games-provider/src/test/memoryStore.ts` (implement it)
- Test: `apps/games-provider/tests/recovery.test.ts`

**Interfaces:**
- Produces: `runRecovery({ store, wallet, now? })` → `{ abandonedRoundIds, refundedBets, lostBets, resolvedIndeterminate, repairedSettlements }`. Consumed by boot (Task 15) before `engine.start()`.
- Consumes: `Store.lastUnfinishedRound()`, `Store.listBetsForRound()`, `Store.listUnsettledBets()`, `Store.listSettledBetsMissingOutbox()`, `Store.enqueueOutbox()` (keyed by operator+type+txnId, so re-enqueueing is a no-op), `wallet.bet()`.
- Produces for the store: `listSettledBetsMissingOutbox(): Promise<BetRecord[]>` — every `CASHED` bet whose `winTxnId` has no `WIN` outbox row plus every `CANCELLED` bet whose `betTxnId` has no `ROLLBACK` outbox row.

- [ ] **Step 1: Write the failing test** — seed the memory store with: a `FLYING` round with two `ACTIVE` bets, one `CASHED` bet with a `PENDING` win, one `CASHED` bet whose win row is missing, one `CANCELLED` bet whose rollback row is missing, and one `UNRESOLVED` bet. Assert: the round becomes `ABANDONED`; a `ROLLBACK` row exists for each active bet with its `betTxnId` and stake; the existing win row is untouched and not duplicated; the two orphaned terminal bets get their `WIN` (winTxnId, payout) / `ROLLBACK` (betTxnId, stake) rows; the unresolved bet's `bet` call is replayed with the original txnId and a rollback enqueued only when the reply reports accepted/replayed; a 2xx `accepted:false` reply and a 5xx leave the row `UNRESOLVED`. Additional cases: an `ACTIVE` bet in an already-`ABANDONED` round (a pass that died mid-refund) is refunded; an `ACTIVE` bet in a `CRASHED` round is marked `LOST` with no outbox row; a 500 whose body carries `TRANSACTION_ROLLED_BACK` stays `UNRESOLVED` (only 4xx is definitive); a 409 `TRANSACTION_ROLLED_BACK` cancels the bet and writes a `SENT` tombstone (status SENT, `lastError` `ALREADY_ROLLED_BACK`) so a second `runRecovery` is a clean no-op.

- [ ] **Step 2: Run to verify failure**

Run: `npm run games:test`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export interface RecoverySummary {
  abandonedRoundIds: number[];
  refundedBets: number;
  lostBets: number;
  resolvedIndeterminate: number;
  repairedSettlements: number;
}

export async function runRecovery(deps: RecoveryDeps): Promise<RecoverySummary> {
  const now = deps.now ?? (() => new Date());
  const { store, wallet } = deps;
  const summary: RecoverySummary = {
    abandonedRoundIds: [], refundedBets: 0, lostBets: 0, resolvedIndeterminate: 0, repairedSettlements: 0,
  };

  // Snapshot before any repair: a bet this pass cancels without a rollback (the
  // wallet reports it already rolled back) is not an orphan.
  const orphanedSettlements = await store.listSettledBetsMissingOutbox();

  // Abandon every unfinished round (normally at most one; the loop heals a
  // previous pass that died before it recorded the abandonment).
  for (let round = await store.lastUnfinishedRound(); round !== null; round = await store.lastUnfinishedRound()) {
    await store.finishRound(round.id, { status: 'ABANDONED', at: now() });
    summary.abandonedRoundIds.push(round.id);
  }

  for (const bet of await store.listUnsettledBets()) {
    if (bet.status === 'ACTIVE') {
      // A crash between `finishRound(ABANDONED)` and this refund (or a crash
      // before settleRound swept a CRASHED round) leaves the bet ACTIVE; the
      // round's status, not the previous pass's progress, decides its fate.
      const round = await store.getRound(bet.roundId);
      if (round !== null && round.status === 'CRASHED') {
        await store.updateBet(bet.id, { status: 'LOST', settledAt: now() });
        summary.lostBets += 1;
      } else {
        // Abandoned or unknown round: the stake was charged and there is no
        // outcome, so refund it.
        await refundBet(store, bet, now);
        summary.refundedBets += 1;
      }
      continue;
    }
    if (await resolveIndeterminate(store, wallet, bet, now)) summary.resolvedIndeterminate += 1;
  }

  for (const bet of orphanedSettlements) {
    if (bet.status === 'CASHED') {
      if (bet.winTxnId === null || bet.payout === null) {
        console.error('recovery: cashed bet without win txn', bet.id);
        continue;
      }
      await store.enqueueOutbox({
        operatorCode: bet.operatorCode, type: 'WIN', txnId: bet.winTxnId,
        sessionToken: bet.sessionToken, amount: bet.payout,
      });
    } else {
      await store.enqueueOutbox({
        operatorCode: bet.operatorCode, type: 'ROLLBACK', txnId: bet.betTxnId,
        sessionToken: bet.sessionToken, amount: bet.stake,
      });
    }
    summary.repairedSettlements += 1;
  }

  return summary;
}

async function refundBet(store: Store, bet: BetRecord, now: () => Date): Promise<void> {
  await store.updateBet(bet.id, { status: 'CANCELLED', settledAt: now() });
  await store.enqueueOutbox({
    operatorCode: bet.operatorCode, type: 'ROLLBACK', txnId: bet.betTxnId,
    sessionToken: bet.sessionToken, amount: bet.stake,
  });
}

async function resolveIndeterminate(store: Store, wallet: WalletClient, bet: BetRecord, now: () => Date): Promise<boolean> {
  try {
    const reply = await wallet.bet({
      sessionToken: bet.sessionToken, txnId: bet.betTxnId,
      amount: bet.stake, roundId: String(bet.roundId),
    });
    // A 2xx that accepts nothing is still ambiguous: leave it for the next boot.
    if (!reply.accepted && !reply.replayed) return false;
    await refundBet(store, bet, now);
    return true;
  } catch (error) {
    if (error instanceof WalletError) {
      // Only a 4xx status is definitive, whatever code the body carries.
      const isClientError = error.status !== null && error.status >= 400 && error.status < 500;
      if (isClientError && error.code === 'TRANSACTION_ROLLED_BACK') {
        // The charge landed and was refunded before the restart: cancel it and
        // leave a SENT tombstone so later boots do not mistake the CANCELLED bet
        // for an orphan and fabricate a delivery.
        await store.updateBet(bet.id, { status: 'CANCELLED', settledAt: now() });
        const row = await store.enqueueOutbox({
          operatorCode: bet.operatorCode, type: 'ROLLBACK', txnId: bet.betTxnId,
          sessionToken: bet.sessionToken, amount: bet.stake,
        });
        if (row !== null) await store.markOutbox(row.id, 'SENT', 'ALREADY_ROLLED_BACK');
        return true;
      }
      if (isClientError) {
        await store.updateBet(bet.id, { status: 'REJECTED', settledAt: now() });
        return true;
      }
    }
    // Transport failures and 5xx leave the row UNRESOLVED; the next boot retries.
    return false;
  }
}
```

Store contract additions (both stores, same semantics):

```ts
// memory
async listSettledBetsMissingOutbox() {
  return [...bets.values()]
    .filter((bet) => {
      if (bet.status === 'CASHED') {
        return bet.winTxnId !== null && !outboxIds.has(outboxKey(bet.operatorCode, 'WIN', bet.winTxnId));
      }
      if (bet.status === 'CANCELLED') {
        return !outboxIds.has(outboxKey(bet.operatorCode, 'ROLLBACK', bet.betTxnId));
      }
      return false;
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(clone);
}
```

Postgres: select `CASHED`/`CANCELLED` bets, collect `winTxnId`/`betTxnId`, select the matching `walletOutbox` `(operatorCode, type, txnId)` keys with `inArray(walletOutbox.txnId, ids)`, return the bets whose key is absent. No schema change.

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npm run games:test && npm run games:typecheck`

```bash
git add apps/games-provider/src/server/recovery.ts apps/games-provider/tests/recovery.test.ts apps/games-provider/src/server/store.ts apps/games-provider/src/db/storePostgres.ts apps/games-provider/src/test/memoryStore.ts
git commit -m "feat(games-provider): refund interrupted rounds on boot"
```

---

## Phase D — API surface and deployment

### Task 13: Handshake, session close and proof endpoints

**Files:**
- Create: `apps/games-provider/src/server/handshake.ts`
- Modify: `apps/games-provider/src/server/http.ts`
- Modify: `apps/games-provider/src/test/fakeBingo.ts` (add the `sessionOpen` option)
- Modify: `apps/games-provider/server.ts` and `apps/games-provider/tests/health.test.ts` (new `AppDeps` shape)
- Test: `apps/games-provider/tests/http.test.ts`

**Interfaces:**
- Produces: `POST /api/sessions/handshake` → `{ data: { sessionId, gameId: 'crash', currency, balance, limits, expiresAt } }`; `POST /api/sessions/close` → `{ data: { closed: true } }`; `GET /api/rounds/:id/proof`. `AppDeps` becomes `{ config, store, wallet }` (the engine is attached at the socket layer in Task 14, not inside the HTTP app).

**Rulings applied (lead, 2026-11-17):**
- `sessionOpen` does not exist on `createFakeBingo` yet — this section predates Task 7. Add `sessionOpen?: boolean` (default `true`); when false every callback answers `409 { error: { code: 'SESSION_CLOSED' } }` after signature validation, mirroring bingo's closed-session refusal.
- Proof codes follow the spec (§5): unknown → `404 ROUND_NOT_FOUND`; `BETTING`/`FLYING` → `409 ROUND_NOT_FINISHED`; `ABANDONED` → `409 ROUND_ABANDONED`; only `CRASHED` returns proof data.
- Handshake classifies a `WalletError` by more than its status: a 4xx from `wallet.balance` is terminal (`SessionEndedError` → 410); every other `WalletError` — including a 2xx-status parse or signature failure (`WALLET_RESPONSE_INVALID`, `BALANCE_SIGNATURE_INVALID`) — maps to `502 WALLET_UNAVAILABLE`. A currency mismatch in the signed reply throws `WalletError(502, 'CURRENCY_MISMATCH')` so it lands on that same 502 path instead of a bare 500.
- `server.ts` and `tests/health.test.ts` must pass the new `AppDeps` to compile: `server.ts` builds the Postgres store and `HttpWalletClient` (Task 15 replaces that boot with recovery/engine/outbox); the health test uses a memory store.
- Rejected input answers a JSON envelope: unparseable body → `400 INVALID_JSON`, Zod failure → `400 VALIDATION_ERROR`, anything else → `500 INTERNAL_ERROR`.

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
  const obj = await ok.json();
  assert.equal(obj.data.serverSeed, 's');
  assert.equal(obj.data.crashPoint, 2.5);
  server.close(); await fake.close();
});

test('closing a session is idempotent and flips the stored status', async () => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB' });
  const { server, base, store } = await boot(fake);
  await fetch(`${base}/api/sessions/handshake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: fake.token }),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${base}/api/sessions/close`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: fake.token }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { closed: true } });
  }
  assert.equal(store.dump().sessions[0]!.status, 'CLOSED');
  server.close(); await fake.close();
});

test('proof answers 404 for an unknown round and 409 for an abandoned one', async () => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB' });
  const { server, base, store } = await boot(fake);
  const missing = await fetch(`${base}/api/rounds/999999/proof`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'ROUND_NOT_FOUND');
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: new Date() });
  await store.finishRound(round.id, { status: 'ABANDONED', at: new Date() });
  const abandoned = await fetch(`${base}/api/rounds/${round.id}/proof`);
  assert.equal(abandoned.status, 409);
  assert.equal((await abandoned.json()).error.code, 'ROUND_ABANDONED');
  server.close(); await fake.close();
});

test('a 5xx wallet answers 502 instead of declaring the session dead', async () => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB' });
  const { server, base } = await boot(fake);
  fake.respondNextWith('{"error":{"code":"INTERNAL_ERROR","message":"boom"}}', { status: 500 });
  const response = await fetch(`${base}/api/sessions/handshake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: fake.token }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'WALLET_UNAVAILABLE');
  server.close(); await fake.close();
});

test('a malformed handshake body answers 400 rather than 500', async () => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 0n, currency: 'ETB' });
  const { server, base } = await boot(fake);
  const response = await fetch(`${base}/api/sessions/handshake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'not-a-uuid' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
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
    // A signed reply in another currency means the operator contract is broken,
    // not that the session ended: surface it on the wallet-unavailable path.
    throw new WalletError(502, 'CURRENCY_MISMATCH', `Bingo settles ${reply.currency}, expected ${input.config.operator.currency}`);
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

Handshake route: validate `{token}` is a UUID (`z.string().uuid()`), call `handshake`, respond `{data:{sessionId: session.token, gameId: 'crash', currency, balance: displayBalance.toString(), limits:{minStake, maxStake, maxWin}, expiresAt: new Date(Date.now()+2*3600_000).toISOString()}}` — `sessionId` is bingo's session token, the key of the provider's own row and of the socket auth in Task 14. Map `SessionEndedError` → 410 `{error:{code:'SESSION_CLOSED'}}`; map every other `WalletError` → 502 `{error:{code:'WALLET_UNAVAILABLE'}}` (null-status transport/timeout, 5xx, and 2xx-status parse or signature failures alike — a parse failure is not a dead session).

Close route: validate `{token}` as a UUID, call `store.closeSession(token)` (no error when the token is unknown — closing twice is a no-op), respond `{data:{closed:true}}`.

Proof route: `:id` must be a safe positive integer (otherwise 404); 404 `ROUND_NOT_FOUND` for unknown rounds; 409 `ROUND_NOT_FINISHED` while `BETTING`/`FLYING`; 409 `ROUND_ABANDONED` for `ABANDONED`; otherwise `{data:{roundId, serverSeed, serverSeedHash, clientSeedComposite, crashPoint, startedAt, flewAt, crashedAt}}` (let express serialise the Dates).

Error handling: after `express.json({ limit: '32kb' })`, a final error middleware maps `entity.parse.failed` → 400 `{error:{code:'INVALID_JSON'}}`, `ZodError` → 400 `{error:{code:'VALIDATION_ERROR'}}`, anything else → 500 `{error:{code:'INTERNAL_ERROR'}}`.

- [ ] **Step 5: Run tests**

Run: `npm run games:test && npm run games:typecheck`
Expected: the 7 HTTP tests pass alongside the existing suites; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/games-provider/src/server/handshake.ts apps/games-provider/src/server/http.ts apps/games-provider/src/test/fakeBingo.ts apps/games-provider/tests/http.test.ts apps/games-provider/tests/health.test.ts apps/games-provider/server.ts
git commit -m "feat(games-provider): add session handshake and round proof endpoints"
```

---

### Task 14: WebSocket gateway

**Files:**
- Create: `apps/games-provider/src/server/socket.ts`
- Create: `apps/games-provider/src/test/server.ts` (shared http+socket+engine test harness)
- Test: `apps/games-provider/tests/socket.test.ts`
- Production wiring is Task 15's job; this task ships the module and the harness.

**Interfaces:**
- Produces: `attachSocket({ server, store, engine })` → `{ broadcast(event: RoundEngineEvent): void; close(): Promise<void> }`, upgrading on path `/ws`. Inbound frames `auth` (`{token}`), `bet:place` (`{panel, stake, autoCashout?}`), `bet:cancel` (`{panel}`), `bet:cashout` (`{panel}`). Outbound frames `snapshot`, `round:betting`, `round:tick`, `round:crashed`, `bet:update`, `balance:update`, `session:ended`, `error`.
- Produces: `startTestServer({ config, store, wallet })` → `{ url, wsUrl, engine, close }` (ephemeral port, `/ws` path, engine NOT started — tests drive `engine.tickOnce`).

**Rulings applied (lead, 2026-11-17):**
- The engine emits a fourth event, `round:flying`, that the design's V1 outbound list does not include. Broadcast it as `round:tick` with `{roundId, multiplier: 1, elapsedMs: 0}` — ticks only exist while flying, so elapsed 0 is the takeoff signal and the client needs no extra event.
- `bet:update` and `balance:update` concern one player: send them only to sockets authed as that session token. Engine events go to every authed socket.
- `attachSocket` takes no `wallet`/`config`: the socket never calls the wallet directly and does no origin policy of its own; the engine already owns bet handling. The plan's earlier `{ server, store, engine, wallet, config }` shape would leave two unused parameters.
- Frames are answered with `{type:'error', code, message}` where `code` is `NOT_AUTHED` (any frame before auth), `BAD_FRAME` (unparseable JSON, unknown type, `panel` not 0|1, `stake` not a positive decimal string, non-numeric/`<1` `autoCashout`), `WalletError.code` for wallet failures, `BET_REJECTED` for the engine's business errors ("Betting is closed", "Stake outside limits", "No active bet for this round", "no round is open"). A bad frame never closes the socket; the client keeps its auth.
- Each action re-reads the session from the store; a missing or CLOSED row sends `{type:'session:ended'}` and closes the socket. Auth itself needs an OPEN row. (`handshake` reopening a closed row is Task 13's contract; the socket is not a session oracle.)
- `EngineLimits.maxBetsPerRound` has no config value yet (Task 15 adds it); the harness uses 4.
- Money on outbound frames is a decimal string (`stake`, `payout`, `balance`); `bet:update` re-reads the row after the action so it reports committed state.

- [ ] **Step 1: Write the failing tests**

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
import { BETTING_WINDOW_MS } from '../src/server/roundEngine';

interface Frame { type: string; [key: string]: unknown }

function collector(ws: WebSocket) {
  const queue: Frame[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame;
    const index = waiters.findIndex((waiter) => waiter.match(frame));
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame);
    else queue.push(frame);
  });
  return {
    send: (frame: Frame) => ws.send(JSON.stringify(frame)),
    next(match: (frame: Frame) => boolean, timeoutMs = 2000): Promise<Frame> {
      const index = queue.findIndex(match);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs);
        waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
      });
    },
  };
}

async function setup() {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 10_000n, currency: 'ETB' });
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CALLBACK_URL: `${fake.url}/api/games/callback/stratos`,
    OPERATOR_HMAC_SECRET: 'test-hmac-secret-value',
  });
  const store = createMemoryStore();
  const wallet = new HttpWalletClient({ callbackUrl: config.operator.callbackUrl, hmacSecret: config.operator.hmacSecret });
  await handshake({ token: fake.token, config, store, wallet });
  const server = await startTestServer({ config, store, wallet });
  return { fake, store, ...server };
}

async function connect(url: string) {
  const ws = new WebSocket(url);
  const frames = collector(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, frames };
}

test('a client must auth before betting, and the snapshot hides the round outcome', async (t) => {
  const env = await setup();
  t.after(async () => { await env.close(); await env.fake.close(); });
  const { frames } = await connect(env.wsUrl);

  frames.send({ type: 'bet:place', panel: 0, stake: '1000' });
  const denied = await frames.next((frame) => frame.type === 'error');
  assert.equal(denied.code, 'NOT_AUTHED');

  frames.send({ type: 'auth', token: env.fake.token });
  const snapshot = await frames.next((frame) => frame.type === 'snapshot');
  assert.equal(snapshot.crashPoint, null);
  assert.equal(snapshot.serverSeed, null);
  assert.equal(snapshot.phase, 'BETTING');
});

test('placing, cancelling and cashing out confirm the bet and the balance', async (t) => {
  const env = await setup();
  t.after(async () => { await env.close(); await env.fake.close(); });
  const { frames } = await connect(env.wsUrl);
  frames.send({ type: 'auth', token: env.fake.token });
  await frames.next((frame) => frame.type === 'snapshot');

  await env.engine.tickOnce(0);
  const betting = await frames.next((frame) => frame.type === 'round:betting');
  assert.equal(typeof betting.roundId, 'number');

  frames.send({ type: 'bet:place', panel: 0, stake: '1000' });
  const placed = await frames.next((frame) => frame.type === 'bet:update' && frame.panel === 0);
  assert.equal(placed.status, 'ACTIVE');
  assert.equal(placed.stake, '1000');
  const balance = await frames.next((frame) => frame.type === 'balance:update');
  assert.equal(balance.balance, '9000');

  frames.send({ type: 'bet:place', panel: 1, stake: '500' });
  await frames.next((frame) => frame.type === 'bet:update' && frame.panel === 1 && frame.status === 'ACTIVE');
  frames.send({ type: 'bet:cancel', panel: 1 });
  const cancelled = await frames.next((frame) => frame.type === 'bet:update' && frame.panel === 1);
  assert.equal(cancelled.status, 'CANCELLED');

  await env.engine.tickOnce(BETTING_WINDOW_MS);
  const takeoff = await frames.next((frame) => frame.type === 'round:tick');
  assert.equal(takeoff.multiplier, 1);
  assert.equal(takeoff.elapsedMs, 0);

  frames.send({ type: 'bet:cashout', panel: 0 });
  const cashed = await frames.next((frame) => frame.type === 'bet:update' && frame.panel === 0);
  assert.equal(cashed.status, 'CASHED');
  assert.equal(cashed.payout, '1000');
});

test('authing a closed or unknown session ends the socket', async (t) => {
  const env = await setup();
  t.after(async () => { await env.close(); await env.fake.close(); });

  const unknown = await connect(env.wsUrl);
  unknown.frames.send({ type: 'auth', token: '11111111-1111-4111-8111-111111111111' });
  await unknown.frames.next((frame) => frame.type === 'session:ended');
  await new Promise<void>((resolve) => unknown.ws.once('close', () => resolve()));

  await env.store.closeSession(env.fake.token);
  const closed = await connect(env.wsUrl);
  closed.frames.send({ type: 'auth', token: env.fake.token });
  await closed.frames.next((frame) => frame.type === 'session:ended');
});

test('a bad frame is answered with BAD_FRAME and the socket keeps its auth', async (t) => {
  const env = await setup();
  t.after(async () => { await env.close(); await env.fake.close(); });
  const { frames } = await connect(env.wsUrl);
  frames.send({ type: 'auth', token: env.fake.token });
  await frames.next((frame) => frame.type === 'snapshot');

  frames.send({ type: 'bet:place', panel: 7, stake: '1000' });
  const bad = await frames.next((frame) => frame.type === 'error');
  assert.equal(bad.code, 'BAD_FRAME');

  // "0" and "000" are decimal strings but not positive stakes.
  frames.send({ type: 'bet:place', panel: 0, stake: '0' });
  const zero = await frames.next((frame) => frame.type === 'error');
  assert.equal(zero.code, 'BAD_FRAME');

  // Still authed: the next valid frame reaches the engine (no round is open yet).
  frames.send({ type: 'bet:place', panel: 0, stake: '1000' });
  const rejected = await frames.next((frame) => frame.type === 'error');
  assert.equal(rejected.code, 'BET_REJECTED');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run games:test`
Expected: FAIL (no socket module, no harness).

- [ ] **Step 3: Implement `socket.ts` and `src/test/server.ts`**

The listing below is the intended shape; type it as written and fix any type friction rather than redesigning it. A frame with no `type` before auth is `NOT_AUTHED`; after auth it is `BAD_FRAME`.

```ts
// apps/games-provider/src/server/socket.ts
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { SessionRecord } from '../domain/types';
import type { RoundEngine, RoundEngineEvent } from './roundEngine';
import type { Store } from './store';
import { WalletError } from './wallet';

const HEARTBEAT_MS = 30_000;
const PANELS = [0, 1] as const;
type Panel = (typeof PANELS)[number];
type EngineView = Pick<RoundEngine, 'snapshot' | 'placeBet' | 'cancelBet' | 'cashout'>;

export interface SocketHandle {
  broadcast(event: RoundEngineEvent): void;
  close(): Promise<void>;
}

interface ClientState { sessionToken: string | null; alive: boolean; tail: Promise<void> }

export function attachSocket(input: { server: Server; store: Store; engine: EngineView }): SocketHandle {
  const { store, engine } = input;
  // maxPayload keeps a hostile client from buffering 100 MiB before JSON.parse.
  const wss = new WebSocketServer({ server: input.server, path: '/ws', maxPayload: 64 * 1024 });
  const clients = new Map<WebSocket, ClientState>();

  const send = (ws: WebSocket, frame: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const sendToSession = (sessionToken: string, frame: Record<string, unknown>) => {
    for (const [ws, state] of clients) if (state.sessionToken === sessionToken) send(ws, frame);
  };

  wss.on('connection', (ws) => {
    const state: ClientState = { sessionToken: null, alive: true, tail: Promise.resolve() };
    clients.set(ws, state);
    ws.on('pong', () => { state.alive = true; });
    // `ws` emits 'error' for protocol violations (e.g. an unmasked frame); an
    // EventEmitter 'error' with no listener is an uncaughtException that would
    // take down the whole provider. Never leave it unhandled.
    ws.on('error', (error) => {
      console.error('socket client failed', error);
      clients.delete(ws);
    });
    ws.on('close', () => clients.delete(ws));
    // A socket's frames run strictly in order: a cancel must never overtake the
    // place it cancels while both sit on store/wallet awaits.
    ws.on('message', (raw) => {
      state.tail = state.tail
        .then(() => handleFrame(ws, raw.toString()))
        .catch((error: unknown) => {
          console.error('socket frame failed', error);
          send(ws, { type: 'error', code: 'INTERNAL_ERROR', message: 'Frame handling failed' });
        });
    });
  });

  async function handleFrame(ws: WebSocket, raw: string): Promise<void> {
    const state = clients.get(ws);
    if (!state) return;
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      frame = parsed as Record<string, unknown>;
    } catch {
      send(ws, { type: 'error', code: 'BAD_FRAME', message: 'Frame is not a JSON object' });
      return;
    }
    const type = frame.type;
    if (typeof type !== 'string') {
      send(ws, { type: 'error', code: state.sessionToken ? 'BAD_FRAME' : 'NOT_AUTHED', message: 'Frame has no type' });
      return;
    }
    if (type !== 'auth' && state.sessionToken === null) {
      send(ws, { type: 'error', code: 'NOT_AUTHED', message: 'Authenticate first' });
      return;
    }

    if (type === 'auth') {
      const token = frame.token;
      if (typeof token !== 'string' || token.length === 0) {
        send(ws, { type: 'error', code: 'BAD_FRAME', message: 'auth requires a token' });
        return;
      }
      const session = await store.getSession(token);
      if (session === null || session.status !== 'OPEN') {
        send(ws, { type: 'session:ended', reason: session === null ? 'UNKNOWN' : 'CLOSED' });
        ws.close(4001, 'session ended');
        return;
      }
      state.sessionToken = session.token;
      send(ws, { type: 'snapshot', ...engine.snapshot(), balance: session.displayBalance.toString() });
      return;
    }

    const token = state.sessionToken;
    if (token === null) return;
    const session = await store.getSession(token);
    if (session === null || session.status !== 'OPEN') {
      send(ws, { type: 'session:ended', reason: session === null ? 'UNKNOWN' : 'CLOSED' });
      ws.close(4001, 'session ended');
      return;
    }

    if (type === 'bet:place') {
      const panel = frame.panel;
      const stake = frame.stake;
      const autoCashout = frame.autoCashout ?? null;
      if (!PANELS.includes(panel as Panel) || typeof stake !== 'string' || !/^[1-9]\d*$/.test(stake)
        || (autoCashout !== null && (typeof autoCashout !== 'number' || !Number.isFinite(autoCashout) || autoCashout < 1))) {
        send(ws, { type: 'error', code: 'BAD_FRAME', message: 'bet:place requires panel 0|1, a decimal stake and an optional autoCashout >= 1' });
        return;
      }
      await act(ws, token, panel as Panel, () =>
        engine.placeBet({ session, panel: panel as Panel, stake: BigInt(stake), autoCashout }),
      );
      return;
    }
    if (type === 'bet:cancel' || type === 'bet:cashout') {
      const panel = frame.panel;
      if (!PANELS.includes(panel as Panel)) {
        send(ws, { type: 'error', code: 'BAD_FRAME', message: `${type} requires panel 0|1` });
        return;
      }
      await act(ws, token, panel as Panel, () =>
        type === 'bet:cancel'
          ? engine.cancelBet({ session, panel: panel as Panel })
          : engine.cashout({ session, panel: panel as Panel }),
      );
      return;
    }
    send(ws, { type: 'error', code: 'BAD_FRAME', message: `Unknown frame type ${type}` });
  }

  async function act(ws: WebSocket, token: string, panel: Panel, action: () => Promise<unknown>): Promise<void> {
    const roundId = engine.snapshot().roundId;
    try {
      await action();
    } catch (error) {
      if (error instanceof WalletError) {
        send(ws, { type: 'error', code: error.code, message: error.message });
      } else {
        send(ws, { type: 'error', code: 'BET_REJECTED', message: error instanceof Error ? error.message : 'Bet rejected' });
      }
      return;
    }
    if (roundId !== null) {
      const bet = await store.getBet(roundId, token, panel);
      if (bet !== null) {
        sendToSession(token, {
          type: 'bet:update', roundId: bet.roundId, panel: bet.panel, status: bet.status,
          stake: bet.stake.toString(), autoCashout: bet.autoCashout,
          cashoutMultiplier: bet.cashoutMultiplier, payout: bet.payout === null ? null : bet.payout.toString(),
        });
      }
    }
    const fresh = await store.getSession(token);
    if (fresh !== null) sendToSession(token, { type: 'balance:update', balance: fresh.displayBalance.toString() });
  }

  const heartbeat = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) { ws.terminate(); clients.delete(ws); continue; }
      state.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    broadcast(event) {
      const frame = event.type === 'round:flying'
        ? { type: 'round:tick', roundId: event.payload.roundId, multiplier: event.payload.multiplier, elapsedMs: event.payload.elapsedMs }
        : { type: event.type, ...event.payload };
      for (const [ws, state] of clients) if (state.sessionToken !== null) send(ws, frame);
    },
    async close() {
      clearInterval(heartbeat);
      for (const ws of clients.keys()) ws.terminate();
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
```

Note for the implementer: the session-check block above contains an intentional placeholder comment — write the single correct condition (`session === null || session.status !== 'OPEN'`), not the garbled line.

`src/test/server.ts`:

```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../config';
import { createApp } from '../server/http';
import { BetManager } from '../server/betManager';
import { RoundEngine, type EngineLimits } from '../server/roundEngine';
import { attachSocket, type SocketHandle } from '../server/socket';
import type { Store } from '../server/store';
import type { WalletClient } from '../server/wallet';

export interface TestServer { url: string; wsUrl: string; engine: RoundEngine; close(): Promise<void> }

export async function startTestServer(input: { config: AppConfig; store: Store; wallet: WalletClient }): Promise<TestServer> {
  const limits: EngineLimits = { ...input.config.limits, maxBetsPerRound: 4 };
  const betManager = new BetManager({ store: input.store, wallet: input.wallet, limits });
  let socket: SocketHandle | null = null;
  const engine = new RoundEngine({
    store: input.store, wallet: input.wallet, limits,
    operatorCode: input.config.operator.code,
    randomSeed: () => 'test-server-seed',
    clientSeeds: () => ['alpha', 'beta', 'gamma'],
    onEvent: (event) => socket?.broadcast(event),
    betManager,
  });
  const server = createServer(createApp(input));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  socket = attachSocket({ server, store: input.store, engine });
  const attached = socket;
  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    engine,
    async close() {
      await attached.close();
      engine.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

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
- Modify: `apps/games-provider/src/config.ts` (limits + client seeds + operator name)
- Modify: `apps/games-provider/src/server/store.ts`, `src/test/memoryStore.ts`, `src/db/storePostgres.ts` (`countOutboxByStatus`)
- Modify: `apps/games-provider/src/server/outbox.ts` (log a drain that leaves DEAD/CAP_REJECTED rows)
- Modify: `apps/games-provider/tests/config.test.ts`, `apps/games-provider/tests/memoryStore.test.ts`
- Create: `Dockerfile.games`, `Procfile.games`, `apps/games-provider/.env.example`, `apps/games-provider/README.md`, `apps/games-provider/scripts/smoke.ts`
- Modify: `docs/DEPLOY.md` (new section)
- Modify: root `package.json` (`games:smoke`)

**Interfaces:**
- Consumes: `createDb` → `{db, pool, migrate(), close()}`; `createPostgresStore(db)`; `OutboxWorker({store, wallet})` with `drainOnce(now)`, `start(ms)`, `stop()`; `runRecovery({store, wallet, now?})` → `{abandonedRoundIds, refundedBets, lostBets, resolvedIndeterminate, repairedSettlements}`; `BetManager({store, wallet, limits, now?, newId?})`; `RoundEngine({store, wallet, limits, operatorCode, randomSeed, clientSeeds, onEvent, betManager})`; `createApp({config, store, wallet})`; `attachSocket({server, store, engine})` → `{broadcast(event), close()}`.
- Produces: production boot order `migrate → seed operator → drain → runRecovery → drain → listen → outbox.start → engine.start`; graceful `SIGTERM`; config gains `limits.maxBetsPerRound`, `clientSeeds`, `operator.name`.

**Rulings applied (lead, 2026-11-17):**
- The plan's old listing predated Tasks 10–14: `attachSocket` takes `{server, store, engine}` (no wallet/config) and returns `broadcast`; the engine's `onEvent` must call it, so the socket handle is assigned after construction exactly like `src/test/server.ts`.
- Design §5.3 boot order governs: attempt pending wins once, then recover, then attempt the recovery rollbacks, then start the loop. Wins still `PENDING` retry in the background and do not block the first round.
- Config grows `GAME_MAX_BETS_PER_ROUND` (default 200), `CLIENT_SEEDS` (exactly 3 comma-separated, defaulting to the prototype's `stratos_slot_1_00000001,stratos_slot_2_00000002,stratos_slot_3_00000003`) and `OPERATOR_NAME` (default `Bingo 251`). `EngineLimits.maxBetsPerRound` has no config value before this task.
- `npm run games:build` is RED at Task 15's start: `index.html` references `/src/main.tsx`, which does not exist until Task 16 copies the client. Do not add a placeholder client; verify typecheck + tests here and carry the client build to Task 16/17.
- `vite` is a devDependency, so the image must build before `npm prune --omit=dev`; `tsx` is a runtime dependency and survives the prune.
- Single provider instance: no outbox lease, no multi-replica story; scaling above `web=1` stays unsupported.

- [ ] **Step 1: Add the config values and the outbox status count**

`src/config.ts` — add to `EnvSchema`:

```ts
GAME_MAX_BETS_PER_ROUND: z.coerce.number().int().positive().default(200),
CLIENT_SEEDS: z.string().default(
  'stratos_slot_1_00000001,stratos_slot_2_00000002,stratos_slot_3_00000003',
),
OPERATOR_NAME: z.string().min(1).default('Bingo 251'),
```

and in the returned object: `operator.name: parsed.OPERATOR_NAME`, `limits.maxBetsPerRound: parsed.GAME_MAX_BETS_PER_ROUND`, and

```ts
const clientSeeds = parsed.CLIENT_SEEDS.split(',').map((seed) => seed.trim()).filter(Boolean);
if (clientSeeds.length !== 3) throw new Error('CLIENT_SEEDS must list exactly 3 comma-separated seeds');
// returned as `clientSeeds`
```

`tests/config.test.ts` — extend the existing tests:

```ts
test('limits and client seeds have production defaults and are overridable', () => {
  const defaults = loadConfig(baseEnv);
  assert.equal(defaults.limits.maxBetsPerRound, 200);
  assert.deepEqual(defaults.clientSeeds, [
    'stratos_slot_1_00000001', 'stratos_slot_2_00000002', 'stratos_slot_3_00000003',
  ]);
  assert.equal(defaults.operator.name, 'Bingo 251');

  const custom = loadConfig({
    ...baseEnv,
    GAME_MAX_BETS_PER_ROUND: '350',
    CLIENT_SEEDS: 'a,b,c',
    OPERATOR_NAME: 'Acme Casino',
  });
  assert.equal(custom.limits.maxBetsPerRound, 350);
  assert.deepEqual(custom.clientSeeds, ['a', 'b', 'c']);
  assert.equal(custom.operator.name, 'Acme Casino');
});

test('CLIENT_SEEDS must contain exactly three seeds', () => {
  assert.throws(() => loadConfig({ ...baseEnv, CLIENT_SEEDS: 'a,b' }), /exactly 3/);
});
```

`src/server/store.ts` — add to the interface (next to `pendingOutboxCount`):

```ts
countOutboxByStatus(status: OutboxStatus): Promise<number>;
```

Implement in both stores. Memory store:

```ts
async countOutboxByStatus(status) {
  return [...outbox.values()].filter((row) => row.status === status).length;
},
```

Postgres store (`import { and, asc, count, eq, lte }` already exists — reuse `count`/`eq`):

```ts
async countOutboxByStatus(status) {
  const rows = await db
    .select({ total: count() })
    .from(walletOutbox)
    .where(eq(walletOutbox.status, status));
  return rows[0]?.total ?? 0;
},
```

`tests/memoryStore.test.ts` — one assertion in an existing outbox test (or a new small test): after enqueue, `countOutboxByStatus('PENDING') === 1`, `countOutboxByStatus('DEAD') === 0`; after `markOutbox(id, 'DEAD', 'X')`, `'DEAD' === 1` and `'PENDING' === 0`.

- [ ] **Step 2: Surface dead and capped rows from the worker**

`src/server/outbox.ts` — in `tick()`, keep the summary and log a terminal outcome:

```ts
const summary = await this.drainOnce(new Date());
if (summary.dead > 0 || summary.capped > 0) {
  // DEAD/CAP_REJECTED rows are the audit trail for a payout that will never
  // land; an operator has to see it, and a background tick is the only place
  // a runtime failure surfaces.
  console.error('outbox: wallet rows need operator attention', summary);
}
```

- [ ] **Step 3: Write the boot entry**

```ts
// apps/games-provider/server.ts
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { loadConfig } from './src/config';
import { createDb } from './src/db/index';
import { createPostgresStore } from './src/db/storePostgres';
import { BetManager } from './src/server/betManager';
import { createApp } from './src/server/http';
import { OutboxWorker } from './src/server/outbox';
import { runRecovery } from './src/server/recovery';
import { RoundEngine } from './src/server/roundEngine';
import { attachSocket, type SocketHandle } from './src/server/socket';
import { HttpWalletClient } from './src/server/wallet';

const config = loadConfig();
const database = createDb(config.databaseUrl);
await database.migrate();
const store = createPostgresStore(database.db);
await store.upsertOperator({
  code: config.operator.code,
  name: config.operator.name,
  callbackUrl: config.operator.callbackUrl,
  hmacSecret: config.operator.hmacSecret,
  currency: config.operator.currency,
  enabled: true,
});

const wallet = new HttpWalletClient({
  callbackUrl: config.operator.callbackUrl,
  hmacSecret: config.operator.hmacSecret,
});
const outbox = new OutboxWorker({ store, wallet });

// Design §5.3: attempt every pending win once before deciding anything else.
console.log('games-provider: boot drain', await outbox.drainOnce(new Date()));
console.log('games-provider: boot recovery', await runRecovery({ store, wallet }));
// §5.3.4: every recovery rollback is enqueued now; attempt them before the loop.
console.log('games-provider: recovery drain', await outbox.drainOnce(new Date()));
outbox.start(1000);

const stranded = {
  dead: await store.countOutboxByStatus('DEAD'),
  capped: await store.countOutboxByStatus('CAP_REJECTED'),
};
if (stranded.dead + stranded.capped > 0) {
  console.error('games-provider: wallet rows need operator attention', stranded);
}

let socket: SocketHandle | undefined;
const betManager = new BetManager({
  store,
  wallet,
  limits: config.limits,
  newId: () => randomUUID(),
});
const engine = new RoundEngine({
  store,
  wallet,
  limits: config.limits,
  betManager,
  operatorCode: config.operator.code,
  randomSeed: () => randomUUID(),
  clientSeeds: () => config.clientSeeds,
  onEvent: (event) => socket?.broadcast(event),
});
const server = createServer(createApp({ config, store, wallet }));
socket = attachSocket({ server, store, engine });

await new Promise<void>((resolve) => server.listen(config.port, resolve));
console.log(`games-provider: listening on ${config.port}`);
await engine.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`games-provider: ${signal}, shutting down`);
  engine.stop(); // no new rounds, no new ticks
  outbox.stop();
  await socket?.close(); // terminates live clients so server.close can finish
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

- [ ] **Step 4: Write deployment files**

`Procfile.games`:

```
web: node --import tsx apps/games-provider/server.ts
```

`Dockerfile.games` mirrors `Dockerfile.api`:

```dockerfile
# syntax=docker/dockerfile:1
# Crash game provider image for Dokku (apps/games-provider). Context is the repo root.
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/games-provider/package.json apps/games-provider/package.json
RUN npm ci

COPY apps/games-provider apps/games-provider
# vite/react are devDependencies, so the client must be built before the prune.
RUN npm run build -w @bingo/games-provider \
  && npm prune --omit=dev \
  && npx tsx --version

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# dist/client is served by /play from this directory.
COPY --from=build /app/apps ./apps

EXPOSE 3001
CMD ["node", "--import", "tsx", "apps/games-provider/server.ts"]
```

`.env.example` (placeholders only, never real values):

```
PORT=3001
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME
OPERATOR_CODE=bingo251
OPERATOR_NAME=Bingo 251
OPERATOR_CALLBACK_URL=https://api.example.com/api/games/callback/stratos
OPERATOR_HMAC_SECRET=REPLACE_WITH_BINGO_PROVIDER_SECRET
OPERATOR_CURRENCY=ETB
ALLOWED_PARENT_ORIGINS=https://app.example.com
GAME_MIN_STAKE=100
GAME_MAX_STAKE=100000
GAME_MAX_WIN=3000000
GAME_MAX_BETS_PER_ROUND=200
CLIENT_SEEDS=stratos_slot_1_00000001,stratos_slot_2_00000002,stratos_slot_3_00000003
BOT_COUNT=0
```

`README.md` (short): what the app is (crash game provider for bingo251 and other operators), the boot order, run commands (`npm run games:dev`, `games:test`, `games:typecheck`, `games:build`, `games:smoke`), the env table matching `.env.example`, the endpoints (`POST /api/sessions/handshake`, `POST /api/sessions/close`, `GET /api/rounds/:id/proof`, `/ws`, `/play`), and the single-instance constraint.

- [ ] **Step 5: Document Dokku setup** in `docs/DEPLOY.md` (append as a new numbered section)

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

plus a `dokku config:set bingo-crash …` block with the `.env.example` keys (values typed by the operator, secret never committed), domain + letsencrypt, first boot expectations (migrations, operator upsert, recovery log lines), provider registration in the bingo admin (`stratos` / `crash`, `launchUrlTemplate=https://<crash-host>/play?token={token}&lang={lang}&currency={currency}`), the smoke command, and the `web=1` constraint.

- [ ] **Step 6: Write the smoke script**

`apps/games-provider/scripts/smoke.ts` — refuses to run unless `SMOKE_CONFIRM=yes` (it writes rows), applies migrations, upserts the operator, inserts a fake OPEN session, a `BETTING` round and an `ACTIVE` bet, then:

```ts
const first = await runRecovery({ store, wallet });
// assert: round is ABANDONED, bet is CANCELLED, a PENDING ROLLBACK row exists
const rollback = (await store.claimDueOutbox(new Date(), 50)).find((row) => row.txnId === bet.betTxnId);
if (rollback) await store.markOutbox(rollback.id, 'SENT', 'SMOKE_TEST'); // never call bingo for a fake session
const second = await runRecovery({ store, wallet });
// assert: second.abandonedRoundIds.length === 0 && second.refundedBets === 0 && second.repairedSettlements === 0
```

On any failed assertion print the failing check and `process.exit(1)`; on success print both summaries, the ids it wrote, and exit 0. Always `await database.close()`.

Register in root `package.json`:

```json
"games:smoke": "node --import tsx apps/games-provider/scripts/smoke.ts"
```

- [ ] **Step 7: Verify**

Run `npm run games:typecheck` → clean.
Run `npm run games:test` → all green (count grows by the new config/store tests).
Do NOT expect `npm run games:build` to pass: it fails on the missing `/src/main.tsx` until Task 16 ships the client (carried).

- [ ] **Step 8: Commit**

```bash
git add Dockerfile.games Procfile.games apps/games-provider package.json docs/DEPLOY.md \
  apps/games-provider/server.ts apps/games-provider/src/config.ts apps/games-provider/src/server/store.ts \
  apps/games-provider/src/test/memoryStore.ts apps/games-provider/src/db/storePostgres.ts \
  apps/games-provider/src/server/outbox.ts apps/games-provider/tests/config.test.ts \
  apps/games-provider/tests/memoryStore.test.ts apps/games-provider/.env.example \
  apps/games-provider/README.md apps/games-provider/scripts/smoke.ts
git commit -m "feat(games-provider): add boot sequence and Dokku deployment artifacts"
```

---

## Phase E — Client and acceptance

### Task 16: Build the game client, the bridge, and the settlement notifications

**Files:**
- Modify: `apps/games-provider/src/server/betManager.ts`, `apps/games-provider/src/server/outbox.ts`, `apps/games-provider/src/server/socket.ts`, `apps/games-provider/server.ts`, `apps/games-provider/src/test/server.ts`, `apps/games-provider/vite.config.ts`, `apps/games-provider/index.html`
- Test: `apps/games-provider/tests/betManager.test.ts`, `apps/games-provider/tests/outbox.test.ts`, `apps/games-provider/tests/socket.test.ts`
- Copy from `C:\Users\mekon\Documents\Projects\game-provider` (rewrite every import; no path into the prototype may remain):
  - `src/client/components/aviator/flightCanvasRenderer.ts` → `apps/games-provider/src/client/components/flightCanvasRenderer.ts` (change the `GamePhase` import to `../types`)
  - `src/client/components/aviator/FlightCanvas.tsx` → `apps/games-provider/src/client/components/FlightCanvas.tsx` (simplified per Step 5)
  - `src/client/utils/soundEngine.ts` → `apps/games-provider/src/client/sound.ts` (delete `playRainDrop`)
  - `src/index.css` → `apps/games-provider/src/index.css` (add the `--g-*` defaults from Step 5)
- Create: `apps/games-provider/src/main.tsx`, `apps/games-provider/src/client/{App.tsx,bridge.ts,i18n.ts,fair.ts,types.ts}`, `apps/games-provider/src/client/hooks/useCrashSocket.ts`, `apps/games-provider/src/client/components/{BetPanel.tsx,ProvablyFairModal.tsx}`
- Delete from the copy: free bets, chat, rain, bots, avatars, online count, auto-bet, operator/superadmin/portal views, Firebase, JWT, recharts.

**Interfaces:**
- Consumes: `POST /api/sessions/handshake` and `GET /api/rounds/:id/proof` (Task 13); inbound WS frames `auth {token}`, `bet:place {panel, stake, autoCashout?}`, `bet:cancel {panel}`, `bet:cashout {panel}`; outbound `snapshot`, `round:betting`, `round:flying`, `round:tick`, `round:crashed`, `bet:update`, `balance:update`, `session:ended`, `error` (Task 14); `bingo:theme` / `bingo:locale` / `bingo:haptic` / `bingo:exit` from `apps/web/src/app/games/play/[sessionId]/page.tsx`.
- Produces: `dist/client` served at `/play`; the settlement notification seam (`BetManager.onSettled`, `OutboxWorker.onDelivered`, `SocketHandle.notifyBet`/`notifyBalance`, snapshot `bets`); a green `npm run games:build` (Task 15 deliberately left it red until this task created `src/main.tsx`).

**Rulings applied:**
- Auto-cashout settlement must be pushed, not polled: `BetManager.onSettled` fires after the CASHED write and after every LOST sweep, `OutboxWorker.onDelivered` fires after a delivered movement mirrors the balance, and the socket exposes `notifyBet` / `notifyBalance`. This also closes the Task 14 parked finding "cancel reports un-refunded balance": the rollback delivery now pushes the real balance.
- A reconnect must show the player's own bets: the auth snapshot gains `bets: [BetFrame | null, BetFrame | null]`, read with `store.getBet` for the snapshot's round.
- `serverSeedHash` stays `null` in a live snapshot (the engine never leaks pre-crash seeds); the client shows the hash from `round:betting` / `round:flying` and re-populates it on the next round.
- Vite `base` must be `/play/`: assets are served by `app.use('/play', express.static(clientDir))`, so the default `/assets/...` URLs would 404.

**Step 1: Push settlement and balance changes from the server**

`betManager.ts` — add the callback to `BetManagerDeps` and fire it after both terminal writes:

```ts
export interface BetManagerDeps {
  store: Store;
  wallet: WalletClient;
  limits: EngineLimits;
  /** Timestamp source for persisted rows. Defaults to the real clock. */
  now?: () => Date;
  /** Transaction id source. Defaults to `randomUUID`. */
  newId?: () => string;
  /** Called after a bet is persisted as CASHED or LOST, so the gateway can push it. */
  onSettled?: (bet: BetRecord) => void;
}
```

Constructor: `this.onSettled = deps.onSettled ?? null;` with `private readonly onSettled: ((bet: BetRecord) => void) | null;`.

In `settleWin`, inside the lock after `enqueueOutbox`:

```ts
      const settledAt = this.now();
      await this.store.updateBet(current.id, {
        status: 'CASHED',
        cashoutMultiplier: multiplier,
        payout,
        winTxnId,
        settledAt,
      });
      await this.store.enqueueOutbox({
        operatorCode: session.operatorCode,
        type: 'WIN',
        txnId: winTxnId,
        sessionToken: session.token,
        amount: payout,
      });
      this.onSettled?.({ ...current, status: 'CASHED', cashoutMultiplier: multiplier, payout, winTxnId, settledAt });
```

In `settleRound`, after the LOST write:

```ts
      await this.store.updateBet(bet.id, { status: 'LOST', settledAt });
      this.onSettled?.({ ...bet, status: 'LOST', settledAt });
```

`outbox.ts` — add the callback and fire it where the balance mirror is written:

```ts
export interface OutboxWorkerDeps {
  store: Store;
  wallet: WalletClient;
  /** Called after a delivered movement moved the local balance mirror. */
  onDelivered?: (input: { sessionToken: string; balance: bigint }) => void;
}
```

```ts
  private readonly onDelivered: ((input: { sessionToken: string; balance: bigint }) => void) | null;
```

Constructor: `this.onDelivered = deps.onDelivered ?? null;`. In `deliver`:

```ts
    if (reply.balance !== null) {
      await this.store.setSessionBalance(row.sessionToken, reply.balance);
      this.onDelivered?.({ sessionToken: row.sessionToken, balance: reply.balance });
    }
    await this.store.markOutbox(row.id, 'SENT');
    summary.sent += 1;
```

`socket.ts` — import `type { BetRecord }`, extend the handle, and share one payload builder:

```ts
export interface SocketHandle {
  broadcast(event: RoundEngineEvent): void;
  notifyBet(bet: BetRecord): void;
  notifyBalance(sessionToken: string, balance: bigint): void;
  close(): Promise<void>;
}

const betPayload = (bet: BetRecord) => ({
  roundId: bet.roundId,
  panel: bet.panel,
  status: bet.status,
  stake: bet.stake.toString(),
  autoCashout: bet.autoCashout,
  cashoutMultiplier: bet.cashoutMultiplier,
  payout: bet.payout === null ? null : bet.payout.toString(),
});
```

Use `sendToSession(token, { type: 'bet:update', ...betPayload(bet) })` in `act()` (replacing the inline object), and send the snapshot with the session's own bets in the auth branch:

```ts
      state.sessionToken = session.token;
      const snapshot = engine.snapshot();
      const ownBets = snapshot.roundId === null
        ? [null, null]
        : await Promise.all(PANELS.map((panel) => store.getBet(snapshot.roundId as number, session.token, panel)));
      send(ws, {
        type: 'snapshot',
        ...snapshot,
        balance: session.displayBalance.toString(),
        bets: ownBets.map((bet) => (bet === null ? null : betPayload(bet))),
      });
      return;
```

Add to the returned handle:

```ts
    notifyBet(bet) {
      sendToSession(bet.sessionToken, { type: 'bet:update', ...betPayload(bet) });
    },
    notifyBalance(sessionToken, balance) {
      sendToSession(sessionToken, { type: 'balance:update', balance: balance.toString() });
    },
```

`server.ts` — move `let socket: SocketHandle | undefined;` above the outbox construction, then wire:

```ts
const outbox = new OutboxWorker({
  store,
  wallet,
  onDelivered: ({ sessionToken, balance }) => socket?.notifyBalance(sessionToken, balance),
});
```

```ts
const betManager = new BetManager({
  store,
  wallet,
  limits: config.limits,
  newId: () => randomUUID(),
  onSettled: (bet) => socket?.notifyBet(bet),
});
```

`src/test/server.ts` — extend `TestServer` with `store: Store` and `socket: SocketHandle`, wire `onSettled: (bet) => socket?.notifyBet(bet)` into `BetManager`, and return `store` plus the `attached` handle (the engine's `onEvent` already broadcasts through the same handle).

**Step 2: Test the seam**

- `betManager.test.ts`: one test drives `processAutoCashouts` (round `crashPoint: 2`, multiplier `1.5`, bet `autoCashout: 1.2`) and asserts `onSettled` was called once with `status: 'CASHED'`, the target multiplier, and the same `payout` persisted on the bet; another calls `settleRound` with two ACTIVE bets and asserts two `LOST` notifications.
- `outbox.test.ts`: deliver one WIN whose reply carries `balance`, and assert `onDelivered` received `{ sessionToken, balance }` and the store session balance moved.
- `socket.test.ts`: connect two clients with different session tokens; call `server.socket.notifyBet(betForSessionA)` and `server.socket.notifyBalance(tokenB, 123n)`; assert A receives only `bet:update` and B only `balance:update`. Add a reconnect test: place a bet, open a second socket for the same session, and assert its `snapshot.bets` contains the ACTIVE bet for its panel.

**Step 3: Client frame types — `src/client/types.ts`**

```ts
export type GamePhase = 'BETTING' | 'FLYING' | 'CRASHED';
export type Lang = 'en' | 'am';

export type BetStatus =
  | 'PLACING' | 'ACTIVE' | 'CASHED' | 'LOST' | 'CANCELLED' | 'REJECTED' | 'UNRESOLVED';

export interface BetFrame {
  roundId: number;
  panel: 0 | 1;
  status: BetStatus;
  stake: string;
  autoCashout: number | null;
  cashoutMultiplier: number | null;
  payout: string | null;
}

export interface RoundHistoryItem { roundId: number; crashPoint: number }
export interface BetLimits { minStake: bigint; maxStake: bigint; maxWin: bigint }

export interface HandshakeData {
  sessionId: string;
  gameId: string;
  currency: string;
  balance: string;
  limits: { minStake: string; maxStake: string; maxWin: string };
  expiresAt: string;
}

export interface SnapshotFrame {
  type: 'snapshot';
  roundId: number | null;
  phase: GamePhase;
  multiplier: number;
  elapsedMs: number;
  bettingEndsInMs: number;
  serverSeedHash: string | null;
  balance: string;
  bets: [BetFrame | null, BetFrame | null];
}
export interface BettingFrame {
  type: 'round:betting';
  roundId: number;
  serverSeedHash: string;
  clientSeeds: string[];
  bettingEndsInMs: number;
}
export interface FlyingFrame {
  type: 'round:flying';
  roundId: number;
  serverSeedHash: string;
  multiplier: number;
  elapsedMs: number;
}
export interface TickFrame { type: 'round:tick'; roundId: number; multiplier: number; elapsedMs: number }
export interface CrashedFrame {
  type: 'round:crashed';
  roundId: number;
  crashPoint: number;
  serverSeed: string;
  serverSeedHash: string;
  clientSeedComposite: string | null;
  crashedAt: string;
}
export interface BetUpdateFrame extends BetFrame { type: 'bet:update' }
export interface BalanceFrame { type: 'balance:update'; balance: string }
export interface SessionEndedFrame { type: 'session:ended'; reason: string }
export interface ErrorFrame { type: 'error'; code: string; message: string }

export type ServerFrame =
  | SnapshotFrame | BettingFrame | FlyingFrame | TickFrame | CrashedFrame
  | BetUpdateFrame | BalanceFrame | SessionEndedFrame | ErrorFrame;
```

**Step 4: Browser fair math — `src/client/fair.ts`**

`src/domain/provablyFair.ts` imports `node:crypto` and must not be bundled. The browser copy verifies the same math with Web Crypto; `clientSeedComposite` is already the colon-joined seed string.

```ts
export const DEFAULT_SEEDS = [
  'stratos_slot_1_00000001',
  'stratos_slot_2_00000002',
  'stratos_slot_3_00000003',
] as const;

const TWO_POW_52 = 4503599627370496;

export function multiplierAtElapsedMs(elapsedMs: number): number {
  if (elapsedMs <= 0) return 1.0;
  return Math.max(1.0, Math.floor(Math.exp(0.00006 * elapsedMs) * 100) / 100);
}

export interface ProofPayload {
  roundId: number;
  serverSeed: string;
  serverSeedHash: string;
  clientSeedComposite: string | null;
  crashPoint: number;
}

export interface VerifyResult {
  serverSeedHashComputed: string;
  serverSeedHashMatches: boolean;
  combinedInput: string;
  sha512Hash: string;
  hexSlice52Bit: string;
  decimalValue: number;
  computedCrashPoint: number;
  crashPointMatches: boolean;
}

async function digestHex(algorithm: 'SHA-256' | 'SHA-512', input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = new Uint8Array(await crypto.subtle.digest(algorithm, data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function crashPointFromDecimal(decimalValue: number): number {
  if (!Number.isFinite(decimalValue)) return 1.0;
  if (decimalValue % 33 === 0) return 1.0;
  const raw = Math.floor((100 * TWO_POW_52 - decimalValue) / (TWO_POW_52 - decimalValue)) / 100;
  return Math.max(1.0, Math.min(raw, 100_000.0));
}

export async function verifyProof(proof: ProofPayload): Promise<VerifyResult> {
  const serverSeedHashComputed = await digestHex('SHA-256', proof.serverSeed);
  const combinedInput = `${proof.serverSeed}:${proof.clientSeedComposite ?? DEFAULT_SEEDS.join(':')}`;
  const sha512Hash = await digestHex('SHA-512', combinedInput);
  const hexSlice52Bit = sha512Hash.slice(0, 13);
  const decimalValue = Number.parseInt(hexSlice52Bit, 16);
  const computedCrashPoint = crashPointFromDecimal(decimalValue);
  return {
    serverSeedHashComputed,
    serverSeedHashMatches: serverSeedHashComputed.toLowerCase() === proof.serverSeedHash.toLowerCase(),
    combinedInput,
    sha512Hash,
    hexSlice52Bit,
    decimalValue,
    computedCrashPoint,
    crashPointMatches: Math.abs(computedCrashPoint - proof.crashPoint) < 0.001,
  };
}
```

**Step 5: Copy the visual pieces**

`flightCanvasRenderer.ts`: copy verbatim, replace `import type { GamePhase } from '../../../shared/types.ts';` with `import type { GamePhase } from '../types';`.

`src/index.css`: copy the prototype file and add after `@theme`:

```css
:root {
  --g-bg: #0b0e14;
  --g-panel: #111622;
  --g-text: #f1f5f9;
  --g-hint: #94a3b8;
  --g-accent: #10b981;
  --g-on-accent: #ffffff;
  --g-gold: #f59e0b;
  --g-danger: #f43f5e;
  --g-safe-bottom: 0px;
}
```

`sound.ts`: copy, rename the export to `soundEngine`, delete `playRainDrop` and `isMuted`.

`FlightCanvas.tsx`: copy and then apply exactly these changes:
- Props:

```ts
interface FlightCanvasProps {
  roundId: number | null;
  phase: GamePhase;
  multiplier: number;
  elapsedMs: number;
  bettingEndsAt: number | null;
  bettingWindowMs: number;
  serverSeedHash: string | null;
  connected: boolean;
  history: readonly RoundHistoryItem[];
  muted: boolean;
  lang: Lang;
  isFullscreen: boolean;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onSelectHistoryRound: (roundId: number) => void;
  onOpenFairness: () => void;
}
```

- Imports become `../types`, `../fair` (`multiplierAtElapsedMs`), `./flightCanvasRenderer`, `../i18n` (`t`), and lucide icons. Delete `PlayerAvatar`, `FloatingCashoutEvent`, the `floatingCashouts`/`activeCashouts` overlay, `onlineCount`, and the `WifiOff` online label; keep `Wifi`/`WifiOff` as a connection dot next to the round label.
- Countdown uses `bettingEndsAt` (`remaining = Math.max(0, bettingEndsAt - Date.now())`, progress `remaining / bettingWindowMs`) and disappears when `bettingEndsAt === null`; the BETTING overlay label is `t(lang, 'nextRoundIn')`, the CRASHED label is `t(lang, 'crashedAt')`.
- Buttons get `t(lang, 'mute' | 'unmute' | 'fullScreen' | 'exitFullScreen' | 'provablyFair')` as labels/titles.
- Replace structural palette classes with theme variables: container `bg-[var(--g-panel)] border-white/10`, round label `text-[var(--g-text)]`, hints `text-[var(--g-hint)]`, history header panel `bg-[var(--g-panel)]`, seed footer `text-[var(--g-hint)]`. Keep the multiplier history chip colors and the canvas scene as-is.
- Fullscreen heights: `isFullscreen ? 'h-[calc(100dvh-190px)] min-h-[300px]' : 'h-[300px] sm:h-[380px]'`.

**Step 6: Hook — `src/client/hooks/useCrashSocket.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { haptic } from '../bridge';
import { soundEngine } from '../sound';
import type {
  BetFrame, GamePhase, RoundHistoryItem, ServerFrame,
} from '../types';

const BETTING_WINDOW_MS = 5_500;

export function useCrashSocket(input: { token: string; onSessionEnded: () => void }) {
  const { token, onSessionEnded } = input;
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<GamePhase>('BETTING');
  const [roundId, setRoundId] = useState<number | null>(null);
  const [multiplier, setMultiplier] = useState(1);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [bettingEndsAt, setBettingEndsAt] = useState<number | null>(null);
  const [bettingWindowMs, setBettingWindowMs] = useState(BETTING_WINDOW_MS);
  const [serverSeedHash, setServerSeedHash] = useState<string | null>(null);
  const [history, setHistory] = useState<RoundHistoryItem[]>([]);
  const [bets, setBets] = useState<[BetFrame | null, BetFrame | null]>([null, null]);
  const [balance, setBalance] = useState('0');
  const [lastError, setLastError] = useState<{ code: string; message: string } | null>(null);
  const [ended, setEnded] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const endedRef = useRef(false);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let unmounted = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;

    const showError = (code: string, message: string) => {
      setLastError({ code, message });
      haptic('error');
      if (errorTimer.current) clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => setLastError(null), 4000);
    };

    const handleFrame = (raw: string) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(raw) as ServerFrame;
      } catch {
        return;
      }
      switch (frame.type) {
        case 'snapshot':
          setPhase(frame.phase);
          setRoundId(frame.roundId);
          setMultiplier(frame.multiplier);
          setElapsedMs(frame.elapsedMs);
          setBettingWindowMs(BETTING_WINDOW_MS);
          setBettingEndsAt(frame.phase === 'BETTING' ? Date.now() + frame.bettingEndsInMs : null);
          setServerSeedHash(frame.serverSeedHash);
          setBalance(frame.balance);
          setBets(frame.bets);
          break;
        case 'round:betting':
          setPhase('BETTING');
          setRoundId(frame.roundId);
          setMultiplier(1);
          setElapsedMs(0);
          setBettingWindowMs(frame.bettingEndsInMs);
          setBettingEndsAt(Date.now() + frame.bettingEndsInMs);
          setServerSeedHash(frame.serverSeedHash);
          setBets([null, null]);
          break;
        case 'round:flying':
          setPhase('FLYING');
          setMultiplier(1);
          setElapsedMs(0);
          setBettingEndsAt(null);
          setServerSeedHash(frame.serverSeedHash);
          soundEngine.playTakeoff();
          break;
        case 'round:tick':
          setMultiplier(frame.multiplier);
          setElapsedMs(frame.elapsedMs);
          break;
        case 'round:crashed':
          setPhase('CRASHED');
          setMultiplier(frame.crashPoint);
          setHistory((prev) => [
            { roundId: frame.roundId, crashPoint: frame.crashPoint },
            ...prev.filter((item) => item.roundId !== frame.roundId),
          ].slice(0, 24));
          soundEngine.playCrash();
          break;
        case 'bet:update': {
          const bet: BetFrame = frame;
          setBets((prev) => {
            const next: [BetFrame | null, BetFrame | null] = [prev[0], prev[1]];
            next[bet.panel] = bet;
            return next;
          });
          if (bet.status === 'ACTIVE') soundEngine.playBetPlaced();
          if (bet.status === 'CASHED') {
            soundEngine.playCashout();
            haptic('success');
          }
          break;
        }
        case 'balance:update':
          setBalance(frame.balance);
          break;
        case 'session:ended':
          endedRef.current = true;
          setEnded(frame.reason);
          ws?.close();
          onSessionEnded();
          break;
        case 'error':
          showError(frame.code, frame.message);
          break;
      }
    };

    const connect = () => {
      if (unmounted || endedRef.current) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        if (unmounted) return;
        setConnected(true);
        ws?.send(JSON.stringify({ type: 'auth', token }));
      };
      ws.onmessage = (event) => {
        if (!unmounted) handleFrame(event.data as string);
      };
      ws.onclose = () => {
        if (unmounted) return;
        setConnected(false);
        if (!endedRef.current) reconnectTimer = setTimeout(connect, 1200);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (errorTimer.current) clearTimeout(errorTimer.current);
      ws?.close();
      wsRef.current = null;
    };
  }, [token, onSessionEnded]);

  const send = useCallback((frame: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }, []);

  const placeBet = useCallback((panel: 0 | 1, stakeMinor: bigint, autoCashout: number | null) => {
    haptic('tap');
    send({ type: 'bet:place', panel, stake: stakeMinor.toString(), ...(autoCashout === null ? {} : { autoCashout }) });
  }, [send]);

  const cancelBet = useCallback((panel: 0 | 1) => {
    haptic('tap');
    send({ type: 'bet:cancel', panel });
  }, [send]);

  const cashout = useCallback((panel: 0 | 1) => send({ type: 'bet:cashout', panel }), [send]);

  return {
    connected, phase, roundId, multiplier, elapsedMs, bettingEndsAt, bettingWindowMs,
    serverSeedHash, history, bets, balance, lastError, ended,
    placeBet, cancelBet, cashout,
  };
}
```

`onSessionEnded` must be stable in `App` (wrap in `useCallback`) or the socket reconnects on every render.

**Step 7: Bridge — `src/client/bridge.ts`**

```ts
import type { Lang } from './types';

interface ThemeMessage {
  type: 'bingo:theme';
  payload: {
    scheme: 'dark' | 'light';
    bg: string; panel: string; text: string; hint: string; button: string; buttonText: string;
    gold: string; danger: string; safeBottom: number; viewportHeight: number;
  };
}

export function installBridge(handlers: { onLocale: (lang: Lang) => void }) {
  // The parent play page posts its theme and locale to this iframe. Only a
  // message from the framing document's own origin is applied.
  const parentOrigin = document.referrer ? new URL(document.referrer).origin : null;
  window.addEventListener('message', (event) => {
    if (!parentOrigin || event.origin !== parentOrigin) return;
    const data = event.data as { type?: string; payload?: unknown } | null;
    if (data?.type === 'bingo:theme') {
      const payload = (data as ThemeMessage).payload;
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
      root.style.setProperty('--g-safe-bottom', `${payload.safeBottom}px`);
    }
    if (data?.type === 'bingo:locale') handlers.onLocale(data.payload === 'am' ? 'am' : 'en');
  });
}

// The parent validates the provider origin on its side; this frame has no
// secret to protect by choosing a narrower target.
export function haptic(kind: 'tap' | 'success' | 'error') {
  window.parent.postMessage({ type: 'bingo:haptic', payload: kind }, '*');
}

export function exitGame() {
  window.parent.postMessage({ type: 'bingo:exit' }, '*');
}
```

**Step 8: Strings — `src/client/i18n.ts`**

```ts
import type { Lang } from './types';

const en = {
  balance: 'Balance',
  bet: 'Bet',
  cancel: 'Cancel',
  cashOut: 'Cash out',
  autoCashout: 'Auto cash out',
  stake: 'Stake',
  waitingForNextRound: 'Waiting for next round',
  nextRoundIn: 'Next round in',
  crashedAt: 'Flew away at',
  won: 'Won',
  lost: 'Lost',
  sessionEnded: 'Session ended',
  sessionEndedBody: 'Your game session is closed. Return to the lobby to play again.',
  backToGames: 'Back to games',
  provablyFair: 'Provably fair',
  round: 'Round',
  loading: 'Loading game…',
  loadFailed: 'Could not load the game. Return to the lobby and try again.',
  reconnecting: 'Connection lost. Reconnecting…',
  mute: 'Mute sound',
  unmute: 'Unmute sound',
  fullScreen: 'Full screen',
  exitFullScreen: 'Exit full screen (Esc)',
  verifying: 'Verifying round…',
  verified: 'Verified authentic in your browser',
  verificationMismatch: 'Verification mismatch',
  proofUnavailable: 'No proof is stored for this round',
  inspect: 'Inspect',
  inspectHint: 'Tap any recent round to verify its SHA-512 math.',
  liveCommit: 'Live round pre-commit',
  serverSeedHidden: 'Server seed hidden until the round crashes',
  revealedServerSeed: 'Revealed server seed',
  committedHash: 'Pre-committed SHA-256 hash',
  combinedInput: 'Combined input (server seed + client seeds)',
  crashResult: 'Crash result',
  tap: 'Tap to bet',
};

const am: Record<keyof typeof en, string> = {
  balance: 'ቀሪ ሂሳብ',
  bet: 'ውርርድ አስቀምጥ',
  cancel: 'ሰርዝ',
  cashOut: 'አሁን ውጣ',
  autoCashout: 'ራስ-ሰር ውጣ',
  stake: 'ውርርድ',
  waitingForNextRound: 'ቀጣዩን ዙር በመጠበቅ',
  nextRoundIn: 'ቀጣዩ ዙር በ',
  crashedAt: 'የተቋረጠበት',
  won: 'አሸንፈዋል',
  lost: 'ተሸንፈዋል',
  sessionEnded: 'ክፍለ ጊዜው አብቅቷል',
  sessionEndedBody: 'የጨዋታ ክፍለ ጊዜዎ ተዘግቷል። ለመጫወት ወደ መግቢያው ይመለሱ።',
  backToGames: 'ወደ ጨዋታዎች',
  provablyFair: 'ሊረጋገጥ የሚችል ፍትሃዊነት',
  round: 'ዙር',
  loading: 'ጨዋታ በመጫን ላይ…',
  loadFailed: 'ጨዋታውን መጫን አልተቻለም። ወደ መግቢያው ተመልሰው እንደገና ይሞክሩ።',
  reconnecting: 'ግንኙነት ተቋርጧል። በድጋሚ በመገናኘት ላይ…',
  mute: 'ድምጽ አጥፋ',
  unmute: 'ድምጽ አብራ',
  fullScreen: 'ሙሉ ማያ',
  exitFullScreen: 'ሙሉ ማያ ውጣ (Esc)',
  verifying: 'ዙሩን በማረጋገጥ ላይ…',
  verified: 'በአሳሽዎ ውስጥ ተረጋግጧል',
  verificationMismatch: 'ማረጋገጫ አልተመሳሰለም',
  proofUnavailable: 'ለዚህ ዙር ማስረጃ አልተቀመጠም',
  inspect: 'መርምር',
  inspectHint: 'የማንኛውንም የቅርብ ዙር ላይ በመንካት የSHA-512 ስሌቱን ያረጋግጡ።',
  liveCommit: 'የቀጣዩ ዙር ቅድመ-ቁርጠኝነት',
  serverSeedHidden: 'የሰርቨር ዘር እስከ መቋረጡ ድረስ ተደብቋል',
  revealedServerSeed: 'የተገለጠ የሰርቨር ዘር',
  committedHash: 'ቅድሚያ የተረጋገጠ SHA-256 ሃሽ',
  combinedInput: 'የተዋሃደ ግብዓት (የሰርቨር ዘር + የደንበኛ ዘሮች)',
  crashResult: 'የመቋረጥ ውጤት',
  tap: 'ለመወራረድ ይንኩ',
};

export const strings: Record<Lang, Record<string, string>> = { en, am };
export function t(lang: Lang, key: keyof typeof en): string {
  return strings[lang][key];
}
```

**Step 9: `src/client/components/BetPanel.tsx`**

```tsx
import React, { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { t } from '../i18n';
import type { BetFrame, BetLimits, GamePhase, Lang } from '../types';

interface BetPanelProps {
  panel: 0 | 1;
  phase: GamePhase;
  multiplier: number;
  currency: string;
  balanceMinor: bigint;
  limits: BetLimits;
  bet: BetFrame | null;
  lang: Lang;
  onPlace: (panel: 0 | 1, stakeMinor: bigint, autoCashout: number | null) => void;
  onCancel: (panel: 0 | 1) => void;
  onCashout: (panel: 0 | 1) => void;
}

const PRESETS_MAJOR = [1, 5, 25, 100];

export const money = (minor: bigint, currency: string) =>
  `${(Number(minor) / 100).toFixed(2)} ${currency}`;

export const BetPanel: React.FC<BetPanelProps> = ({
  panel, phase, multiplier, currency, balanceMinor, limits, bet, lang, onPlace, onCancel, onCashout,
}) => {
  const [stakeMajor, setStakeMajor] = useState('10');
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoValue, setAutoValue] = useState('2.00');

  const parsed = Number.parseFloat(stakeMajor);
  const stakeMinor = Number.isFinite(parsed) && parsed > 0 ? BigInt(Math.round(parsed * 100)) : 0n;
  const active = bet !== null && (bet.status === 'ACTIVE' || bet.status === 'PLACING');
  const cashed = bet?.status === 'CASHED';
  const finished = bet !== null && ['LOST', 'CANCELLED', 'REJECTED', 'UNRESOLVED'].includes(bet.status);
  const autoCashout = (() => {
    if (!autoEnabled) return null;
    const value = Number.parseFloat(autoValue);
    return Number.isFinite(value) && value >= 1.01 ? Number(value.toFixed(2)) : null;
  })();
  const outOfBounds = stakeMinor < limits.minStake || stakeMinor > limits.maxStake;
  const unaffordable = stakeMinor > balanceMinor;

  const adjust = (delta: number) => {
    const next = Math.max(1, (Number.parseFloat(stakeMajor) || 0) + delta);
    setStakeMajor(String(next));
  };

  const renderPrimary = () => {
    const base =
      'w-full h-full min-h-[56px] px-3 rounded-xl font-display font-bold flex flex-col items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50';
    if (active && phase === 'FLYING' && bet) {
      const estimate = BigInt(Math.floor(Number(bet.stake) * multiplier));
      return (
        <button type="button" onClick={() => onCashout(panel)}
          className={`${base} bg-[var(--g-gold)] text-slate-950`}>
          <span className="text-sm uppercase tracking-wide">{t(lang, 'cashOut')}</span>
          <span className="text-base font-mono tabular-nums">{money(estimate, currency)}</span>
        </button>
      );
    }
    if (active) {
      return (
        <button type="button" onClick={() => onCancel(panel)}
          className={`${base} bg-[var(--g-danger)] text-white`}>
          <span className="text-base">{t(lang, 'cancel')}</span>
          {bet && <span className="text-xs font-mono tabular-nums">{money(BigInt(bet.stake), currency)}</span>}
        </button>
      );
    }
    if (cashed && bet) {
      return (
        <button type="button" disabled className={`${base} bg-emerald-900/60 text-emerald-200`}>
          <span className="text-xs uppercase">{t(lang, 'won')}</span>
          <span className="text-base font-mono tabular-nums">+{money(BigInt(bet.payout ?? '0'), currency)}</span>
        </button>
      );
    }
    if (finished) {
      return (
        <button type="button" disabled className={`${base} bg-slate-800 text-slate-400`}>
          {t(lang, 'lost')}
        </button>
      );
    }
    if (phase !== 'BETTING') {
      return (
        <button type="button" disabled className={`${base} bg-slate-800 text-slate-400`}>
          {t(lang, 'waitingForNextRound')}
        </button>
      );
    }
    return (
      <button type="button" onClick={() => onPlace(panel, stakeMinor, autoCashout)}
        disabled={outOfBounds || unaffordable}
        className={`${base} bg-[var(--g-accent)] text-[var(--g-on-accent)]`}>
        <span className="text-base">{t(lang, 'bet')}</span>
        <span className="text-sm font-mono tabular-nums">{money(stakeMinor, currency)}</span>
      </button>
    );
  };

  return (
    <div className="bg-[var(--g-panel)] border border-white/10 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => adjust(-1)} aria-label="Decrease stake"
          disabled={active}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-slate-800 text-[var(--g-text)] disabled:opacity-40">
          <Minus className="w-4 h-4" />
        </button>
        <div className="flex-1 flex items-center justify-center gap-1 bg-black/30 border border-white/10 rounded-lg px-2 py-1.5">
          <input type="number" inputMode="decimal" min={1} step={1} value={stakeMajor}
            disabled={active} onChange={(event) => setStakeMajor(event.target.value)}
            aria-label={t(lang, 'stake')}
            className="w-20 bg-transparent text-center font-mono font-semibold text-sm text-[var(--g-text)] focus:outline-none disabled:opacity-50" />
          <span className="text-xs font-mono text-[var(--g-hint)]">{currency}</span>
        </div>
        <button type="button" onClick={() => adjust(1)} aria-label="Increase stake"
          disabled={active}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-slate-800 text-[var(--g-text)] disabled:opacity-40">
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {PRESETS_MAJOR.map((preset) => (
          <button key={preset} type="button" disabled={active}
            onClick={() => setStakeMajor(String(preset))}
            className="py-1.5 text-xs font-mono rounded-md bg-black/30 border border-white/10 text-[var(--g-hint)] hover:text-[var(--g-text)] disabled:opacity-40">
            {preset}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 text-xs text-[var(--g-hint)]">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input type="checkbox" checked={autoEnabled} disabled={active}
            onChange={(event) => setAutoEnabled(event.target.checked)}
            className="w-4 h-4 accent-[var(--g-gold)]" />
          <span>{t(lang, 'autoCashout')}</span>
        </label>
        <div className="flex items-center gap-1 bg-black/30 border border-white/10 rounded-md px-2 py-1">
          <input type="number" inputMode="decimal" min={1.01} step={0.01} value={autoValue}
            disabled={!autoEnabled || active}
            onChange={(event) => setAutoValue(event.target.value)}
            aria-label={t(lang, 'autoCashout')}
            className="w-14 bg-transparent text-right font-mono text-xs text-[var(--g-text)] focus:outline-none disabled:opacity-40" />
          <span className="font-mono text-[var(--g-hint)]">x</span>
        </div>
      </div>

      <div className="h-14">{renderPrimary()}</div>
    </div>
  );
};
```

**Step 10: `src/client/components/ProvablyFairModal.tsx`**

```tsx
import React, { useEffect, useState } from 'react';
import { CheckCircle2, ShieldCheck, X, XCircle } from 'lucide-react';
import { t } from '../i18n';
import { verifyProof, type ProofPayload, type VerifyResult } from '../fair';
import type { Lang } from '../types';

interface ProvablyFairModalProps {
  isOpen: boolean;
  onClose: () => void;
  lang: Lang;
  currentRoundId: number | null;
  currentServerSeedHash: string | null;
  inspectedRoundId: number | null;
}

export const ProvablyFairModal: React.FC<ProvablyFairModalProps> = ({
  isOpen, onClose, lang, currentRoundId, currentServerSeedHash, inspectedRoundId,
}) => {
  const [proof, setProof] = useState<ProofPayload | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookup, setLookup] = useState('');

  const load = (id: number) => {
    setLoading(true);
    setError(null);
    setProof(null);
    setResult(null);
    return fetch(`/api/rounds/${id}/proof`)
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        const body = (await response.json()) as { data: ProofPayload };
        setProof(body.data);
      })
      .catch(() => setError(t(lang, 'proofUnavailable')))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!isOpen || inspectedRoundId === null) return;
    setLookup(String(inspectedRoundId));
    void load(inspectedRoundId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, inspectedRoundId]);

  useEffect(() => {
    if (!proof) return;
    let cancelled = false;
    void verifyProof(proof).then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, [proof]);

  if (!isOpen) return null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const id = Number(lookup);
    if (Number.isSafeInteger(id) && id > 0) void load(id);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      style={{ paddingBottom: 'calc(var(--g-safe-bottom) + 1rem)' }}>
      <div className="w-full max-w-xl max-h-[90dvh] overflow-y-auto bg-[var(--g-panel)] border border-white/10 rounded-xl shadow-2xl">
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-3 sticky top-0 bg-[var(--g-panel)]">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <h2 className="text-sm font-display font-bold text-[var(--g-text)]">{t(lang, 'provablyFair')}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="p-1.5 rounded-lg text-[var(--g-hint)] hover:text-[var(--g-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4 text-xs">
          <section className="rounded-lg bg-black/30 border border-white/10 p-3 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[var(--g-text)]">
                {t(lang, 'liveCommit')} #{currentRoundId ?? '—'}
              </span>
              <span className="text-[var(--g-hint)]">{t(lang, 'serverSeedHidden')}</span>
            </div>
            <div className="font-mono break-all text-[var(--g-hint)]">
              SHA-256: {currentServerSeedHash ?? '…'}
            </div>
          </section>

          <section className="rounded-lg bg-black/30 border border-white/10 p-3 flex flex-col gap-2">
            <form onSubmit={submit} className="flex items-center gap-1.5">
              <input type="number" min={1} value={lookup} onChange={(event) => setLookup(event.target.value)}
                aria-label={t(lang, 'round')}
                className="w-24 bg-black/40 border border-white/10 rounded-md px-2 py-1 font-mono text-[var(--g-text)] focus:outline-none" />
              <button type="submit" className="px-3 py-1 rounded-md bg-slate-800 text-[var(--g-text)] font-medium">
                {t(lang, 'inspect')}
              </button>
            </form>

            {loading && <div className="py-4 text-center text-[var(--g-hint)]">{t(lang, 'verifying')}</div>}
            {error && <div className="py-4 text-center text-[var(--g-danger)]">{error}</div>}
            {!loading && !error && !proof && (
              <div className="py-4 text-center text-[var(--g-hint)]">{t(lang, 'inspectHint')}</div>
            )}

            {proof && result && (
              <div className="flex flex-col gap-2">
                <div className={`p-2.5 rounded-md border flex items-center justify-between gap-2 ${
                  result.serverSeedHashMatches && result.crashPointMatches
                    ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                    : 'bg-rose-950/40 border-rose-500/40 text-rose-200'
                }`}>
                  <span className="flex items-center gap-1.5 font-semibold">
                    {result.serverSeedHashMatches && result.crashPointMatches
                      ? <CheckCircle2 className="w-4 h-4" />
                      : <XCircle className="w-4 h-4" />}
                    {result.serverSeedHashMatches && result.crashPointMatches
                      ? `${t(lang, 'verified')} · #${proof.roundId}`
                      : t(lang, 'verificationMismatch')}
                  </span>
                  <span className="font-mono font-bold tabular-nums">{result.computedCrashPoint.toFixed(2)}x</span>
                </div>
                <div>
                  <div className="text-[var(--g-hint)] mb-1">{t(lang, 'revealedServerSeed')}</div>
                  <div className="font-mono break-all text-[var(--g-text)]">{proof.serverSeed}</div>
                </div>
                <div>
                  <div className="text-[var(--g-hint)] mb-1">{t(lang, 'committedHash')}</div>
                  <div className="font-mono break-all text-emerald-300">{result.serverSeedHashComputed}</div>
                </div>
                <div>
                  <div className="text-[var(--g-hint)] mb-1">{t(lang, 'combinedInput')}</div>
                  <div className="font-mono break-all text-[var(--g-text)]">{result.combinedInput}</div>
                </div>
                <div className="font-mono text-[var(--g-hint)]">
                  SHA-512 → {result.hexSlice52Bit} → {result.crashResultLabel}
                </div>
                <div className="font-mono text-[var(--g-text)]">
                  {t(lang, 'crashResult')}: {result.computedCrashPoint.toFixed(2)}x
                  {result.decimalValue % 33 === 0 ? ' · instant crash (edge)' : ''}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
```

Remove the stray `crashResultLabel` reference (it does not exist): the SHA-512 line ends at `→ {result.hexSlice52Bit}`.

**Step 11: `src/client/App.tsx` and `src/main.tsx`**

```tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { exitGame, installBridge } from './bridge';
import { t } from './i18n';
import { money, BetPanel } from './components/BetPanel';
import { FlightCanvas } from './components/FlightCanvas';
import { ProvablyFairModal } from './components/ProvablyFairModal';
import { useCrashSocket } from './hooks/useCrashSocket';
import { soundEngine } from './sound';
import type { HandshakeData, Lang } from './types';

type Boot =
  | { state: 'loading' }
  | { state: 'ready'; session: HandshakeData }
  | { state: 'ended' }
  | { state: 'error' };

function readLang(): Lang {
  const value = new URLSearchParams(window.location.search).get('lang');
  return value === 'am' ? 'am' : 'en';
}

const EndedScreen: React.FC<{ lang: Lang; body?: string }> = ({ lang, body }) => (
  <div className="min-h-dvh bg-[var(--g-bg)] text-[var(--g-text)] flex flex-col items-center justify-center gap-3 px-6 text-center">
    <p className="font-display text-lg font-bold">
      {body ?? t(lang, 'sessionEnded')}
    </p>
    {body === undefined && <p className="text-sm text-[var(--g-hint)]">{t(lang, 'sessionEndedBody')}</p>}
    <button type="button" onClick={exitGame}
      className="px-4 py-2 rounded-lg bg-[var(--g-accent)] text-[var(--g-on-accent)] font-semibold">
      {t(lang, 'backToGames')}
    </button>
  </div>
);

const GameScreen: React.FC<{ token: string; session: HandshakeData; lang: Lang }> = ({
  token, session, lang,
}) => {
  const [ended, setEnded] = useState(false);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fairnessOpen, setFairnessOpen] = useState(false);
  const [inspectedRoundId, setInspectedRoundId] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const enteredNativeRef = useRef(false);

  const onSessionEnded = useCallback(() => {
    setEnded(true);
    exitGame();
  }, []);
  const socket = useCrashSocket({ token, onSessionEnded });

  const limits = {
    minStake: BigInt(session.limits.minStake),
    maxStake: BigInt(session.limits.maxStake),
    maxWin: BigInt(session.limits.maxWin),
  };
  const balanceMinor = BigInt(socket.balance);

  useEffect(() => {
    const onFullscreenChange = () => {
      const nativeActive = Boolean(document.fullscreenElement);
      if (nativeActive) {
        enteredNativeRef.current = true;
        setIsFullscreen(true);
      } else if (enteredNativeRef.current) {
        enteredNativeRef.current = false;
        setIsFullscreen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isFullscreen && !document.fullscreenElement) setIsFullscreen(false);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isFullscreen]);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          // fall through to the expanded viewport state
        }
      }
      enteredNativeRef.current = false;
      setIsFullscreen(false);
      return;
    }
    const element = containerRef.current;
    if (element && typeof element.requestFullscreen === 'function') {
      try {
        await element.requestFullscreen();
        enteredNativeRef.current = true;
      } catch {
        enteredNativeRef.current = false;
      }
    }
    setIsFullscreen(true);
  }, [isFullscreen]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    soundEngine.setMuted(next);
  };

  if (ended || socket.ended !== null) {
    return <EndedScreen lang={lang} />;
  }

  return (
    <div ref={containerRef}
      className={`bg-[var(--g-bg)] text-[var(--g-text)] flex flex-col ${
        isFullscreen ? 'fixed inset-0 z-50 overflow-y-auto' : 'min-h-dvh'
      }`}>
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="font-display font-bold">Crash</div>
        <div className="font-mono font-bold tabular-nums text-[var(--g-gold)]">
          {money(balanceMinor, session.currency)}
        </div>
      </header>

      {!socket.connected && socket.ended === null && (
        <div className="mx-3 mb-2 rounded-lg bg-amber-950/60 border border-amber-500/40 px-3 py-1.5 text-xs text-amber-200">
          {t(lang, 'reconnecting')}
        </div>
      )}
      {socket.lastError && (
        <div className="mx-3 mb-2 rounded-lg bg-rose-950/70 border border-rose-500/40 px-3 py-1.5 text-xs text-rose-200">
          {socket.lastError.message}
        </div>
      )}

      <main className="flex-1 w-full max-w-[760px] mx-auto px-3 pb-[calc(var(--g-safe-bottom)+0.75rem)] flex flex-col gap-3">
        <FlightCanvas
          roundId={socket.roundId}
          phase={socket.phase}
          multiplier={socket.multiplier}
          elapsedMs={socket.elapsedMs}
          bettingEndsAt={socket.bettingEndsAt}
          bettingWindowMs={socket.bettingWindowMs}
          serverSeedHash={socket.serverSeedHash}
          connected={socket.connected}
          history={socket.history}
          muted={muted}
          lang={lang}
          isFullscreen={isFullscreen}
          onToggleMute={toggleMute}
          onToggleFullscreen={() => void toggleFullscreen()}
          onSelectHistoryRound={(target) => {
            setInspectedRoundId(target);
            setFairnessOpen(true);
          }}
          onOpenFairness={() => {
            setInspectedRoundId(null);
            setFairnessOpen(true);
          }}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {([0, 1] as const).map((panel) => (
            <BetPanel key={panel} panel={panel} phase={socket.phase} multiplier={socket.multiplier}
              currency={session.currency} balanceMinor={balanceMinor} limits={limits}
              bet={socket.bets[panel]} lang={lang}
              onPlace={socket.placeBet} onCancel={socket.cancelBet} onCashout={socket.cashout} />
          ))}
        </div>
      </main>

      <ProvablyFairModal isOpen={fairnessOpen} onClose={() => setFairnessOpen(false)} lang={lang}
        currentRoundId={socket.roundId} currentServerSeedHash={socket.serverSeedHash}
        inspectedRoundId={inspectedRoundId} />
    </div>
  );
};

export default function App() {
  const [lang, setLang] = useState<Lang>(readLang);
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });
  const token = useRef(new URLSearchParams(window.location.search).get('token')).current;

  useEffect(() => {
    installBridge({ onLocale: setLang });
  }, []);

  useEffect(() => {
    if (!token) {
      setBoot({ state: 'ended' });
      return;
    }
    let cancelled = false;
    fetch('/api/sessions/handshake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 410) {
          setBoot({ state: 'ended' });
          return;
        }
        if (!response.ok) {
          setBoot({ state: 'error' });
          return;
        }
        const body = (await response.json()) as { data: HandshakeData };
        setBoot({ state: 'ready', session: body.data });
      })
      .catch(() => {
        if (!cancelled) setBoot({ state: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (boot.state === 'loading') {
    return (
      <div className="min-h-dvh bg-[var(--g-bg)] text-[var(--g-hint)] flex items-center justify-center text-sm">
        {t(lang, 'loading')}
      </div>
    );
  }
  if (boot.state === 'ended') return <EndedScreen lang={lang} />;
  if (boot.state === 'error') return <EndedScreen lang={lang} body={t(lang, 'loadFailed')} />;
  return <GameScreen token={token as string} session={boot.session} lang={lang} />;
}
```

`src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import App from './client/App';
import './index.css';

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
```

**Step 12: Serve under `/play`**

- `vite.config.ts`: add `base: '/play/',` to the config object (assets must resolve under the mounted static path).
- `index.html`: keep `<script type="module" src="/src/main.tsx">`; replace the JWT/iframe marketing description with: `Real-time crash game with two bet panels, auto cash-out, and browser-verifiable SHA-512 round proofs.`

**Step 13: Verify**

```bash
npm run games:typecheck
npm run games:test
npm run games:build
grep -rn "firebase\|jsonwebtoken\|recharts" apps/games-provider/src || echo clean
grep -o '/play/assets/[^"]*' apps/games-provider/dist/client/index.html | head -3
```

Expected: typecheck and tests green; build emits `dist/client`; grep prints `clean`; the built `index.html` references `/play/assets/...`.

Then prove the served surface without a database. Write a throwaway harness at `.superpowers/sdd/2026-11-17-games-provider-v1/browser-harness.ts` (git-ignored, not committed):

```ts
import { createFakeBingo, FAKE_BINGO_TOKEN } from '../../apps/games-provider/src/test/fakeBingo';
import { createMemoryStore } from '../../apps/games-provider/src/test/memoryStore';
import { startTestServer } from '../../apps/games-provider/src/test/server';
import { HttpWalletClient } from '../../apps/games-provider/src/server/wallet';
import type { AppConfig } from '../../apps/games-provider/src/config';

const secret = 'harness-secret-000000000000';
const fake = await createFakeBingo({ hmacSecret: secret, balance: 100_000n });
const config: AppConfig = {
  port: 0,
  databaseUrl: '',
  operator: {
    code: 'bingo251', name: 'Bingo 251', callbackUrl: fake.url, hmacSecret: secret, currency: 'ETB',
  },
  allowedParentOrigins: ['http://localhost:3000'],
  limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
  clientSeeds: ['stratos_slot_1_00000001', 'stratos_slot_2_00000002', 'stratos_slot_3_00000003'],
  botCount: 0,
};
const store = createMemoryStore();
const wallet = new HttpWalletClient({ callbackUrl: fake.url, hmacSecret: secret });
const server = await startTestServer({ config, store, wallet });
await server.engine.start();
console.log(`open ${server.url}/play?token=${FAKE_BINGO_TOKEN}&lang=en`);

const stop = async () => {
  await server.close();
  await fake.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
```

Run it with `node --import tsx .superpowers/sdd/2026-11-17-games-provider-v1/browser-harness.ts` from the repo root, then:
1. `curl -s http://127.0.0.1:<port>/play?token=<uuid>&lang=en | grep -o '/play/assets/[^"]*'` returns asset URLs that also return 200.
2. With a browser tool if available, load the page: canvas renders, balance shows `1000.00 ETB`, a bet places, `Cancel` appears, and a later round allows `Cash out`. If no browser tool is available, report that visual verification is pending for the controller.

**Step 14: Commit**

```bash
git add apps/games-provider/src apps/games-provider/server.ts apps/games-provider/src/test/server.ts \
  apps/games-provider/tests apps/games-provider/vite.config.ts apps/games-provider/index.html
git commit -m "feat(games-provider): ship the crash client with themed bridge, two-panel betting, and pushed settlements"
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
