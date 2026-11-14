# API contract — Phases 2–5

Base URL: `http://localhost:4000` · All routes are JSON · All amounts are **integer minor
units** (1 credit = 100), returned as decimal **strings**.

Interactive OpenAPI docs are served at `GET /docs` (Swagger UI) with the machine-readable
document at `GET /openapi.json`. This file keeps the narrative rules Swagger cannot
express.

## Envelope and errors

Success: `{ "data": ... }` (list endpoints add `replayed: true` only on idempotent replays).

Error: `{ "error": { "code": "MACHINE_CODE", "message": "human text", "details"?: ... } }`

| HTTP | Codes you will see |
| --- | --- |
| 400 | `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED`, `OTP_INVALID`, `INVALID_CREDITED_AMOUNT` |
| 401 | `UNAUTHORIZED`, `TELEGRAM_INIT_DATA_INVALID`, `TELEGRAM_INIT_DATA_EXPIRED`, `SESSION_EXPIRED`, `REFRESH_TOKEN_REUSED` |
| 403 | `ROLE_FORBIDDEN`, `AGENT_REQUIRED`, `AGENT_INACTIVE`, `DEPOSIT_ASSIGNED`, `WITHDRAWAL_ASSIGNED`, `REGISTRATION_DISABLED`, `PLAYER_WEB_LOGIN_DISABLED`, `STAFF_WEB_ONLY`, `PHONE_VERIFICATION_REQUIRED`, `ACCOUNT_INACTIVE` |
| 404 | `NOT_FOUND` |
| 409 | `INSUFFICIENT_FUNDS`, `DEPOSIT_ALREADY_CREDITED`, `WITHDRAWAL_OPEN`, `PHONE_TAKEN`, `EMAIL_TAKEN`, `TELEGRAM_ALREADY_LINKED`, `CONCURRENT_UPDATE`, `LAST_SUPER_ADMIN` |
| 410 | `DEPOSIT_EXPIRED`, `WITHDRAWAL_EXPIRED`, `WITHDRAWAL_NOT_OPEN` |
| 429 | `RATE_LIMITED`, `OTP_ATTEMPTS_EXCEEDED` |

**Idempotency.** `POST /wallet/deposits`, `POST /wallet/withdrawals` and
`POST /admin/agents/:agentId/float` require an `Idempotency-Key` header (8–128 chars of
`A-Za-z0-9._:-`). Keys are scoped to the caller. Replaying a key returns the original
resource with `replayed: true` instead of creating a second one.

**Auth.** `Authorization: Bearer <accessToken>`. Access tokens live `JWT_ACCESS_TTL`
(15m). Refresh tokens rotate on every `/auth/refresh`; reusing an old one revokes the
session.

---

## Auth

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/auth/telegram` | `{ initData, startParam? }` | Players only. Verifies HMAC with `BOT_TOKEN`, enforces `auth_date` freshness; staff are rejected with `STAFF_WEB_ONLY` |
| POST | `/auth/register` | — | Disabled for everyone: `403 REGISTRATION_DISABLED`. Players are created by the bot; staff by a super admin |
| POST | `/auth/login` | `{ identifier, password }` | Staff only (`AGENT`/`SUPPORT`/`SUPER_ADMIN`); players get `PLAYER_WEB_LOGIN_DISABLED` |
| POST | `/auth/otp/request` | `{ identifier, channel?, purpose? }` | Login aid for an existing staff account. Always returns `sent: true`; `devCode` only outside production |
| POST | `/auth/otp/verify` | `{ identifier, code, channel?, purpose? }` | Staff login only; never creates an account |
| POST | `/auth/refresh` | `{ refreshToken }` | Returns a new access + refresh pair |
| POST | `/auth/logout` | — | Revokes the current session |
| GET | `/auth/me` | — | `{ user, wallet, agent }` |
| POST | `/auth/password` | `{ currentPassword, newPassword }` | Clears `mustChangePassword` after a staff password reset |
| PATCH | `/auth/locale` | `{ locale: "en" \| "am" }` | Persists the UI/bot language |
| POST | `/auth/link/telegram` | `{ initData }` | Attaches Telegram to an authenticated account |
| POST | `/auth/link/phone` | `{ phone, code, password? }` | Attaches a phone; send the OTP with `purpose: "LINK_PHONE"` first. Does **not** mark the phone verified |

```http
POST /auth/telegram
{ "initData": "query_id=...&user=%7B%22id%22%3A...&hash=..." }

