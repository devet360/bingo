# Games Provider V2 — Area A (multi-operator foundation) + Area G (onboarding) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run several operators on one `apps/games-provider` deployment with provable isolation (Area A), and give the provider a verified onboarding path for each new operator (Area G).

**Architecture:** The provider owns an operator registry (`operators` + `operator_secrets`). Every session, bet, outbox row and wallet call is scoped to one operator code. Outbound callbacks are signed with a domain-separated HMAC (`${operatorCode}.${rawBody}`) using the newest active secret; inbound movement and balance replies verify against every active secret, so a rotation overlaps without downtime. Bingo-side changes stay additive: an `{operator}` launch placeholder, dual (prefixed-or-legacy) signature verification, and a probe route.

**Tech Stack:** TypeScript, Express 4, `ws`, Drizzle ORM 0.45 + Postgres, zod, node:test, React 19/Vite 8 client, Prisma/Express in `apps/api`.

**Spec:** `docs/superpowers/specs/2026-11-17-games-provider-v2-requirements.md` (§4 Area A, §10 Area G, §13 decisions 1 and 4).

## Global Constraints

- Bingo remains the only wallet. The provider never holds authoritative money.
- Money is `bigint` minor units end-to-end; the wire format is a decimal string.
- Every bet reaches a terminal wallet state; idempotency stays keyed on `(operatorCode, txnId, type)`.
- A session token from operator A can never be used, read or settled under operator B.
- The crash point derivation (`sha512` over the frozen seed triple) is unchanged.
- Secrets never appear in logs, API responses, docs or tests. Tests use obvious fixtures such as `test-secret-operator-a`.
- Bingo-side changes are additive: optional fields and new routes only; existing V1 provider traffic keeps working during rollout.
- No new Redis or other dependency. Postgres is the only store.
- Deployment stays owner-run: this plan ends at a green local build and a written runbook, never at a push or deploy.
- Commit rule: every task commit includes any leftover uncommitted work from that task's area.
- Casing: operator codes are lowercase `[a-z0-9_-]{2,32}`; HTTP error bodies stay `{ error: { code, message? } }`; success bodies stay `{ data: ... }`.

## Rulings (settled before execution)

1. **One shared crash round engine.** Rounds stay global (`rounds` has no operator column); bets carry `operatorCode`. This preserves the shared-liquidity display and keeps the V1 engine untouched.
2. **Bootstrap operator stays env-seeded.** `OPERATOR_*` env remains required and seeds the first operator on boot. Additional operators are created through the admin API. Env is authoritative for the bootstrap operator's identity, limits and origins; lifecycle (`status`, `probeOkAt`, `createdAt`) is preserved across restarts.
3. **Outbound signatures are prefixed, inbound verification is dual.** Provider signs `${operatorCode}.${rawBody}`. Bingo verifies the prefixed form first and the V1 bare form second. Provider verifies balance replies (whose signing string is unchanged) against every active secret.
4. **At most two active secrets.** Rotation retires the oldest active secret before adding the new one. Outbound uses the newest; inbound tries newest first.
5. **Effective limits are the intersection** of the signed wallet reply and the operator record. An empty intersection is a typed `LIMITS_CONFLICT` (409), not a silent clamp.
6. **Admin auth for Area G is `PROVIDER_ADMIN_TOKEN`.** It is a bootstrap mechanism until Area E ships the scoped staff-console token; both compare timing-safe. When unset, admin routes answer `503 ADMIN_DISABLED`.
7. **No caches in the registry.** Every call reads the store so a config or rotation change takes effect on the next round, as Area A requires.

---

## Task A1: Operator registry foundation (types, store, schema, boot seed)

**Files:**
- Modify: `apps/games-provider/src/domain/types.ts`
- Modify: `apps/games-provider/src/server/store.ts`
- Modify: `apps/games-provider/src/test/memoryStore.ts`
- Modify: `apps/games-provider/src/db/schema.ts`
- Create: `apps/games-provider/drizzle/0002_*.sql` (generated, then hand-edited)
- Modify: `apps/games-provider/src/db/storePostgres.ts`
- Modify: `apps/games-provider/src/config.ts`
- Modify: `apps/games-provider/server.ts`
- Test: `apps/games-provider/tests/memoryStore.test.ts`, `apps/games-provider/tests/config.test.ts`

**Interfaces:**
- Produces: `OperatorRecord`, `OperatorSecretRecord`, `SessionRecord.gameId`, `SessionRecord.maxBetsPerRound`, `Store.listOperators`, `Store.listOperatorSecrets`, `Store.addOperatorSecret`, `Store.retireOperatorSecret`, `Store.countBetsForRoundByOperator`, `AppConfig.adminToken`, `AppConfig.defaultOperatorCode`.

- [ ] **Step 1: Rewrite the operator types and add secret types**

Replace `OperatorRecord` in `src/domain/types.ts` and extend `SessionRecord`:

```ts
export type OperatorStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED';

export interface OperatorLimits {
  minStake: bigint;
  maxStake: bigint;
  maxWin: bigint;
  maxBetsPerRound: number;
}

export interface OperatorRecord {
  code: string;
  name: string;
  callbackUrl: string;
  currency: string;
  status: OperatorStatus;
  allowedOrigins: string[];
  localeDefault: 'en' | 'am';
  limits: OperatorLimits;
  enabledGames: string[];
  theme: Record<string, unknown> | null;
  maintenance: boolean;
  probeOkAt: Date | null;
  createdAt: Date;
}

export interface OperatorSecretRecord {
  operatorCode: string;
  version: number;
  secret: string;
  createdAt: Date;
  retiredAt: Date | null;
}

export interface SessionRecord {
  token: string;
  operatorCode: string;
  gameId: string;
  currency: string;
  minStake: bigint;
  maxStake: bigint;
  maxWin: bigint;
  maxBetsPerRound: number;
  displayBalance: bigint;
  status: 'OPEN' | 'CLOSED';
  createdAt: Date;
  lastHandshakeAt: Date;
}
```

- [ ] **Step 2: Extend the Store interface**

In `src/server/store.ts`, import `OperatorSecretRecord` and add:

```ts
  listOperators(): Promise<OperatorRecord[]>;
  listOperatorSecrets(operatorCode: string): Promise<OperatorSecretRecord[]>;
  addOperatorSecret(operatorCode: string, secret: string): Promise<OperatorSecretRecord>;
  retireOperatorSecret(operatorCode: string, version: number): Promise<void>;
  countBetsForRoundByOperator(roundId: number, operatorCode: string): Promise<number>;
```

- [ ] **Step 3: Update the memory store and its test**

In `src/test/memoryStore.ts`:
- replace `const clone = <T extends object>(row: T): T => ({ ...row });` with `const clone = <T>(value: T): T => structuredClone(value);` so arrays, limits and dates are copied.
- add `const operatorSecrets = new Map<string, OperatorSecretRecord>();` keyed `${operatorCode}|${version}`.
- implement the five new methods; `addOperatorSecret` assigns `max(existing version) + 1`.

Test additions in `tests/memoryStore.test.ts` (replace the operator-shaped assertions):

```ts
const operator = {
  code: 'op-a', name: 'Operator A', callbackUrl: 'https://a.example/cb', currency: 'ETB',
  status: 'ACTIVE' as const, allowedOrigins: ['https://a.example'],
  localeDefault: 'en' as const,
  limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
  enabledGames: ['crash'], theme: { accent: '#f59e0b' }, maintenance: false,
  probeOkAt: new Date('2026-11-19T00:00:00Z'), createdAt: new Date('2026-11-19T00:00:00Z'),
};

test('operator records round-trip nested limits and arrays without aliasing', async () => {
  const store = createMemoryStore();
  await store.upsertOperator(operator);
  const read = await store.getOperator('op-a');
  assert.deepEqual(read, operator);
  read!.allowedOrigins.push('https://evil.example');
  assert.deepEqual((await store.getOperator('op-a'))!.allowedOrigins, ['https://a.example']);
});

test('operator secrets version up and retire in place', async () => {
  const store = createMemoryStore();
  await store.upsertOperator(operator);
  const v1 = await store.addOperatorSecret('op-a', 'secret-one');
  const v2 = await store.addOperatorSecret('op-a', 'secret-two');
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  await store.retireOperatorSecret('op-a', 1);
  const secrets = await store.listOperatorSecrets('op-a');
  assert.equal(secrets.find((s) => s.version === 1)?.retiredAt instanceof Date, true);
  assert.equal(secrets.find((s) => s.version === 2)?.retiredAt, null);
});

test('bets-per-round counts are scoped per operator', async () => {
  const store = createMemoryStore();
  const round = await store.createRound({ serverSeed: 's', serverSeedHash: 'h', startedAt: new Date() });
  const base = {
    roundId: round.id, panel: 0 as const, stake: 100n, autoCashout: null,
    status: 'ACTIVE' as const, cashoutMultiplier: null, payout: null,
    betTxnId: 't1', winTxnId: null,
  };
  await store.insertBet({ ...base, operatorCode: 'op-a', sessionToken: '11111111-1111-4111-8111-111111111111' });
  await store.insertBet({ ...base, operatorCode: 'op-b', sessionToken: '22222222-2222-4222-8222-222222222222' });
  assert.equal(await store.countBetsForRoundByOperator(round.id, 'op-a'), 1);
  assert.equal(await store.countBetsForRound(round.id), 2);
});
```

- [ ] **Step 4: Change the Drizzle schema**

In `src/db/schema.ts` add `jsonb` and `primaryKey` to the imports and replace `operators`, plus add `operatorSecrets`:

