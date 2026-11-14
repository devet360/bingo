# Bingo Casino Platform

Real-time multiplayer bingo with a peer-to-peer (agent) deposit/withdrawal network,
served as a Telegram Mini App (Next.js) now and a Flutter mobile app in Phase 5.

## Repository layout

```
apps/api/prisma/schema.prisma   Canonical data model
apps/api/prisma/sql             DB invariants Prisma cannot express
apps/api/src                    Express + Socket.io API (auth, ledger, money, bingo)
apps/api/src/game               Pure engine: RNG, cards, patterns, payout math
apps/api/src/engine             RoundEngine: per-room clock and transitions
apps/api/src/realtime           Socket.io gateway + in-process event bus
apps/api/src/jobs               BullMQ maintenance queue + worker entrypoint
apps/api/src/bot                grammY bot: phone verification + Mini App entry
apps/api/scripts                create-admin: bootstraps the first super admin
apps/api/tests                  Unit tests (node:test)
apps/web                        Next.js 15 Mini App + staff dashboards (/admin, /support)
docs/ARCHITECTURE.md            Topology, ERDs, money flows, state machine
docs/API.md                     REST contract, error codes, idempotency rules
docs/DEPLOY.md                  Dokku apps, services, release commands
docker-compose.yml              Postgres 16 + Redis 7
Dockerfile.api / .worker / .web Container images used by Dokku
```

`apps/web` is the mobile-first Telegram Mini App, plus the browser-only staff console.
It reads `API_URL`, `SOCKET_URL` and `TELEGRAM_BOT_USERNAME` at runtime from
`/config.js`, so one image runs against any environment.

## Setup

```bash
cp .env.example .env      # fill BOT_TOKEN, keep the generated JWT secrets
npm install
npm run infra:up          # Postgres + Redis
npm run db:migrate        # creates tables from schema.prisma
npm run db:constraints    # append-only triggers, CHECKs, partial unique indexes
npm run db:generate
npm run db:seed           # 8 rooms: US75 / UK90 at 10, 50, 100, 500 credits
```

`npm run db:setup` runs the last three in order.

## Running the API

```bash
npm run api:dev           # tsx watch on http://localhost:4000 (REST + Socket.io)
npm run api:worker        # BullMQ maintenance worker (needs REDIS_URL)
npm run api:bot           # Telegram bot long-polling (needs BOT_TOKEN)
npm run admin:create -- --name "Owner" --email owner@example.com   # first super admin
npm run api:build
npm run api:start         # node dist/index.js
npm run typecheck         # API + web
npm run api:test
```

Interactive API docs are served at `http://localhost:4000/docs` (Swagger UI) from
`http://localhost:4000/openapi.json`.

## Running the web app

```bash
npm run web:dev           # Next.js on http://localhost:3000
npm run web:build
npm run web:start
npm run web:typecheck
```

The Mini App needs the API running and `CORS_ORIGINS` to include `http://localhost:3000`.
Players sign in from Telegram `initData`; staff sign in on the web with email/phone and
password (`/admin` for super admins, `/support` for support). There is no web sign-up.

## Deploying (Dokku)

Dokku hosts one app for the API (`web`, `worker` and `bot` processes) and one for the
web app, with Postgres and Redis linked as Dokku services. Full commands, release
steps and smoke tests are in [docs/DEPLOY.md](docs/DEPLOY.md).

With `REDIS_URL` set, the worker owns the expiry sweep. Without Redis, jobs that need a
scheduler (withdrawal/deposit expiry) fall back to an in-process timer. The bingo
environment variable `BINGO_ENGINE_ENABLED=false` turns off the round engine (useful for
a read-only API replica).

Operational probes: `GET /health` (liveness) and `GET /ready` (Postgres reachable,
503 when it is not).

## Two conventions everything depends on

1. **Money is `BigInt` minor units** (1 credit = 100). No floats anywhere, and JSON
   responses always render money as decimal strings.
2. **`TransactionLedger` + `LedgerEntry` are the only financial truth.** Wallet and
   agent float columns are caches, rewritten in the same `$transaction` as the journal
   and reconcilable with `SELECT * FROM v_account_drift`.

Every balance mutation goes through `postLedger()` (`apps/api/src/services/ledger.ts`):
it validates the instruction set per owner type, locks the affected accounts with
`SELECT ... FOR UPDATE` in ascending id order, checks the ledger idempotency key, writes
the balanced journal, then refreshes the caches. Callers only mutate business state when
`postLedger` returns `replayed: false`.

## Auth and onboarding