200
{
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "accessTokenExpiresIn": "15m",
    "refreshExpiresAt": "2026-12-14T09:00:00.000Z",
    "user": { "id": "...", "role": "PLAYER", "displayName": "Ada", ... }
  }
}
```

**Player onboarding.** There is no web sign-up. A player starts the bot
(`https://t.me/<bot>?start=verify`) and taps the share-contact button; the bot verifies
that the contact belongs to the sender and sets `phoneVerifiedAt`. Until that happens
`POST /bingo/rooms/:code/cards` and `POST /wallet/withdrawals` fail with
`403 PHONE_VERIFICATION_REQUIRED`. Telegram `initData` never contains the phone number,
so the contact share is the only way to satisfy this gate.

**Staff onboarding.** A super admin creates `AGENT`, `SUPPORT` or `SUPER_ADMIN`
accounts from `/admin/staff` (or the first one with `npm run admin:create`). The
temporary password sets `mustChangePassword: true`; `/auth/me` exposes it so the web
shell forces `POST /auth/password` before anything else. Staff never use Telegram login.

**Account linking.** An authenticated account can attach a Telegram identity or a phone
(`/auth/link/telegram`, `/auth/link/phone`); both identities resolve to the same `User`
row, so the wallet and game history are shared.

---

## Player wallet

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/wallet` | — | `available`, `escrow`, `locked`, lifetime counters |
| GET | `/wallet/transactions` | `?limit=50` | Journal lines for this user's accounts |
| POST | `/wallet/deposits` | `{ amount, method, agentProfileId? , agentCode?, paymentAccountId?, externalRef?, receiptUrl?, playerNote? }` | Returns a 6-digit `code`, expires in 30m |
| GET | `/wallet/deposits` | `?status=PENDING` | |
| GET | `/wallet/deposits/:id` | — | |
| POST | `/wallet/withdrawals` | `{ amount, method, agentProfileId, paymentAccountId?, playerNote? }` | Locks funds in escrow immediately, returns `payoutCode`, expires in 60m |
| GET | `/wallet/withdrawals` | `?status=ESCROWED` | |
| POST | `/wallet/withdrawals/:id/cancel` | — | Refunds escrow; only while `ESCROWED` |

Only one `ESCROWED` withdrawal per player is allowed (partial unique index).

```http
POST /wallet/deposits
Idempotency-Key: 6f1a2c90-player-app
{ "amount": 500000, "method": "MOBILE_MONEY", "agentCode": "AG7KQ2M9" }

201
{ "data": { "id": "...", "code": "483921", "status": "PENDING", "amount": "500000",
            "expiresAt": "2026-11-14T09:30:00.000Z", ... }, "replayed": false }
```

---

## Public agents (player side)

| Method | Path | Query | Notes |
| --- | --- | --- | --- |
| GET | `/agents` | `?region=&method=` | Active agents, online first; includes active payment accounts |
| GET | `/agents/:agentCode` | — | Single agent profile |

Commission rates are **not** exposed on public agent profiles.

---

## Agent portal (`/agent`, role + active `AgentProfile` required)

| Method | Path | Body | Effect |
| --- | --- | --- | --- |
| GET | `/agent/me` | — | Profile with float/commission balances + own wallet |
| POST | `/agent/presence` | `{ isOnline }` | Availability for the player agent list |
| GET | `/agent/deposits` | `?status=` | Default: this agent's open work + unassigned `PENDING` |
| POST | `/agent/deposits/:code/claim` | — | Moves `PENDING → PROCESSING`, assigns to caller |
| POST | `/agent/deposits/:code/credit` | `{ creditedAmount?, note? }` | Atomic float → player credit + commission |
| POST | `/agent/deposits/:code/reject` | `{ note? }` | No money moves |
| GET | `/agent/withdrawals` | `?status=` | Default: `ESCROWED` payouts for this agent |
| POST | `/agent/withdrawals/redeem` | `{ payoutCode, note? }` | Releases escrow to float + fee to treasury + commission |
| GET | `/agent/commissions` | `?limit=` | |
| GET | `/agent/float-requests` | `?limit=` | Top-up / cash-out history |

```http
POST /agent/deposits/483921/credit
{ "note": "MoMo ref 88f21" }