```ts
export const operatorStatus = pgEnum('operator_status', ['PENDING', 'ACTIVE', 'SUSPENDED']);

export const operators = pgTable('operators', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  callbackUrl: text('callback_url').notNull(),
  currency: text('currency').notNull(),
  status: operatorStatus('status').notNull().default('PENDING'),
  allowedOrigins: text('allowed_origins').array().notNull().default(sql`'{}'::text[]`),
  localeDefault: text('locale_default').notNull().default('en'),
  minStake: bigint('min_stake', { mode: 'bigint' }).notNull().default(100n),
  maxStake: bigint('max_stake', { mode: 'bigint' }).notNull().default(100_000n),
  maxWin: bigint('max_win', { mode: 'bigint' }).notNull().default(3_000_000n),
  maxBetsPerRound: integer('max_bets_per_round').notNull().default(200),
  enabledGames: text('enabled_games').array().notNull().default(sql`'{crash}'::text[]`),
  theme: jsonb('theme').$type<Record<string, unknown> | null>(),
  maintenance: boolean('maintenance').notNull().default(false),
  probeOkAt: timestamp('probe_ok_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const operatorSecrets = pgTable('operator_secrets', {
  operatorCode: text('operator_code').notNull().references(() => operators.code, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  secret: text('secret').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.operatorCode, table.version] })]);
```

Add `gameId: text('game_id').notNull().default('crash')` to `sessions`.

- [ ] **Step 5: Generate the migration, then rewrite it with the data backfill**

Run (a dummy URL is enough; `generate` does not connect):

```bash
cd apps/games-provider && DATABASE_URL=postgres://placeholder npx drizzle-kit generate --name multi_operator
```

Keep the generated filename and `meta/` snapshot, and replace the SQL body with exactly (order matters — copy secrets out before dropping the column):

```sql
CREATE TYPE "public"."operator_status" AS ENUM('PENDING', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TABLE "operator_secrets" (
	"operator_code" text NOT NULL,
	"version" integer NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "operator_secrets_operator_code_version_pk" PRIMARY KEY("operator_code","version")
);
--> statement-breakpoint
ALTER TABLE "operator_secrets" ADD CONSTRAINT "operator_secrets_operator_code_operators_code_fk" FOREIGN KEY ("operator_code") REFERENCES "public"."operators"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "operator_secrets" ("operator_code", "version", "secret")
	SELECT "code", 1, "hmac_secret" FROM "operators" WHERE "hmac_secret" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "status" "operator_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "locale_default" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "min_stake" bigint DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "max_stake" bigint DEFAULT 100000 NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "max_win" bigint DEFAULT 3000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "max_bets_per_round" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "enabled_games" text[] DEFAULT '{crash}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "theme" jsonb;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "maintenance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "probe_ok_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "operators" SET "status" = CASE WHEN "enabled" THEN 'ACTIVE'::"public"."operator_status" ELSE 'SUSPENDED'::"public"."operator_status" END, "probe_ok_at" = now();--> statement-breakpoint
ALTER TABLE "operators" DROP COLUMN "hmac_secret";--> statement-breakpoint
ALTER TABLE "operators" DROP COLUMN "enabled";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "game_id" text DEFAULT 'crash' NOT NULL;
```

- [ ] **Step 6: Update the Postgres store**

Replace the operator mapper and upsert; add the new methods:

```ts
function toOperatorRecord(row: OperatorRow): OperatorRecord {
  return {
    code: row.code,
    name: row.name,
    callbackUrl: row.callbackUrl,
    currency: row.currency,
    status: row.status,
    allowedOrigins: [...row.allowedOrigins],
    localeDefault: row.localeDefault === 'am' ? 'am' : 'en',
    limits: {
      minStake: row.minStake,
      maxStake: row.maxStake,
      maxWin: row.maxWin,
      maxBetsPerRound: row.maxBetsPerRound,
    },
    enabledGames: [...row.enabledGames],
    theme: row.theme ?? null,
    maintenance: row.maintenance,
    probeOkAt: row.probeOkAt,
    createdAt: row.createdAt,
  };
}
```

`upsertOperator` sets every column above (including `theme`). `addOperatorSecret` reads `max(version)` for the operator, inserts `version + 1`, and returns the record; `retireOperatorSecret` sets `retiredAt = now()` on `(operatorCode, version)`; `listOperatorSecrets` orders by `version desc`; `countBetsForRoundByOperator` filters on both columns. Include `gameId`/`maxBetsPerRound` in the session mapper, insert and `onConflictDoUpdate` set.

- [ ] **Step 7: Add config fields (additive only)**

In `src/config.ts`:

```ts
  PROVIDER_ADMIN_TOKEN: z.string().min(16).optional(),
  DEFAULT_OPERATOR_CODE: z.string().min(1).optional(),
```

and in the returned object:

```ts
    adminToken: parsed.PROVIDER_ADMIN_TOKEN ?? null,
    defaultOperatorCode: parsed.DEFAULT_OPERATOR_CODE ?? parsed.OPERATOR_CODE,
```

Add a config test:

```ts
test('admin token and default operator code are optional and additive', () => {
  const defaults = loadConfig(baseEnv);
  assert.equal(defaults.adminToken, null);
  assert.equal(defaults.defaultOperatorCode, 'bingo251');
  const custom = loadConfig({
    ...baseEnv,
    PROVIDER_ADMIN_TOKEN: 'admin-token-for-tests',
    DEFAULT_OPERATOR_CODE: 'op-main',
  });
  assert.equal(custom.adminToken, 'admin-token-for-tests');
  assert.equal(custom.defaultOperatorCode, 'op-main');
});
```

- [ ] **Step 8: Seed the bootstrap operator on boot**

In `server.ts`, replace the inline `store.upsertOperator({...})` with:

```ts
async function seedBootstrapOperator(store: ReturnType<typeof createPostgresStore>, config: ReturnType<typeof loadConfig>) {
  const existing = await store.getOperator(config.operator.code);
  const now = new Date();
  await store.upsertOperator({
    code: config.operator.code,
    name: config.operator.name,
    callbackUrl: config.operator.callbackUrl,
    currency: config.operator.currency,
    status: existing?.status ?? 'ACTIVE',
    allowedOrigins: config.allowedParentOrigins,
    localeDefault: existing?.localeDefault ?? 'en',
    limits: config.limits,
    enabledGames: existing?.enabledGames ?? ['crash'],
    theme: existing?.theme ?? null,
    maintenance: existing?.maintenance ?? false,
    probeOkAt: existing?.probeOkAt ?? now,
    createdAt: existing?.createdAt ?? now,
  });
  if ((await store.listOperatorSecrets(config.operator.code)).length === 0) {
    await store.addOperatorSecret(config.operator.code, config.operator.hmacSecret);
  }
}
await seedBootstrapOperator(store, config);
```

- [ ] **Step 9: Run the suite and typecheck**

Run: `npm run games:test && npm run games:typecheck`
Expected: PASS. Fix remaining fixture churn mechanically (`OperatorRecord` literals now need `status`/limits/arrays; session literals need `gameId`/`maxBetsPerRound`).

- [ ] **Step 10: Commit**

```bash
git add apps/games-provider docs/superpowers/plans/2026-11-19-games-provider-v2-area-a.md
git commit -m "feat(games-provider): operator registry schema, store and boot seed"
```

---

## Task A2: Bingo additive launch placeholder and dual signature verification

**Files:**
- Modify: `apps/api/src/lib/providerContract.ts`
- Modify: `apps/api/src/lib/providerCallback.ts`
- Modify: `apps/api/src/services/gameProviders.ts`
- Test: `apps/api/tests/providerContract.test.ts`, `apps/api/tests/phase1.test.ts`

**Interfaces:**
- Produces: `LaunchContext.operator?`, `{operator}` placeholder support, `verifyCallbackSignature` accepting both `${code}.${raw}` and bare `raw` signed with the current or `config.previousWebhookSecret`, `ProviderProbeSchema`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/tests/providerContract.test.ts`:

```ts
test('launch url substitutes the operator code when the template asks for it', () => {
  const ctx = { token: 't', lang: 'en', currency: 'ETB', operator: 'op-a' };
  assert.equal(
    buildLaunchUrl('https://crash.example/play?token={token}&operator={operator}', ctx),
    'https://crash.example/play?token=t&operator=op-a',
  );
  assert.equal(
    buildLaunchUrl('https://crash.example/play?token={token}', ctx),
    'https://crash.example/play?token=t',
  );
});
```

In `apps/api/tests/phase1.test.ts`, replace the single-signature assertions with:

```ts
test('callback verification accepts the operator-scoped and the legacy signature', () => {
  const provider = { webhookSecret: 'secret-value', code: 'stratos', config: null };
  const body = Buffer.from('{"type":"balance"}');
  const legacy = createHmac('sha256', 'secret-value').update(body).digest('hex');
  const scoped = createHmac('sha256', 'secret-value')
    .update(Buffer.concat([Buffer.from('stratos.'), body]))
    .digest('hex');
  assert.equal(verifyCallbackSignature(provider, body, legacy), true);
  assert.equal(verifyCallbackSignature(provider, body, scoped), true);
  assert.equal(verifyCallbackSignature(provider, body, `sha256=${scoped}`), true);
  assert.equal(verifyCallbackSignature(provider, Buffer.from('{}'), scoped), false);
});