- **Players — Telegram only.** `POST /auth/telegram` verifies raw `initData` with
  HMAC-SHA256 against `BOT_TOKEN` and enforces `auth_date` freshness. Web registration
  is deliberately disabled (`POST /auth/register` returns `REGISTRATION_DISABLED`).
- **Phone verification — bot contact share only.** The player opens
  `https://t.me/<bot>?start=verify` and taps *Share contact*; the bot stores the phone
  on the Telegram user. `phoneVerifiedAt` gates card purchases and withdrawals. A
  Telegram login alone is not enough, and `initData` never carries the phone number.
- **Staff — web only.** Agents, support and super admins sign in with email/phone and
  password (`POST /auth/login`). Player accounts are rejected there
  (`PLAYER_WEB_LOGIN_DISABLED`), and staff are rejected inside Telegram
  (`STAFF_WEB_ONLY`). Accounts are provisioned by `npm run admin:create` or by a super
  admin in **Admin → Staff**, and a temporary password forces a change on first sign-in.
- **OTP** — `POST /auth/otp/request` then `/auth/otp/verify` is a login aid for an
  existing staff account only; it never creates an account. 6 digits, hashed with
  `OTP_HASH_PEPPER`, 5 min TTL, 5 attempts, single-use.
- **Link** — an authenticated account can attach a Telegram identity or a phone to the
  same wallet (`/auth/link/telegram`, `/auth/link/phone`).
- **Locale** — `PATCH /auth/locale` stores `en` or `am` for the web shell and bot
  replies. The client also persists the choice in `localStorage`.
- Sessions: JWT access token (15 min) + rotating refresh token (30 days) with reuse
  detection. All player, agent, support and admin routes require `Authorization: Bearer`.

Interactive docs: `GET /docs` (Swagger UI) and `GET /openapi.json`. The narrative
contract, error code table and idempotency rules are in [docs/API.md](docs/API.md).

## Money flows

Agent float is pre-funded by a SuperAdmin (`PLATFORM.SUSPENSE` → `AGENT.FLOAT`). Deposits
move float to the player and accrue a platform-funded commission; withdrawals lock the
player's credits in escrow, and redeeming the payout code moves escrow to the agent's
float (net) plus the fee to treasury. Details, sequences and the round state machine are
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Bingo engine

`RoundEngine` keeps one timer per open room. A round moves
`WAITING → LOCKED → PLAYING → CLAIM_VERIFICATION → COMPLETED`; card sales debit
`AVAILABLE → LOCKED`, the payout journal debits every `LOCKED` stake and credits the
winners plus `PLATFORM.RAKE`. Cancelled or underfilled rounds refund in full.

The draw order is committed before the first ball: `serverSeedHash` is published with the
round, `ballOrder` is derived from `HMAC_SHA256(serverSeed, clientSeed:nonce)` plus
Fisher-Yates with rejection sampling, and both seeds are revealed at completion. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §4 and the socket protocol in
[docs/API.md](docs/API.md#bingo-realtime-socketio).

Timers run in the API process; every transition takes `pg_advisory_xact_lock(roundId)`
and re-checks the round status, so extra API replicas cannot double-draw. The Dokku
deployment runs a single API web container; scaling the socket tier horizontally still
needs the Redis adapter for broadcast fan-out.

## Status

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Data model, SQL invariants, architecture | done |
| 2 | Express API: auth, ledger, deposits, withdrawals, agent/admin portal | done |
| 3 | Bingo engine, provably fair RNG, claim verification, Socket.io, BullMQ worker | done |
| 4 | Next.js TMA: lobby, live 75/90 board, wallet, agent portal, fairness verifier; Dokku packaging | done |
| 5 | Telegram bot + phone verification, staff roles, support/admin dashboards, Swagger, EN/AM | done |
| 6 | Flutter mobile app | next |

The Next.js app (`apps/web`) covers the lobby, a live table with 5×5 and 3×9 cards,
card purchases, claim buttons, settlement/refund banners, deposits and payouts, the
agent queue, and a browser-side provably-fair verifier at `/verify/<roundId>`. The
staff console adds user lookup, ledger/deposit/withdrawal queues, agent float and
commission management, staff provisioning, password resets and an audit log.

Code compiles and 25 unit tests pass (RNG determinism, 75/90-ball card legality, every
pattern, payout split). The stack has been exercised end to end against live PostgreSQL
and Redis: migrations, constraint/trigger install, seed, a real two-player round
(purchase → lock → draw → server-detected win → `ROUND_PAYOUT`), the provably-fair
`/verify` recomputation (`matches: true`), BullMQ sweep jobs, and an empty
`v_account_drift`. Run `npm run db:setup && npm run db:seed` before using the engine.