200
{
  "data": { "status": "CREDITED", "creditedAmount": "500000", "settledAt": "..." },
  "replayed": false
}
```

`credit` fails with `409 INSUFFICIENT_FUNDS` when the agent's float is below the amount —
the credit never half-applies. Repeating a successful credit does not move money twice.

---

## Staff read API (`SUPPORT` or `SUPER_ADMIN`)

Mounted at `/support`. A super admin can call the same routes under `/admin` too.
Paginated lists return `{ "data": [...], "page": { "index", "size", "total" } }`; the web
client opts into the full envelope for these.

| Method | Path | Query / body | Notes |
| --- | --- | --- | --- |
| GET | `/support/users` | `?query=&role=&status=&page=` | Search by display name, phone, email or Telegram id |
| GET | `/support/users/:userId` | — | User + wallet + agent + counts + last 10 ledgers/deposits/withdrawals |
| POST | `/support/users/:userId/status` | `{ status: "ACTIVE" \| "SUSPENDED" }` | Suspending revokes sessions. Cannot target yourself; only a super admin can modify a super admin |
| GET | `/support/transactions` | `?kind=&refType=&userId=&page=` | Ledger journals with entries |
| GET | `/support/deposits` | `?status=&userId=&page=` | |
| POST | `/support/deposits/:depositId/cancel` | — | Only open deposits; releases nothing that was already credited |
| GET | `/support/withdrawals` | `?status=&userId=&page=` | |
| POST | `/support/withdrawals/:withdrawalId/cancel` | — | Only `ESCROWED`; returns the locked funds to the player |
| GET | `/support/agents` | `?status=` | Float, escrow and commission summary |

## SuperAdmin (`SUPER_ADMIN`)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/admin/overview` | — | Users, players, staff, agents, open queues, round and money totals |
| GET | `/admin/staff` | `?query=&status=&page=` | Staff accounts |
| POST | `/admin/staff` | `{ role, displayName, email?, phone?, password?, agent? }` | `agent` (`{ region, city?, district? }`) is required for `AGENT`; returns the temporary password when generated |
| PATCH | `/admin/staff/:userId/status` | `{ status: "ACTIVE" \| "SUSPENDED" }` | Cannot suspend yourself or the last active super admin (`LAST_SUPER_ADMIN`) |
| POST | `/admin/staff/:userId/reset-password` | `{ password? }` | Forces `mustChangePassword` on next login |
| GET | `/admin/audit` | `?action=&actorId=&entityType=&page=` | Before/after JSON for every privileged mutation |
| POST | `/admin/agents` | `{ userId \| telegramId, region, city?, district? }` | Promotes a user, provisions float accounts |
| GET | `/admin/agents` | `?status=` | |
| PATCH | `/admin/agents/:agentId` | `{ status?, tier? }` | |
| POST | `/admin/agents/:agentId/float` | `{ amount, method, externalRef?, proofUrl? }` | `Idempotency-Key` required; posts `SUSPENSE → FLOAT` |
| GET | `/admin/reconciliation` | — | Reads `v_account_drift`; `healthy: true` when caches match the journal |

---

## Bingo (REST)