test('callback verification honors a previous secret during rotation', () => {
  const body = Buffer.from('{"type":"win"}');
  const oldScoped = createHmac('sha256', 'old-secret')
    .update(Buffer.concat([Buffer.from('stratos.'), body]))
    .digest('hex');
  const provider = {
    webhookSecret: 'new-secret',
    code: 'stratos',
    config: { previousWebhookSecret: 'old-secret' },
  };
  assert.equal(verifyCallbackSignature(provider, body, oldScoped), true);
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npm run api:test`
Expected: FAIL — `{operator}` is left unsubstituted and the scoped signature is rejected.

- [ ] **Step 3: Implement the launch placeholder**

In `providerContract.ts`: add `operator?: string` to `LaunchContext` and a replace line:

```ts
    .replaceAll('{operator}', encodeURIComponent(ctx.operator ?? ''))
```

In `gameProviders.ts` `launchGame`, pass `operator: game.provider.code` to `buildLaunchUrl`.

- [ ] **Step 4: Implement dual signature verification**

Replace `verifyCallbackSignature` in `providerCallback.ts`:

```ts
const SAFE_EQUAL = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

function signingSecrets(provider: Pick<GameProvider, 'webhookSecret' | 'config'>): string[] {
  if (!provider.webhookSecret) return [];
  const config = provider.config as { previousWebhookSecret?: unknown } | null;
  const previous =
    typeof config?.previousWebhookSecret === 'string' ? config.previousWebhookSecret : null;
  return previous ? [provider.webhookSecret, previous] : [provider.webhookSecret];
}

/**
 * Providers sign `${code}.${rawBody}`; V1 deployments signed the bare body.
 * Both remain valid, and rotation allows the previous secret in the overlap.
 */
export function verifyCallbackSignature(
  provider: Pick<GameProvider, 'webhookSecret' | 'code'> & Partial<Pick<GameProvider, 'config'>>,
  rawBody: Buffer | undefined,
  signature: string | undefined,
): boolean {
  if (!rawBody || !signature) return false;
  const given = signature.replace(/^sha256=/, '').toLowerCase();
  const scoped = Buffer.concat([Buffer.from(`${provider.code}.`, 'utf8'), rawBody]);
  return signingSecrets(provider).some((secret) => {
    const scopedExpected = createHmac('sha256', secret).update(scoped).digest('hex');
    const legacyExpected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return SAFE_EQUAL(scopedExpected, given) || SAFE_EQUAL(legacyExpected, given);
  });
}
```

Type note: `signingSecrets` needs `config`; keep the public parameter type permissive (`& Partial<Pick<GameProvider, 'config'>>`) so old unit tests that pass `{ webhookSecret, code }` keep compiling, and default `config` to `null` inside.

Add:

```ts
export const ProviderProbeSchema = z.object({
  type: z.literal('probe'),
  operator: z.string().max(64).optional(),
  timestamp: z.number().int().optional(),
});
```

- [ ] **Step 5: Run the API suite and typecheck**

Run: `npm run api:test && npm run typecheck -w @bingo/api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): operator launch placeholder and dual provider signature verification"
```

---

## Task A3: Provider operator registry, versioned secrets and domain-separated signing

**Files:**
- Modify: `apps/games-provider/src/server/wallet.ts`
- Create: `apps/games-provider/src/server/operatorRegistry.ts`
- Modify: `apps/games-provider/src/test/fakeBingo.ts`
- Test: `apps/games-provider/tests/wallet.test.ts`, new `apps/games-provider/tests/operatorRegistry.test.ts`

**Interfaces:**
- Consumes: `Store` operator/secret methods from A1.
- Produces: `OperatorError(status, code)`, `OperatorRegistry` with `get`, `walletFor`, `signOutbound`, `verifyInbound`, `verifyBalance`, `rotateSecret`, `listActiveSecrets`, and `OperatorWallets { walletFor(code): Promise<WalletClient> }`. `HttpWalletClient` gains an optional `operatorCode` config field.

- [ ] **Step 1: Write the failing registry tests**

Create `apps/games-provider/tests/operatorRegistry.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMemoryStore } from '../src/test/memoryStore';
import { OperatorError, OperatorRegistry } from '../src/server/operatorRegistry';
import type { OperatorRecord } from '../src/domain/types';

const operator = (code: string): OperatorRecord => ({
  code, name: `Operator ${code}`, callbackUrl: `https://${code}.example/cb`,
  currency: 'ETB', status: 'ACTIVE', allowedOrigins: [], localeDefault: 'en',
  limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
  enabledGames: ['crash'], theme: null, maintenance: false, probeOkAt: null,
  createdAt: new Date('2026-11-19T00:00:00Z'),
});

async function seeded() {
  const store = createMemoryStore();
  await store.upsertOperator(operator('op-a'));
  await store.addOperatorSecret('op-a', 'secret-one');
  return { store, registry: new OperatorRegistry({ store }) };
}

const prefixed = (secret: string, code: string, raw: string) =>
  createHmac('sha256', secret).update(`${code}.${raw}`).digest('hex');

test('outbound signing uses the operator domain and the newest active secret', async () => {
  const { registry } = await seeded();
  const rotated = await registry.rotateSecret('op-a');
  assert.deepEqual(
    [rotated.version, await registry.signOutbound('op-a', '{"type":"win"}')],
    [2, prefixed(rotated.secret, 'op-a', '{"type":"win"}')],
  );
});

test('inbound verification accepts both active secrets during the overlap only', async () => {
  const { registry, store } = await seeded();
  const rotated = await registry.rotateSecret('op-a');
  assert.equal(await registry.verifyInbound('op-a', Buffer.from('raw'), prefixed('secret-one', 'op-a', 'raw')), true);
  assert.equal(await registry.verifyInbound('op-a', Buffer.from('raw'), prefixed(rotated.secret, 'op-a', 'raw')), true);
  // Third rotation retires v1 (oldest active) and leaves v2+v3 active.
  await registry.rotateSecret('op-a');
  const active = (await store.listOperatorSecrets('op-a')).filter((s) => s.retiredAt === null);
  assert.deepEqual(active.map((s) => s.version).sort(), [2, 3]);
  assert.equal(await registry.verifyInbound('op-a', Buffer.from('raw'), prefixed('secret-one', 'op-a', 'raw')), false);
});

test('the V1 bare-body signature is still accepted', async () => {
  const { registry } = await seeded();
  const legacy = createHmac('sha256', 'secret-one').update('raw').digest('hex');
  assert.equal(await registry.verifyInbound('op-a', Buffer.from('raw'), legacy), true);
});

test('walletFor scopes the signature to the operator', async () => {
  const { registry } = await seeded();
  const sent: { url: string; signature: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), signature: String(init?.headers && (init.headers as Record<string, string>)['x-provider-signature']), body: String(init?.body) });
    return new Response(JSON.stringify({ data: { accepted: true, replayed: false, balance: '500' } }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const wallet = await registry.walletFor('op-a', fetchImpl);
  await wallet.win({ sessionToken: 's', txnId: 't', amount: 100n, roundId: '1' });
  const call = sent[0]!;
  assert.equal(call.url, 'https://op-a.example/cb');
  assert.equal(call.signature, prefixed('secret-one', 'op-a', call.body));
});

test('unknown operators, missing secrets and currency-free lookups are typed errors', async () => {
  const { store } = await seeded();
  const registry = new OperatorRegistry({ store });
  await assert.rejects(() => registry.get('missing'), (e: unknown) => e instanceof OperatorError && e.status === 404 && e.code === 'OPERATOR_NOT_FOUND');
  await store.upsertOperator(operator('op-b'));
  await assert.rejects(() => registry.walletFor('op-b'), (e: unknown) => e instanceof OperatorError && e.code === 'OPERATOR_SECRET_MISSING');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm run games:test -- operatorRegistry` — note: the script passes no file glob, so run `node --import tsx --test apps/games-provider/tests/operatorRegistry.test.ts` from the repo root.
Expected: FAIL — module does not exist.

- [ ] **Step 3: Add the operator domain to wallet signing**

In `wallet.ts`:

```ts
export function signBody(secret: string, rawBody: string, operatorCode = ''): string {
  const payload = operatorCode.length > 0 ? `${operatorCode}.${rawBody}` : rawBody;
  return createHmac('sha256', secret).update(payload).digest('hex');
}
```

and in `HttpWalletClient`:

```ts
interface WalletConfig {
  callbackUrl: string;
  hmacSecret: string;
  operatorCode?: string;
  timeoutMs?: number;
}
```

Use `signBody(this.cfg.hmacSecret, raw, this.cfg.operatorCode)` in `post`. Existing tests (no `operatorCode`) keep the legacy signature.

- [ ] **Step 4: Implement the registry**

Create `apps/games-provider/src/server/operatorRegistry.ts`:

```ts
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { OperatorRecord, OperatorSecretRecord } from '../domain/types';
import type { Store } from './store';
import { HttpWalletClient, signBody, verifyBalanceReply, WalletError, type BalanceReply, type WalletClient } from './wallet';

export class OperatorError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'OperatorError';
  }
}

export interface OperatorWallets {
  walletFor(operatorCode: string, fetchImpl?: typeof fetch): Promise<WalletClient>;
}

function sameHex(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class OperatorRegistry implements OperatorWallets {
  private readonly store: Store;

  constructor(deps: { store: Store }) {
    this.store = deps.store;
  }

  async get(code: string): Promise<OperatorRecord> {
    const operator = await this.store.getOperator(code);
    if (operator === null) {
      throw new OperatorError(404, 'OPERATOR_NOT_FOUND', `Unknown operator ${code}`);
    }
    return operator;
  }

  /** Active secrets, newest version first. */
  async listActiveSecrets(code: string): Promise<OperatorSecretRecord[]> {
    const secrets = (await this.store.listOperatorSecrets(code))
      .filter((row) => row.retiredAt === null)
      .sort((a, b) => b.version - a.version);
    if (secrets.length === 0) {
      throw new OperatorError(503, 'OPERATOR_SECRET_MISSING', `No active secret for ${code}`);
    }
    return secrets;
  }

  async signOutbound(code: string, rawBody: string): Promise<string> {
    const [current] = await this.listActiveSecrets(code);
    return signBody(current!.secret, rawBody, code);
  }

  async verifyInbound(code: string, rawBody: Buffer | string, signature: string | undefined): Promise<boolean> {
    if (!signature) return false;
    const raw = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const given = signature.replace(/^sha256=/, '').toLowerCase();
    for (const { secret } of await this.listActiveSecrets(code)) {
      if (sameHex(signBody(secret, raw, code), given)) return true;
      // V1 signed the bare body; keep accepting it while the old deployment drains.
      if (sameHex(signBody(secret, raw), given)) return true;
    }
    return false;
  }

  async verifyBalance(code: string, sessionToken: string, reply: BalanceReply, nowMs: number): Promise<void> {
    let lastError: unknown = null;
    for (const { secret } of await this.listActiveSecrets(code)) {
      try {
        verifyBalanceReply(secret, sessionToken, reply, nowMs);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new WalletError(502, 'BALANCE_SIGNATURE_INVALID', 'No signing secret could verify the balance reply');
  }

  async walletFor(code: string, fetchImpl?: typeof fetch): Promise<WalletClient> {
    const operator = await this.get(code);
    const [current] = await this.listActiveSecrets(code);
    return new HttpWalletClient(
      { callbackUrl: operator.callbackUrl, hmacSecret: current!.secret, operatorCode: operator.code },
      fetchImpl,
    );
  }

  /** Adds a secret, retiring the oldest active one when two are already live. */
  async rotateSecret(code: string): Promise<{ version: number; secret: string }> {
    await this.get(code);
    const active = (await this.store.listOperatorSecrets(code))
      .filter((row) => row.retiredAt === null)
      .sort((a, b) => a.version - b.version);
    if (active.length >= 2) await this.store.retireOperatorSecret(code, active[0]!.version);
    const secret = randomBytes(32).toString('hex');
    const row = await this.store.addOperatorSecret(code, secret);
    return { version: row.version, secret: row.secret };
  }
}
```

- [ ] **Step 5: Teach fake bingo the operator domain**

In `src/test/fakeBingo.ts`, add `operatorCode?: string` to `FakeBingoOptions` and update `signatureValid`:

```ts
function signatureValid(
  secret: string,
  raw: Buffer,
  header: string | string[] | undefined,
  operatorCode: string | undefined,
): boolean {
  if (typeof header !== 'string' || header.length === 0) return false;
  const given = header.replace(/^sha256=/, '').toLowerCase();
  const bare = Buffer.from(hmacHex(secret, raw), 'utf8');
  const scoped = Buffer.from(
    hmacHex(secret, Buffer.concat([Buffer.from(`${operatorCode}.`, 'utf8'), raw])),
    'utf8',
  );
  const match = (buf: Buffer) => buf.length === given.length && timingSafeEqual(buf, Buffer.from(given, 'utf8'));
  return operatorCode !== undefined
    ? match(scoped) || match(bare)
    : match(bare);
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run games:test && npm run games:typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/games-provider
git commit -m "feat(games-provider): operator registry with versioned secrets and scoped signing"
```

---

## Task A4: Operator-scoped handshake, HTTP surface and client wiring

**Files:**
- Modify: `apps/games-provider/src/server/handshake.ts`
- Modify: `apps/games-provider/src/server/http.ts`
- Modify: `apps/games-provider/src/server/socket.ts`
- Modify: `apps/games-provider/src/test/server.ts`
- Modify: `apps/games-provider/src/client/App.tsx`
- Modify: `apps/games-provider/server.ts`
- Test: new `apps/games-provider/tests/handshake.test.ts`; update `tests/http.test.ts`, `tests/socket.test.ts`, `tests/health.test.ts`

**Interfaces:**
- Consumes: `OperatorRegistry`, `OperatorError` (A3), operator store (A1).
- Produces: `handshake({ token, operatorCode?, gameId?, config, store, registry, now? })`, `createApp({ config, store, registry })`, socket `auth`/actions rejecting sessions of non-active operators, HTTP handshake accepting `{ token, operator?, game? }`.

- [ ] **Step 1: Write the failing handshake tests**

Create `apps/games-provider/tests/handshake.test.ts` with two seeded operators and two fake bingos:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBingo } from '../src/test/fakeBingo';
import { createMemoryStore } from '../src/test/memoryStore';
import { OperatorError, OperatorRegistry } from '../src/server/operatorRegistry';
import { handshake, SessionEndedError } from '../src/server/handshake';
import { loadConfig } from '../src/config';
import type { OperatorRecord } from '../src/domain/types';

const SECRET_A = 'test-secret-operator-a';
const SECRET_B = 'test-secret-operator-b';

function operator(code: string, callbackUrl: string, patch: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    code, name: code, callbackUrl, currency: 'ETB', status: 'ACTIVE', allowedOrigins: [],
    localeDefault: 'en', limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
    enabledGames: ['crash'], theme: null, maintenance: false, probeOkAt: null,
    createdAt: new Date('2026-11-19T00:00:00Z'), ...patch,
  };
}

async function setup() {
  const a = await createFakeBingo({ hmacSecret: SECRET_A, balance: 50_000n, currency: 'ETB', operatorCode: 'op-a' });
  const b = await createFakeBingo({ hmacSecret: SECRET_B, balance: 20_000n, currency: 'ETB', operatorCode: 'op-b' });
  const store = createMemoryStore();
  await store.upsertOperator(operator('op-a', `${a.url}/api/games/callback/op-a`));
  await store.upsertOperator(operator('op-b', `${b.url}/api/games/callback/op-b`));
  await store.addOperatorSecret('op-a', SECRET_A);
  await store.addOperatorSecret('op-b', SECRET_B);
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CODE: 'op-a',
    OPERATOR_CALLBACK_URL: `${a.url}/api/games/callback/op-a`,
    OPERATOR_HMAC_SECRET: SECRET_A,
  });
  return { a, b, store, registry: new OperatorRegistry({ store }), config };
}

test('handshake resolves the operator from the frame and stores the game', async (t) => {
  const { a, b, store, registry, config } = await setup();
  t.after(async () => { await a.close(); await b.close(); });
  const session = await handshake({ token: a.token, operatorCode: 'op-b', gameId: 'crash', config, store, registry });
  assert.equal(session.operatorCode, 'op-b');
  assert.equal(session.gameId, 'crash');
  assert.equal(session.displayBalance, 20_000n);
});

test('a token bound to one operator cannot be replayed under another', async (t) => {
  const { a, b, store, registry, config } = await setup();
  t.after(async () => { await a.close(); await b.close(); });
  await handshake({ token: a.token, operatorCode: 'op-a', config, store, registry });
  await assert.rejects(
    () => handshake({ token: a.token, operatorCode: 'op-b', config, store, registry }),
    (error: unknown) => error instanceof OperatorError && error.status === 403 && error.code === 'OPERATOR_MISMATCH',
  );
  assert.equal(b.state().calls.length, 0, 'operator B wallet must not be touched');
});

test('inactive, maintenance and disabled-game operators are rejected before the wallet call', async (t) => {
  const { a, b, store, registry, config } = await setup();
  t.after(async () => { await a.close(); await b.close(); });
  await store.upsertOperator(operator('op-a', `${a.url}/api/games/callback/op-a`, { status: 'SUSPENDED' }));
  await assert.rejects(() => handshake({ token: a.token, operatorCode: 'op-a', config, store, registry }),
    (e: unknown) => e instanceof OperatorError && e.code === 'OPERATOR_INACTIVE');
  await store.upsertOperator(operator('op-a', `${a.url}/api/games/callback/op-a`, { maintenance: true }));
  await assert.rejects(() => handshake({ token: a.token, operatorCode: 'op-a', config, store, registry }),
    (e: unknown) => e instanceof OperatorError && e.code === 'OPERATOR_MAINTENANCE');
  await store.upsertOperator(operator('op-a', `${a.url}/api/games/callback/op-a`, { enabledGames: ['coinflip'] }));
  await assert.rejects(() => handshake({ token: a.token, operatorCode: 'op-a', gameId: 'crash', config, store, registry }),
    (e: unknown) => e instanceof OperatorError && e.code === 'GAME_UNAVAILABLE');
  assert.equal(a.state().calls.length, 0);
});

test('effective limits intersect the signed reply with the operator record', async (t) => {
  const { a, b, store, registry, config } = await setup();
  t.after(async () => { await a.close(); await b.close(); });
  a.setLimits({ minStake: 50n, maxStake: 200_000n, maxWin: 5_000_000n });
  const session = await handshake({ token: a.token, operatorCode: 'op-a', config, store, registry });
  assert.deepEqual(
    [session.minStake, session.maxStake, session.maxWin],
    [100n, 100_000n, 3_000_000n],
  );
});

test('an empty limit intersection is a typed conflict', async (t) => {
  const { a, b, store, registry, config } = await setup();
  t.after(async () => { await a.close(); await b.close(); });
  a.setLimits({ minStake: 500_000n });
  await assert.rejects(
    () => handshake({ token: a.token, operatorCode: 'op-a', config, store, registry }),
    (error: unknown) => error instanceof OperatorError && error.status === 409 && error.code === 'LIMITS_CONFLICT',
  );
});

test('a closed session still answers SessionEndedError', async (t) => {
  const { a, b, store, registry, config } = await setup();
  t.after(async () => { await a.close(); await b.close(); });
  await handshake({ token: a.token, operatorCode: 'op-a', config, store, registry });
  await store.closeSession(a.token);
  await assert.rejects(
    () => handshake({ token: a.token, operatorCode: 'op-a', config, store, registry }),
    (error: unknown) => error instanceof SessionEndedError,
  );
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --import tsx --test apps/games-provider/tests/handshake.test.ts`
Expected: FAIL — handshake has no operator argument.

- [ ] **Step 3: Implement the scoped handshake**

Replace `handshake` in `src/server/handshake.ts`:

```ts
export interface HandshakeDeps {
  token: string;
  operatorCode?: string;
  gameId?: string;
  config: AppConfig;
  store: Store;
  registry: OperatorRegistry;
  now?: Date;
}

export async function handshake(input: HandshakeDeps): Promise<SessionRecord> {
  const now = input.now ?? new Date();
  const operatorCode = input.operatorCode ?? input.config.defaultOperatorCode;
  const operator = await input.registry.get(operatorCode);
  if (operator.status !== 'ACTIVE') {
    throw new OperatorError(403, 'OPERATOR_INACTIVE', `Operator ${operatorCode} is not active`);
  }
  if (operator.maintenance) {
    throw new OperatorError(503, 'OPERATOR_MAINTENANCE', `Operator ${operatorCode} is in maintenance`);
  }
  const gameId = input.gameId ?? 'crash';
  if (!operator.enabledGames.includes(gameId)) {
    throw new OperatorError(403, 'GAME_UNAVAILABLE', `Game ${gameId} is not enabled for ${operatorCode}`);
  }

  const existing = await input.store.getSession(input.token);
  if (existing !== null && existing.operatorCode !== operatorCode) {
    throw new OperatorError(403, 'OPERATOR_MISMATCH', 'Session belongs to another operator');
  }
  if (existing !== null && existing.status === 'CLOSED') throw new SessionEndedError();

  const wallet = await input.registry.walletFor(operatorCode);
  const nonce = randomUUID();
  let reply;
  try {
    reply = await wallet.balance(input.token, nonce);
  } catch (error) {
    if (error instanceof WalletError && error.status !== null && error.status >= 400 && error.status < 500) {
      throw new SessionEndedError();
    }
    throw error;
  }
  await input.registry.verifyBalance(operatorCode, input.token, reply, now.getTime());
  if (reply.currency !== operator.currency) {
    throw new WalletError(
      502, 'CURRENCY_MISMATCH',
      `Bingo settles ${reply.currency}, expected ${operator.currency}`,
    );
  }

  const minStake = maxBigInt(reply.minStake ?? operator.limits.minStake, operator.limits.minStake);
  const maxStake = minBigInt(reply.maxStake ?? operator.limits.maxStake, operator.limits.maxStake);
  const maxWin = minBigInt(reply.maxWin ?? operator.limits.maxWin, operator.limits.maxWin);
  if (minStake > maxStake) {
    throw new OperatorError(409, 'LIMITS_CONFLICT', 'Wallet and operator stake limits do not overlap');
  }

  const session: SessionRecord = {
    token: input.token,
    operatorCode,
    gameId,
    currency: reply.currency,
    minStake,
    maxStake,
    maxWin,
    maxBetsPerRound: operator.limits.maxBetsPerRound,
    displayBalance: reply.balance,
    status: 'OPEN',
    createdAt: existing?.createdAt ?? now,
    lastHandshakeAt: now,
  };
  await input.store.saveSession(session);
  return session;
}

const maxBigInt = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const minBigInt = (a: bigint, b: bigint): bigint => (a < b ? a : b);
```

Remove the old `config.operator.hmacSecret` verification.

- [ ] **Step 4: Update the HTTP app**

In `src/server/http.ts`:
- `AppDeps` becomes `{ config; store; registry }`.
- `SessionBody` becomes:

```ts
const SessionBody = z.object({
  token: z.string().uuid(),
  operator: z.string().min(1).max(64).optional(),
  game: z.string().min(1).max(32).optional(),
});
```

- The handshake route passes `operatorCode: body.operator, gameId: body.game` and includes `operator` in the response data.
- Error mapping, in order: `SessionEndedError` → 410 `SESSION_CLOSED`; `OperatorError` → `error.status` with `error.code`; `WalletError` → 502 `WALLET_UNAVAILABLE`; else `next`.
- Add an async body to the bootstrap handshake JSON:

```ts
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
```

- [ ] **Step 5: Gate sockets on operator status**

`attachSocket` takes `registry: OperatorRegistry` (required). In the `auth` branch, after loading an OPEN session:

```ts
const operator = await registry.get(session.operatorCode);
if (operator.status !== 'ACTIVE' || operator.maintenance) {
  send(ws, { type: 'session:ended', reason: 'OPERATOR_INACTIVE' });
  ws.close(4001, 'operator inactive');
  return;
}
```

- [ ] **Step 6: Update test server, health/http/socket tests, client and boot**

- `src/test/server.ts`: `startTestServer` input gains `registry`; pass it to `createApp` and `attachSocket`.
- `tests/health.test.ts`, `tests/http.test.ts`: build a registry from a memory store seeded with the fake bingo's operator (`code: config.operator.code`, `callbackUrl: fake.url + '/api/games/callback/' + code`) and its secret; pass it to `createApp`/`startTestServer`. Fake bingo is created with `operatorCode` matching.
- `tests/http.test.ts`: add a case posting `{ token, operator: 'missing' }` expecting 404 `OPERATOR_NOT_FOUND`, and assert the successful handshake body contains `operator`.
- `tests/socket.test.ts`: pass the registry through `startTestServer`.
- `src/client/App.tsx` boot effect:

```ts
  const params = new URLSearchParams(window.location.search);
  const token = useRef(params.get('token')).current;
  const operator = useRef(params.get('operator') ?? undefined).current;
  const game = useRef(params.get('game') ?? undefined).current;
  ...
        body: JSON.stringify({ token, ...(operator ? { operator } : {}), ...(game ? { game } : {}) }),
```

- `server.ts`: build `const registry = new OperatorRegistry({ store });`, pass to `createApp({ config, store, registry })` and `attachSocket({ server, store, engine, registry })`.

- [ ] **Step 7: Run tests and typecheck**

Run: `npm run games:test && npm run games:typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/games-provider
git commit -m "feat(games-provider): operator-scoped handshake, socket gate and client wiring"
```

---

## Task A5: Per-operator settlement routing and isolation proof

**Files:**
- Modify: `apps/games-provider/src/server/betManager.ts`
- Modify: `apps/games-provider/src/server/outbox.ts`
- Modify: `apps/games-provider/src/server/recovery.ts`
- Modify: `apps/games-provider/src/test/server.ts`
- Modify: `apps/games-provider/server.ts`
- Test: new `apps/games-provider/tests/isolation.test.ts`; update `tests/betManager.test.ts`, `tests/outbox.test.ts`, `tests/recovery.test.ts`

**Interfaces:**
- Consumes: `OperatorWallets` (A3), `SessionRecord.maxBetsPerRound` (A1).
- Produces: `BetManager({ store, wallets, now?, newId?, onSettled? })`, `OutboxWorker({ store, wallets, onDelivered? })`, `runRecovery({ store, wallets, now? })`.

- [ ] **Step 1: Write the failing isolation test**

Create `apps/games-provider/tests/isolation.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBingo } from '../src/test/fakeBingo';
import { createMemoryStore } from '../src/test/memoryStore';
import { OperatorRegistry } from '../src/server/operatorRegistry';
import { loadConfig } from '../src/config';
import { startTestServer } from '../src/test/server';
import { handshake } from '../src/server/handshake';

const SECRET_A = 'test-secret-operator-a';
const SECRET_B = 'test-secret-operator-b';

test('two operators settle against their own wallets only', async (t) => {
  const fakeA = await createFakeBingo({ hmacSecret: SECRET_A, balance: 50_000n, operatorCode: 'op-a' });
  const fakeB = await createFakeBingo({ hmacSecret: SECRET_B, balance: 50_000n, operatorCode: 'op-b' });
  const store = createMemoryStore();
  const base = {
    currency: 'ETB', status: 'ACTIVE' as const, allowedOrigins: [], localeDefault: 'en' as const,
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 4 },
    enabledGames: ['crash'], theme: null, maintenance: false, probeOkAt: null,
    createdAt: new Date('2026-11-19T00:00:00Z'),
  };
  await store.upsertOperator({ ...base, code: 'op-a', name: 'A', callbackUrl: `${fakeA.url}/api/games/callback/op-a` });
  await store.upsertOperator({ ...base, code: 'op-b', name: 'B', callbackUrl: `${fakeB.url}/api/games/callback/op-b` });
  await store.addOperatorSecret('op-a', SECRET_A);
  await store.addOperatorSecret('op-b', SECRET_B);
  const registry = new OperatorRegistry({ store });
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CODE: 'op-a',
    OPERATOR_CALLBACK_URL: `${fakeA.url}/api/games/callback/op-a`,
    OPERATOR_HMAC_SECRET: SECRET_A,
  });
  const server = await startTestServer({ config, store, registry });
  t.after(async () => { await server.close(); await fakeA.close(); await fakeB.close(); });

  const sessionA = await handshake({ token: fakeA.token, operatorCode: 'op-a', config, store, registry });
  const sessionB = await handshake({ token: fakeA.token, operatorCode: 'op-b', config, store, registry });

  await server.engine.tickOnce(1); // opens round 1
  await server.engine.placeBet({ session: sessionA, panel: 0, stake: 1_000n });
  await server.engine.placeBet({ session: sessionB, panel: 0, stake: 2_000n });
  // Both bets are on round 1 and carry their own operator.
  const roundId = server.engine.snapshot().roundId!;
  const bets = await store.listBetsForRound(roundId);
  assert.deepEqual(bets.map((bet) => bet.operatorCode).sort(), ['op-a', 'op-b']);
  assert.equal(await store.countBetsForRoundByOperator(roundId, 'op-a'), 1);
});
```

The fake bingo only knows `FAKE_BINGO_TOKEN`, so both sessions use the same token value but are bound to different operator codes in the provider — that is the point: isolation is enforced by the session binding and the wallet routing, not by token uniqueness. `placeBet` for `op-b` calls fake B, which accepts the same token.

- [ ] **Step 2: Run to confirm failure**

Run: `node --import tsx --test apps/games-provider/tests/isolation.test.ts`
Expected: FAIL — `startTestServer` takes a single wallet and `BetManager` has no `wallets`.

- [ ] **Step 3: Route BetManager through the wallets directory**

- `BetManagerDeps` drops `limits` and takes `wallets: OperatorWallets`.
- In `place`: `const wallet = await this.wallets.walletFor(session.operatorCode);` before the charge; replace the round-wide limit with:

```ts
    if ((await this.store.countBetsForRoundByOperator(round.id, session.operatorCode)) >= session.maxBetsPerRound) {
      throw new BetRuleError('ROUND_BET_LIMIT', 'Round bet limit reached');
    }
```

- In `settleRound`, the `maxWin` parameter is ignored as before (`session.maxWin` is authoritative).

- [ ] **Step 4: Route the outbox and recovery**

- `OutboxWorkerDeps`: `wallets: OperatorWallets`; `deliver` resolves `const wallet = await this.wallets.walletFor(row.operatorCode);` and uses it for win/rollback.
- `RecoveryDeps`: `wallets: OperatorWallets`. `resolveIndeterminate` takes the directory and resolves by `bet.operatorCode`; wrap the lookup so a missing operator leaves the bet `UNRESOLVED`:

```ts
    let wallet: WalletClient;
    try {
      wallet = await wallets.walletFor(bet.operatorCode);
    } catch (error) {
      if (error instanceof OperatorError) return false;
      throw error;
    }
```

- `startTestServer`: `{ config, store, registry }`; build the bet manager and engine with `registry` as `wallets`.
- `server.ts`: pass `registry` as `wallets` to the outbox, recovery and bet manager; remove the single `HttpWalletClient` construction.

- [ ] **Step 5: Update the constructor call sites in existing tests**

Mechanical replacements:
- `wallet: fakeWallet` → `wallets: { walletFor: async () => fakeWallet }` in `betManager.test.ts`, `outbox.test.ts`, `recovery.test.ts`.
- Session factories gain `gameId: 'crash'` and `maxBetsPerRound: 4`.
- Limit assertions in `betManager.test.ts` now come from the session (`maxBetsPerRound`), not constructor limits.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run games:test && npm run games:typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/games-provider
git commit -m "feat(games-provider): per-operator wallet routing for bets, outbox and recovery"
```

---

## Task A6: Per-operator catalogue and play-page CSP

**Files:**
- Modify: `apps/games-provider/src/server/http.ts`
- Test: `apps/games-provider/tests/http.test.ts`

**Interfaces:**
- Produces: `GET /api/catalogue?operator=<code>` → `{ data: { operator: { code, name }, currency, localeDefault, games, limits, theme } }`; `/play` CSP uses the requested operator's `allowedOrigins` (falling back to env origins).

- [ ] **Step 1: Write the failing tests**

Append to `apps/games-provider/tests/http.test.ts`:

```ts
test('catalogue exposes only the requested operator', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 1_000n, operatorCode: 'stratos' });
  const { server, base, store } = await boot(fake);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  });
  await store.upsertOperator({
    code: 'other', name: 'Other', callbackUrl: 'https://other.example/cb', currency: 'ETB',
    status: 'SUSPENDED', allowedOrigins: ['https://other.example'], localeDefault: 'am',
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
    enabledGames: ['crash'], theme: null, maintenance: false, probeOkAt: null,
    createdAt: new Date('2026-11-19T00:00:00Z'),
  });
  const response = await fetch(`${base}/api/catalogue?operator=other`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.operator.code, 'other');
  assert.equal(body.data.localeDefault, 'am');
  assert.equal(body.data.limits.minStake, '100');
  const missing = await fetch(`${base}/api/catalogue?operator=nope`);
  assert.equal(missing.status, 404);
});