Lobby reads are public. Everything that moves money requires `Authorization: Bearer`.
Money amounts are decimal strings in the same minor units as the wallet.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/bingo/rooms` | — | Rooms with their live-round summary |
| GET | `/bingo/rooms/:code` | — | Room, current round, last 5 finished rounds |
| GET | `/bingo/rooms/:code/history` | — | `?limit=1..50` finished rounds (seeds revealed) |
| GET | `/bingo/rounds/:id` | — | Public round snapshot (`drawnBalls`, pot, timings) |
| GET | `/bingo/rounds/:id/verify` | — | Provably-fair proof (only once `COMPLETED`/`CANCELLED`) |
| GET | `/bingo/rounds/:id/my-cards` | player | The caller's cards for that round |
| POST | `/bingo/rooms/:code/cards` | player | Body `{ quantity: 1..4, clientSeed? }`; `Idempotency-Key` required |
| POST | `/bingo/rounds/:id/claims` | player | Body `{ cardId, pattern }`; only during `CLAIM_VERIFICATION` |

**Buying cards** (`POST /bingo/rooms/:code/cards`):

```json
{ "quantity": 2, "clientSeed": "my-lucky-seed" }
```

```json
{
  "data": {
    "round": { "id": "…", "status": "WAITING", "purchaseClosesAt": "…", "prizePool": "2000" },
    "cards": [
      { "id": "…", "cardIndex": 0, "cells": { "variant": "US_75", "rows": 5, "cols": 5, "grid": [[…]] } }
    ]
  },
  "replayed": false
}
```

Replaying the same `Idempotency-Key` returns the same cards with `replayed: true` and
does not debit the wallet again. Stakes move `AVAILABLE → LOCKED` in one journal.

**Claim** (`POST /bingo/rounds/:id/claims`) returns the validated claim:

```json
{ "data": { "status": "VALID", "pattern": "HORIZONTAL", "drawnSnapshot": [7, 21, …] }, "replayed": false }
```

Invalid claims return `status: "INVALID"` with `rejectionReason` one of
`PATTERN_NOT_SUPPORTED`, `PATTERN_NOT_ALLOWED`, `PATTERN_INCOMPLETE`. Claims close at
`claimsCloseAt`.

**Verify** returns `serverSeed`, `serverSeedHash`, `seedHashMatches`, `clientSeed`,
`clientSeeds[]`, `nonce`, `ballOrder`, `recomputedBallOrder`, `matches` and
`alreadyDrawnMatch` — everything needed to reproduce the draw independently.

## Bingo realtime (Socket.io)

Connect to the same origin as the HTTP API with the access token:

```js
const socket = io('http://localhost:4000', { auth: { token: accessToken } });
```

Unauthenticated handshakes are rejected with `UNAUTHORIZED`. On connect the socket joins
`user:<userId>` and receives wallet updates.

### Client → server

| Event | Payload | Ack |
| --- | --- | --- |
| `room:subscribe` | `{ roomCode }` or `{ roomId }` | `{ room, round, myCards }` |
| `room:unsubscribe` | same | `{ ok: true }` |
| `cards:buy` | `{ roomCode, quantity, clientSeed?, idempotencyKey? }` | `{ round, cards, wallet, replayed }` |
| `claim:submit` | `{ roundId, cardId, pattern }` | `{ claim, replayed }` |
| `round:view` | `{ roundId }` | `{ round, room, myCards, claimCount }` |

Ack failures are shaped `{ error: { code, message } }`; socket-level errors use the same
codes as REST.

### Server → room

| Event | Payload |
| --- | --- |
| `round:state` | Full public round snapshot (serialized like `GET /bingo/rounds/:id`) |
| `ball:drawn` | `{ roundId, ball, index, drawnCount, status }` |
| `round:claiming` | `{ roundId, claimsCloseAt, detectedWinners }` |
| `round:settled` | `{ roundId, winners: [{ userId, cardId, pattern, payout }], rake, prizePool, serverSeed }` |
| `round:cancelled` | `{ roundId, reason }` |

### Server → user

| Event | Payload |
| --- | --- |
| `wallet:update` | `{ available, escrow, locked }` after a purchase or payout |

`round:claiming` is the signal to render the daub/claim button; the round pauses (no more
balls) until `claimsCloseAt`, then `round:settled` arrives. Server-side auto-daub is on by
default, so the payout happens even if the client never claims.

## Operational

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, no dependencies |
| GET | `/ready` | 200 when Postgres answers, 503 otherwise |

## Happy-path smoke test

1. `POST /admin/agents` for a test user, then `POST /admin/agents/:id/float` with
   `amount: 10000000` (100,000 credits) to give the agent liquidity.
2. Player `POST /wallet/deposits` → share `code` with the agent.
3. Agent `POST /agent/deposits/:code/credit` → player `GET /wallet` shows the credit and
   `GET /wallet/transactions` shows one `DEPOSIT` line.
4. Player `POST /wallet/withdrawals` → share `payoutCode` with the agent.
5. Agent `POST /agent/withdrawals/redeem` → player escrow returns to zero, agent float
   increases by `netAmount`, commission appears in `GET /agent/commissions`.