test('the play page uses the requested operator origins', async (t) => {
  const fake = await createFakeBingo({ hmacSecret: 'test-hmac-secret-value', balance: 1_000n, operatorCode: 'stratos' });
  const { server, base, store } = await boot(fake);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
  });
  await store.upsertOperator({
    code: 'tenant', name: 'Tenant', callbackUrl: 'https://tenant.example/cb', currency: 'ETB',
    status: 'ACTIVE', allowedOrigins: ['https://tenant.example'], localeDefault: 'en',
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
    enabledGames: ['crash'], theme: null, maintenance: false, probeOkAt: null,
    createdAt: new Date('2026-11-19T00:00:00Z'),
  });
  const response = await fetch(`${base}/play?operator=tenant`);
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'self' https:\/\/tenant\.example/);
  assert.doesNotMatch(response.headers.get('content-security-policy') ?? '', /other/);
});
```

The `boot` helper in this file is updated by A4 to take the registry; when calling `store.upsertOperator`, it already seeded the bootstrap code from `config.operator.code`.

- [ ] **Step 2: Run to confirm failure**

Run: `node --import tsx --test apps/games-provider/tests/http.test.ts`
Expected: FAIL — `/api/catalogue` is 404 and `/play` ignores the query.

- [ ] **Step 3: Implement the catalogue route and CSP**

In `createApp`, before `/play`:

```ts
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
```

Before `app.use('/play', express.static(clientDir))`:

```ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run games:test && npm run games:typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/games-provider
git commit -m "feat(games-provider): per-operator catalogue and play-page origin policy"
```

---

## Task G1: Bingo probe endpoint

**Files:**
- Modify: `apps/api/src/lib/providerCallback.ts` (probe schema — already added in A2; verify it exists)
- Modify: `apps/api/src/services/gameProviders.ts` (probe handler)
- Modify: `apps/api/src/routes/games.ts`
- Test: `apps/api/tests/providerContract.test.ts`

**Interfaces:**
- Produces: `handleProviderProbe({ providerCode, rawBody, signature, body, ip })` returning `{ status: 200, data: { ok: true, operator } }`; route `POST /api/games/callback/:providerCode/probe`.

- [ ] **Step 1: Write the failing unit tests**

Append to `apps/api/tests/providerContract.test.ts`:

```ts
test('probe payloads are validated strictly', () => {
  assert.equal(ProviderProbeSchema.safeParse({ type: 'probe' }).success, true);
  assert.equal(ProviderProbeSchema.safeParse({ type: 'probe', timestamp: 1 }).success, true);
  assert.equal(ProviderProbeSchema.safeParse({ type: 'win' }).success, false);
  assert.equal(ProviderProbeSchema.safeParse({ type: 'probe', timestamp: 'now' }).success, false);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm run api:test`
Expected: FAIL if the schema is missing / import fails.

- [ ] **Step 3: Implement the handler and route**

In `gameProviders.ts`:

```ts
export async function handleProviderProbe(input: {
  providerCode: string;
  rawBody?: Buffer;
  signature?: string;
  body: unknown;
  ip?: string | null;
}): Promise<{ status: number; data: Record<string, unknown> }> {
  const provider = await prisma.gameProvider.findUnique({ where: { code: input.providerCode } });
  if (!provider) throw Errors.notFound('Provider');
  const signatureValid = verifyCallbackSignature(provider, input.rawBody, input.signature);
  await writeCallbackLog({
    providerCode: provider.code,
    type: null,
    externalTxnId: null,
    externalSessionId: null,
    signatureValid,
    amount: null,
    currency: null,
    payload: (input.body ?? {}) as Prisma.InputJsonValue,
    ip: input.ip ?? null,
  }, signatureValid ? 200 : 403, signatureValid ? undefined : 'SIGNATURE_INVALID');
  if (!signatureValid) throw Errors.forbidden('Invalid provider signature', 'SIGNATURE_INVALID');
  const parsed = ProviderProbeSchema.safeParse(input.body ?? {});
  if (!parsed.success) throw Errors.badRequest('Probe payload is invalid', 'PROBE_MALFORMED');
  return { status: 200, data: { ok: true, operator: provider.code } };
}
```

In `routes/games.ts`, register before the generic callback route:

```ts
gamesRouter.post(
  '/callback/:providerCode/probe',
  asyncHandler(async (req, res) => {
    const result = await handleProviderProbe({
      providerCode: req.params.providerCode,
      rawBody: req.rawBody,
      signature: req.header('x-provider-signature'),
      body: req.body,
      ip: req.ip,
    });
    res.status(result.status).json({ data: result.data });
  }),
);
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run api:test && npm run typecheck -w @bingo/api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): signed provider probe endpoint for onboarding"
```

---

## Task G2: Provider admin API and probe service

**Files:**
- Create: `apps/games-provider/src/server/operatorAdmin.ts`
- Create: `apps/games-provider/src/server/adminHttp.ts`
- Modify: `apps/games-provider/src/server/http.ts`
- Modify: `apps/games-provider/src/test/fakeBingo.ts` (probe support)
- Modify: `apps/games-provider/server.ts`
- Test: new `apps/games-provider/tests/adminOperators.test.ts`

**Interfaces:**
- Produces: `adminRouter({ store, registry, adminToken })` mounted at `/api/admin`; `createOperator`, `updateOperator`, `setOperatorStatus`, `runProbe`.

- [ ] **Step 1: Write the failing admin tests**

Create `apps/games-provider/tests/adminOperators.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMemoryStore } from '../src/test/memoryStore';
import { OperatorRegistry } from '../src/server/operatorRegistry';
import { createApp } from '../src/server/http';
import { loadConfig } from '../src/config';
import { createFakeBingo } from '../src/test/fakeBingo';

async function boot(adminToken: string | null) {
  const store = createMemoryStore();
  const registry = new OperatorRegistry({ store });
  const config = loadConfig({
    DATABASE_URL: 'postgres://x',
    OPERATOR_CALLBACK_URL: 'https://seed.example/cb',
    OPERATOR_HMAC_SECRET: 'seed-secret-for-tests',
    ...(adminToken ? { PROVIDER_ADMIN_TOKEN: adminToken } : {}),
  });
  const server = createServer(createApp({ config, store, registry })).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, registry, config, base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const headers = (token = 'admin-token-for-tests') => ({ 'content-type': 'application/json', 'x-provider-admin-token': token });

test('admin routes are disabled without a token and reject a wrong one', async () => {
  const disabled = await boot(null);
  assert.equal((await fetch(`${disabled.base}/api/admin/operators`, { headers: headers() })).status, 503);
  await disabled.close();

  const enabled = await boot('admin-token-for-tests');
  assert.equal((await fetch(`${enabled.base}/api/admin/operators`, { headers: headers('wrong-token-value') })).status, 401);
  await enabled.close();
});

test('creating an operator returns its first secret once and starts PENDING', async () => {
  const ctx = await boot('admin-token-for-tests');
  const response = await fetch(`${ctx.base}/api/admin/operators`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      code: 'new-op', name: 'New Operator', callbackUrl: 'https://new.example/api/games/callback/new-op',
      allowedOrigins: ['https://new.example'],
      limits: { minStake: '100', maxStake: '50000', maxWin: '1000000', maxBetsPerRound: 50 },
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.operator.status, 'PENDING');
  assert.match(body.data.secret, /^[0-9a-f]{64}$/);
  const list = await (await fetch(`${ctx.base}/api/admin/operators`, { headers: headers() })).json();
  assert.equal(list.data[0].hasSecret, true);
  assert.equal('secret' in list.data[0], false);
  await ctx.close();
});

test('activation requires a successful probe', async () => {
  const fake = await createFakeBingo({ hmacSecret: 'probe-secret', balance: 0n });
  const ctx = await boot('admin-token-for-tests');
  await fetch(`${ctx.base}/api/admin/operators`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({
      code: 'probe-op', name: 'Probe', callbackUrl: `${fake.url}/api/games/callback/probe-op`,
      allowedOrigins: ['https://probe.example'],
      limits: { minStake: '100', maxStake: '100000', maxWin: '3000000', maxBetsPerRound: 200 },
    }),
  });
  const denied = await fetch(`${ctx.base}/api/admin/operators/probe-op/status`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ status: 'ACTIVE' }),
  });
  assert.equal(denied.status, 409);

  const probe = await fetch(`${ctx.base}/api/admin/operators/probe-op/probe`, { method: 'POST', headers: headers() });
  assert.equal(probe.status, 200);

  const activated = await fetch(`${ctx.base}/api/admin/operators/probe-op/status`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ status: 'ACTIVE' }),
  });
  assert.equal(activated.status, 200);
  await ctx.close();
  await fake.close();
});
```

`fakeBingo` probe support: in `handler`, before the body-type gate, accept `{ type: 'probe' }`:

```ts
if (isRecord(body) && body.type === 'probe') {
  record({ type: 'probe', status: 200, signatureValid: signed, txnId: null, replayed: false });
  sendData(res, 200, { ok: true });
  return;
}
```

The fake is created with `operatorCode` when the operator code is known at setup; in this test the probe is signed with the operator code, so either extend the fake's `operatorCode` at creation to `'probe-op'` (pass `operatorCode: 'probe-op'`) or create fake bingo with that option. Use `createFakeBingo({ hmacSecret: 'probe-secret', balance: 0n, operatorCode: 'probe-op' })`.

But the created operator's secret is generated by the admin API, not `probe-secret`. To make the fake verify it, seed the operator manually in a variant of this test: use `ctx.store` + `ctx.registry` to `upsertOperator` with callback `${fake.url}/api/games/callback/probe-op`, `addOperatorSecret('probe-op', 'probe-secret')`, and skip the POST create. Rewrite the test accordingly:

```ts
test('activation requires a successful probe', async () => {
  const fake = await createFakeBingo({ hmacSecret: 'probe-secret', balance: 0n, operatorCode: 'probe-op' });
  const ctx = await boot('admin-token-for-tests');
  await ctx.store.upsertOperator({
    code: 'probe-op', name: 'Probe', callbackUrl: `${fake.url}/api/games/callback/probe-op`, currency: 'ETB',
    status: 'PENDING', allowedOrigins: ['https://probe.example'], localeDefault: 'en',
    limits: { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 },
    enabledGames: ['crash'], theme: null, maintenance: false, probeOkAt: null,
    createdAt: new Date('2026-11-19T00:00:00Z'),
  });
  await ctx.store.addOperatorSecret('probe-op', 'probe-secret');
  ...
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --import tsx --test apps/games-provider/tests/adminOperators.test.ts`
Expected: FAIL — no `/api/admin` router.

- [ ] **Step 3: Implement the admin service**

Create `src/server/operatorAdmin.ts`. Key functions:

```ts
const CODE_RE = /^[a-z0-9_-]{2,32}$/;

export interface NewOperatorInput {
  code: string;
  name: string;
  callbackUrl: string;
  allowedOrigins: string[];
  currency?: string;
  localeDefault?: 'en' | 'am';
  limits?: { minStake: bigint; maxStake: bigint; maxWin: bigint; maxBetsPerRound: number };
  enabledGames?: string[];
  theme?: Record<string, unknown> | null;
}

export async function createOperator(store: Store, registry: OperatorRegistry, input: NewOperatorInput) {
  const code = input.code.trim();
  if (!CODE_RE.test(code)) throw new OperatorError(400, 'OPERATOR_CODE_INVALID', 'Operator code must be 2-32 lowercase letters, digits, - or _');
  if (await store.getOperator(code)) throw new OperatorError(409, 'OPERATOR_EXISTS', `Operator ${code} already exists`);
  const url = parseAbsoluteUrl(input.callbackUrl, 'CALLBACK_URL_INVALID');
  const origins = input.allowedOrigins.map((origin) => parseAbsoluteUrl(origin, 'ORIGIN_INVALID'));
  const limits = input.limits ?? { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n, maxBetsPerRound: 200 };
  if (limits.minStake > limits.maxStake) throw new OperatorError(400, 'LIMITS_INVALID', 'minStake exceeds maxStake');
  const operator: OperatorRecord = {
    code, name: input.name.trim(), callbackUrl: url, currency: (input.currency ?? 'ETB').toUpperCase(),
    status: 'PENDING', allowedOrigins: origins, localeDefault: input.localeDefault ?? 'en',
    limits, enabledGames: input.enabledGames ?? ['crash'], theme: input.theme ?? null,
    maintenance: false, probeOkAt: null, createdAt: new Date(),
  };
  await store.upsertOperator(operator);
  const rotated = await registry.rotateSecret(code);
  return { operator, secret: rotated.secret, secretVersion: rotated.version };
}

export async function setOperatorStatus(store: Store, code: string, status: OperatorStatus) {
  const operator = await store.getOperator(code);
  if (operator === null) throw new OperatorError(404, 'OPERATOR_NOT_FOUND', `Unknown operator ${code}`);
  if (status === 'ACTIVE') {
    if (operator.probeOkAt === null) throw new OperatorError(409, 'PROBE_REQUIRED', 'Run a successful probe first');
    const active = (await store.listOperatorSecrets(code)).filter((row) => row.retiredAt === null);
    if (active.length === 0) throw new OperatorError(409, 'SECRET_REQUIRED', 'Operator has no active secret');
  }
  const next = { ...operator, status };
  await store.upsertOperator(next);
  return next;
}

export async function runProbe(store: Store, registry: OperatorRegistry, code: string, fetchImpl: typeof fetch = fetch) {
  const operator = await store.getOperator(code);
  if (operator === null) throw new OperatorError(404, 'OPERATOR_NOT_FOUND', `Unknown operator ${code}`);
  const raw = JSON.stringify({ type: 'probe', operator: code, timestamp: Math.floor(Date.now() / 1000) });
  const signature = await registry.signOutbound(code, raw);
  const url = new URL(operator.callbackUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/probe`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-provider-signature': signature },
      body: raw,
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new OperatorError(502, 'PROBE_FAILED', `Probe request failed: ${(error as Error).message}`);
  }
  if (!response.ok) throw new OperatorError(502, 'PROBE_FAILED', `Probe answered ${response.status}`);
  const checkedAt = new Date();
  await store.upsertOperator({ ...operator, probeOkAt: checkedAt });
  return { ok: true as const, checkedAt };
}

function parseAbsoluteUrl(value: string, code: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new OperatorError(400, code, `${value} is not an absolute URL`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new OperatorError(400, code, 'Only http(s) URLs are allowed');
  return parsed.toString();
}
```

`updateOperator` is a guarded read-modify-write that only accepts `name`, `callbackUrl`, `allowedOrigins`, `localeDefault`, `limits`, `enabledGames`, `theme`, `maintenance`; re-validate URLs and limits.

- [ ] **Step 4: Implement the admin router**

Create `src/server/adminHttp.ts` with zod validation and timing-safe auth:

```ts
export function adminRouter(deps: { store: Store; registry: OperatorRegistry; adminToken: string | null }): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (deps.adminToken === null) {
      res.status(503).json({ error: { code: 'ADMIN_DISABLED' } });
      return;
    }
    const given = Buffer.from(req.header('x-provider-admin-token') ?? '', 'utf8');
    const expected = Buffer.from(deps.adminToken, 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.status(401).json({ error: { code: 'ADMIN_UNAUTHORIZED' } });
      return;
    }
    next();
  });
  // GET /operators, GET /operators/:code, POST /operators, PATCH /operators/:code,
  // POST /operators/:code/secrets, POST /operators/:code/probe, POST /operators/:code/status
  ...
  return router;
}
```

Serialization never includes a secret:

```ts
function serializeOperator(operator: OperatorRecord, secrets: OperatorSecretRecord[]) {
  const active = secrets.filter((row) => row.retiredAt === null);
  return {
    code: operator.code, name: operator.name, callbackUrl: operator.callbackUrl,
    currency: operator.currency, status: operator.status, allowedOrigins: operator.allowedOrigins,
    localeDefault: operator.localeDefault,
    limits: {
      minStake: operator.limits.minStake.toString(),
      maxStake: operator.limits.maxStake.toString(),
      maxWin: operator.limits.maxWin.toString(),
      maxBetsPerRound: operator.limits.maxBetsPerRound,
    },
    enabledGames: operator.enabledGames, theme: operator.theme, maintenance: operator.maintenance,
    probeOkAt: operator.probeOkAt, createdAt: operator.createdAt,
    hasSecret: active.length > 0,
    secretVersion: active.length === 0 ? null : Math.max(...active.map((row) => row.version)),
  };
}
```

Error mapping for `OperatorError` in the router's error handler (400/401/404/409/502/503).

- [ ] **Step 5: Mount the router**

In `http.ts`, after `express.json`:

```ts
  app.use('/api/admin', adminRouter({ store: deps.store, registry: deps.registry, adminToken: deps.config.adminToken }));
```

`AppDeps` already carries `registry` from A4.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run games:test && npm run games:typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/games-provider
git commit -m "feat(games-provider): admin operator API with probe-gated activation"
```

---

## Task G3: Operator CLI, onboarding runbook and docs verification

**Files:**
- Create: `apps/games-provider/scripts/operator.ts`
- Modify: `apps/games-provider/package.json` (add `"operator": "tsx scripts/operator.ts"`)
- Create: `docs/GAMES-PROVIDER-ONBOARDING.md`
- Modify: `apps/games-provider/README.md`, `apps/games-provider/.env.example` (or the repo's provider env template)

**Interfaces:**
- Produces: `npm run operator -w @bingo/games-provider -- <command>` with `list | create | update | rotate-secret | probe | activate | suspend`.

- [ ] **Step 1: Write the CLI**

```ts
import 'dotenv/config';

const baseUrl = (process.env.GAMES_PROVIDER_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const token = process.env.PROVIDER_ADMIN_TOKEN;

async function call(method: string, path: string, body?: unknown) {
  if (!token) throw new Error('PROVIDER_ADMIN_TOKEN is required');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-provider-admin-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json()) as { data?: unknown; error?: { code: string; message?: string } };
  if (!response.ok) throw new Error(`${response.status} ${payload.error?.code ?? 'ERROR'}: ${payload.error?.message ?? ''}`);
  return payload.data;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function limitsFromFlags() {
  const minStake = flag('min-stake');
  const maxStake = flag('max-stake');
  const maxWin = flag('max-win');
  const maxBetsPerRound = flag('max-bets');
  if (!minStake && !maxStake && !maxWin && !maxBetsPerRound) return undefined;
  return {
    minStake: minStake ?? '100',
    maxStake: maxStake ?? '100000',
    maxWin: maxWin ?? '3000000',
    maxBetsPerRound: Number(maxBetsPerRound ?? '200'),
  };
}

const command = process.argv[2];

if (command === 'list') {
  console.table(await call('GET', '/api/admin/operators'));
} else if (command === 'create') {
  const data = (await call('POST', '/api/admin/operators', {
    code: flag('code'),
    name: flag('name'),
    callbackUrl: flag('callback-url'),
    allowedOrigins: (flag('origins') ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    limits: limitsFromFlags(),
  })) as { operator: { code: string }; secret: string; secretVersion: number };
  console.log(`operator ${data.operator.code} created (PENDING, secret v${data.secretVersion})`);
  console.log(`secret (shown once): ${data.secret}`);
  console.log('Store it in bingo as the provider webhookSecret, then run: probe, activate.');
} else if (command === 'rotate-secret') {
  const data = (await call('POST', `/api/admin/operators/${flag('code')}/secrets`)) as { version: number; secret: string };
  console.log(`secret v${data.version} (shown once): ${data.secret}`);
} else if (command === 'probe') {
  console.log(await call('POST', `/api/admin/operators/${flag('code')}/probe`));
} else if (command === 'activate' || command === 'suspend') {
  const status = command === 'activate' ? 'ACTIVE' : 'SUSPENDED';
  console.log(await call('POST', `/api/admin/operators/${flag('code')}/status`, { status }));
} else if (command === 'update') {
  console.log(await call('PATCH', `/api/admin/operators/${flag('code')}`, {
    name: flag('name'),
    callbackUrl: flag('callback-url'),
    allowedOrigins: flag('origins')?.split(',').map((value) => value.trim()).filter(Boolean),
    limits: limitsFromFlags(),
  }));
} else {
  console.error('usage: operator <list|create|update|rotate-secret|probe|activate|suspend> [--code ...]');
  process.exit(1);
}
```

Filter undefined keys before sending (a small `dropUndefined` helper) so PATCH does not clear fields.

- [ ] **Step 2: Write the onboarding runbook**

`docs/GAMES-PROVIDER-ONBOARDING.md` must contain, in order:

1. **Register the provider row in bingo** — in the staff console, create a `GameProvider` with `code = <operator code>`, currency, and a generated webhook secret; register the crash game with launch template
   `https://<provider-host>/play?token={token}&operator={operator}&lang={lang}&currency={currency}`.
2. **Create the operator on the provider** — `npm run operator -w @bingo/games-provider -- create --code ... --name ... --callback-url https://<bingo-host>/api/games/callback/<code> --origins https://<bingo-host> --min-stake 100 --max-stake 100000 --max-win 3000000 --max-bets 200`.
3. **Align the secret** — put the provider-generated secret into bingo's provider row; if bingo generated it instead, use `update`/`rotate-secret` so both sides hold the same value.
4. **Probe** — `... probe --code <code>`; activation is refused until the probe passes.
5. **Activate** — `... activate --code <code>`; then a sandbox round: launch from bingo, place the minimum stake, verify the bet appears in bingo's provider ledger and the win/rollback reconciles.
6. **Rotate a secret** — `rotate-secret`, update bingo with the new value and keep the old one in `config.previousWebhookSecret` for the overlap, then clear it after the old secret is retired.
7. **Suspend / maintenance** — `suspend` blocks new handshakes immediately; `update` with `maintenance: true` answers 503 to handshakes while keeping sessions readable.

- [ ] **Step 3: Update README and env template**

`apps/games-provider/README.md`: add `PROVIDER_ADMIN_TOKEN` and `DEFAULT_OPERATOR_CODE` to the env table (placeholders, no real values), document `/api/catalogue`, `/api/admin/operators*`, `/api/sessions/handshake` accepting `operator`/`game`, and link the runbook.

Env template: add `PROVIDER_ADMIN_TOKEN=change-me-admin-token` and `DEFAULT_OPERATOR_CODE=bingo251` with a comment that the bootstrap operator is env-seeded and additional operators come from the admin API.

- [ ] **Step 4: Run the full local verification**

```bash
npm run games:test
npm run games:typecheck
npm run api:test
npm run typecheck
```

Expected: all PASS. If the client built assets are stale locally, run `npm run games:build` once and confirm `/play` still serves.

- [ ] **Step 5: Commit everything left in the area**

```bash
git add apps/games-provider docs/GAMES-PROVIDER-ONBOARDING.md
git commit -m "docs(games-provider): operator CLI and onboarding runbook"
```

---

## Final verification (whole-branch)

- [ ] `npm run games:test && npm run games:typecheck && npm run api:test && npm run typecheck` all green.
- [ ] Two fake wallets in `isolation.test.ts` show only their own transactions.
- [ ] Rotation test proves old+new secrets verify during overlap and the old one fails after retirement.
- [ ] A config change (limits/origins/games) is read on the next handshake without a restart.
- [ ] Cross-tenant probes (operator mismatch, suspended, maintenance, disabled game, unknown operator) return typed errors before any wallet call.
- [ ] No secret appears in any response, log line or committed file.
- [ ] `docs/GAMES-PROVIDER-ONBOARDING.md` matches the implemented CLI and endpoints exactly.
