# Games Provider — V1 Design

**Status:** awaiting review
**Date:** 2026-11-17
**Scope:** A new monorepo app `apps/games-provider` that hosts a real-time crash game and sells it to bingo251 (and later other operators) over the existing HMAC callback seam.

---

## 1. Context

The prototype in `game-provider/` is a solid crash engine wrapped in a demo shell. The engine — round loop, multiplier curve, provably-fair derivation, React client — is worth keeping. Everything around it assumes the provider is the system of record, which it must not be:

- `WalletService.debitBalance/creditBalance` mutate an in-memory shadow balance and write fabricated callback logs with a randomised latency; nothing is ever sent to an operator.
- `/api/provider/launch` is unauthenticated and trusts a caller-supplied balance; `/api/session/topup` mints free credits.
- Firebase protects consoles that V1 does not need; free bets, chat rain and profit-share ledgers implement features V1 does not include.

bingo251 already has the hardened seam that fixes this: `POST /api/games/callback/:providerCode`, HMAC-SHA256 over the raw body in `x-provider-signature`, payload types `balance|bet|win|rollback`, money as integer minor units in strings, unique `(providerCode, txnId, type)` idempotency, double-entry postings against `PLATFORM SUSPENSE`, a signed `balance` reply, 2h session TTL, ACTIVE + phone-verified user checks, and a max-win ceiling.

**Conclusion:** integrate by re-pointing the provider at bingo's contract and deleting the provider's own money. Port and harden in place — do not rewrite the engine.

### Decisions locked with the product owner

| Decision | Choice |
|---|---|
| Wallet model | Seamless — bingo is the only wallet; provider keeps a display mirror |
| Player entry | Embedded page inside the bingo TMA, not a new tab |
| V1 feature cut | Core crash game only; bots shipped but disabled |
| Deployment | Separate Dokku app with its own Postgres |
| Provider portals | None in V1 (no operator/superadmin consoles) |
| Delivery | Ship and verify V1 first; write V2 requirements, review, test, then build V2 |

---

## 2. Scope

### In scope (V1)

- `apps/games-provider` — one Node process: Express API, `ws` socket, static React client built by Vite.
- One game: crash/aviator, global shared round, provably fair, EN + AM UI.
- Seamless-wallet integration with bingo251: handshake, bet, win (outbox), rollback (outbox), balance.
- Round and bet persistence with boot-time recovery.
- Public proof endpoint so players can verify a finished round.
- Bingo-side additive changes (section 7) and the embedded play page.

### Out of scope (V1)

- Bots (code retained, `botCount = 0` enforced), chat, chat rain, free bets.
- Operator/superadmin consoles, Firebase auth, profit-share ledgers, CSV exports, analytics pages.
- Guest sessions, top-up, rename/profile endpoints, catalog/keno/coin-flip.
- Second operator, multi-instance deployment, the Flutter app.
- Per-operator theming beyond the Telegram theme bridge.

---

## 3. Architecture and boundaries

```
bingo251 TMA (Next.js)
  └─ /games/play/[sessionId]  →  <iframe src="https://<crash-host>/play?token=…">
                                   │ postMessage: theme, locale, haptics, exit
                                   ▼
apps/games-provider  — single instance, single origin
  ├─ Vite-built client (React crash UI)
  ├─ Express API  (/api/health, /api/sessions/*, /api/rounds/:id/proof)
  ├─ ws server    (/ws)
  ├─ RoundEngine  (in-memory authority, DB-committed boundaries)
  ├─ WalletClient (HMAC signer/caller)  ──HTTPS──► bingo /api/games/callback/stratos
  ├─ OutboxWorker (wins/rollbacks, durable retries)
  └─ Postgres (Drizzle, own database)
```

Rules:

- The in-memory round loop is authoritative for pacing; **the app must run as exactly one instance**. `dokku ps:scale web=1`, documented in the app README.
- No wallet state lives in the provider. `displayBalance` is a mirror taken from signed bingo replies and is never used to authorise a bet.
- No secrets in the repo. Operator credentials arrive through env at boot and are upserted into the operator registry.

### Provider database (Drizzle)

| Table | Purpose |
|---|---|
| `operators` | `code` PK, `name`, `callbackUrl`, `hmacSecret`, `currency`, `enabled` |
| `sessions` | `token` PK (= bingo `externalSessionId`), `operatorCode`, `currency`, `minStake`, `maxStake`, `maxWin`, `displayBalance`, `status OPEN|CLOSED`, `createdAt`, `lastHandshakeAt` |
| `rounds` | `id` bigserial PK, `serverSeed`, `serverSeedHash`, `clientSeedComposite`, `crashPoint numeric(12,2)`, `status BETTING|FLYING|CRASHED|ABANDONED`, `startedAt`, `flewAt`, `crashedAt` |
| `bets` | `id` uuid PK, `roundId`, `operatorCode`, `sessionToken`, `panel smallint`, `stake bigint`, `autoCashout numeric(12,2)`, `status PLACING|ACTIVE|CASHED|LOST|CANCELLED|REJECTED|UNRESOLVED`, `cashoutMultiplier numeric(12,2)`, `payout bigint`, `betTxnId` uuid, `winTxnId` uuid, timestamps; unique `(roundId, sessionToken, panel)` |
| `wallet_outbox` | `id` uuid PK, `operatorCode`, `type WIN|ROLLBACK`, `txnId` uuid, `sessionToken`, `amount bigint`, `status PENDING|SENT|CAP_REJECTED|DEAD`, `attempts`, `nextAttemptAt`, `lastError`; unique `(operatorCode, type, txnId)` |
| `wallet_calls` | Audit of every outbound call: `type`, `sessionToken`, `txnId`, `httpStatus`, `latencyMs`, `requestHash`, `error`, `createdAt` |

Money is `bigint` minor units everywhere (1 ETB = 100 minor). No floats in money paths.

---

## 4. Session lifecycle and wallet contract

### 4.1 Identity

- Provider code in bingo: `stratos`. Callback URL: `https://<bingo-api>/api/games/callback/stratos`.
- Operator code in the provider: `bingo251`.
- bingo mints the session token (its `ProviderSession.externalSessionId`, a UUID) and opens `https://<crash-host>/play?token=<uuid>&lang=am|en&currency=ETB`. It does not call the provider at launch.

### 4.2 Handshake (token → session)

1. Client: `POST /api/sessions/handshake { "token": "<uuid>" }`.
2. Provider sends to bingo:

```json
{ "type": "balance", "sessionId": "<uuid>", "nonce": "<uuid>" }
```
signed with `x-provider-signature: HMAC-SHA256(rawBody, operatorHmacSecret)`.

3. bingo enforces: signature, session exists and belongs to `stratos`, `OPEN`, not expired, user `ACTIVE`, phone verified. Reply:

```json
{ "currency": "ETB", "balance": "123450", "timestamp": 1763400000,
  "nonce": "<echo>", "signature": "<hex>",
  "minStake": "100", "maxStake": "100000", "maxWin": "3000000" }
```

4. Provider verifies `HMAC-SHA256("<sessionId>.<currency>.<balance>.<timestamp>.<nonce>")` with the same secret and a ≤120s timestamp skew. Limits are optional; when absent fall back to provider defaults `minStake 100`, `maxStake 100000`, `maxWin 3000000`.
5. On success, upsert the `sessions` row and return `{sessionId, gameId, currency, balance, limits, expiresAt}`. Any 4xx from bingo is terminal: the client shows "session ended, return to the lobby" (`410`). A transport failure or 5xx is retried twice, then the client shows a retry screen rather than declaring the session dead.

Re-handshake is forced on every WebSocket (re)connect and at most every 5 minutes while idle. `SESSION_CLOSED` / expired are terminal.

### 4.3 Movements

Every movement is HMAC-signed over the exact raw body, uses integer minor units as strings, and carries a UUID `txnId` **unique to that movement** (a bet's txnId is never reused for its win — bingo's rollback lookup resolves by txnId and must be unambiguous).

```json
{ "type": "bet", "sessionId": "<uuid>", "txnId": "<uuid>",
  "amount": "1000", "currency": "ETB", "roundId": "12" }
```

| Event | Call | Success | Failure handling |
|---|---|---|---|
| Bet placed | `bet` | `201` created / `200` replayed → `ACTIVE` | 4xx → `REJECTED`, player sees the reason; timeout/5xx/network → `UNRESOLVED` (section 4.5) |
| Cashout (bet becomes `CASHED`) | `win` | `201`/`200` → `SENT` | Outbox retries 5xx/network forever, backoff 1s→60s |
| Pre-takeoff cancel | `rollback` (amount = stake) | `201`/`200` | Retry; `404 Original transaction` after one retry → audit |
| Balance refresh | `balance` | signed reply | Keep last signed balance; never invent one |

Error mapping from bingo (`error.code`): `SIGNATURE_INVALID`, `CALLBACK_MALFORMED`, `CURRENCY_MISMATCH`, `SESSION_CLOSED`, `ACCOUNT_INACTIVE`, `PHONE_VERIFICATION_REQUIRED`, `WIN_LIMIT_EXCEEDED`, `TRANSACTION_ROLLED_BACK`, `TXN_TYPE_MISMATCH`, `ROLLBACK_AMOUNT_MISMATCH`, `ROLLBACK_INVALID`.

### 4.4 Display balance

The provider stores `displayBalance` and updates it from (a) the signed handshake reply, (b) the additive `balance` field in bet/win replies, (c) a `balance` poll at most every 30s while a session is open. Bet acceptance never depends on it.

### 4.5 The indeterminate bet

If a `bet` call exceeds 3s, the bet is **excluded from the round** and marked `UNRESOLVED` — never `ACTIVE`, never silently `REJECTED`. The outbox replays the identical `txnId` (bingo is idempotent, so a replay can only confirm). If the replay lands, a `rollback` for that txnId is enqueued immediately. Net effect is exactly once: never charged, or charged and refunded. The player loses a round; no funds are at risk.

### 4.6 Win delivery

A win row is written to `wallet_outbox` in the same database transaction that settles the bet. The worker drains it. Classification:

- `2xx` → `SENT`.
- `409 WIN_LIMIT_EXCEEDED` → `CAP_REJECTED`, alert, no retry. Payouts are clamped locally to the session's `maxWin` so this should be unreachable.
- `409 TRANSACTION_ROLLED_BACK` or `SESSION_CLOSED` that survives one retry → `DEAD`, logged.
- Others → `PENDING` with exponential backoff.

---

## 5. Round engine, bet states, recovery

### 5.1 Lifecycle (persistence-first)

1. `BETTING` — insert round (`serverSeed`, `serverSeedHash`, `startedAt`), commit, then broadcast. Duration 5.5s.
2. `FLYING` — compute the composite client-seed string, derive the crash point from SHA-512 of `serverSeed:seed1:seed2:seed3`, persist `clientSeedComposite` + `crashPoint` + `flewAt`, commit, then broadcast. Ticks at 50ms, multiplier `e^(0.00006·ms)`.
3. `CRASHED` — persist `crashedAt`, reveal `serverSeed`, broadcast, cooldown 3.2s, next round.

The provably-fair math is unchanged: SHA-256 server-seed commitment, first 52 bits of SHA-512, `% 33 === 0` → 1.00x, `floor((100·2^52 − v)/(2^52 − v))/100`, cap 100,000x, ~96.97% RTP. The composite seed string is frozen into the round row so a proof survives restarts.

Round ids come from the DB sequence, not the prototype's in-memory fallback.

### 5.2 Bet states

```
PLACING ─→ ACTIVE ─→ CASHED      win enqueued in the same DB txn
   │          ├──→ LOST
   │          └──→ CANCELLED    rollback enqueued
   ├──→ REJECTED
   └──→ UNRESOLVED ─→ outbox replay → rollback enqueued if it landed
```

- `PLACING` is committed before the wallet call.
- Every transition commits before any broadcast.
- Unique `(roundId, sessionToken, panel)` makes a retried `bet:place` idempotent; `CASHED` is single-shot.
- Two independent panels per session per round are allowed (matches the existing UI).

### 5.3 Boot recovery

Runs before the first round is announced:

1. Start the outbox worker and attempt every pending win once.
2. Any round left `BETTING`/`FLYING` → `ABANDONED`; enqueue `rollback` for every `ACTIVE` bet at stake value and attempt each once.
3. Every `PLACING`/`UNRESOLVED` bet → replay its `bet` txnId, then roll back if it landed.
4. Start the loop once every recovery rollback has been enqueued and attempted. Wins still `PENDING` keep retrying in the background and do not block new rounds — their money is already accounted for in the outbox.

Guarantee: after recovery every bet from an interrupted round is in a terminal wallet state — charged and refunded, or never charged.

### 5.4 Live-socket rules

- Reconnect snapshot carries elapsed time and current multiplier, **never** `crashPoint` while flying.
- Cashout is accepted only for `ACTIVE` bets during `FLYING`.
- WS events in V1: `auth`, `bet:place`, `bet:cancel`, `bet:cashout`; outbound `snapshot`, `round:betting`, `round:tick`, `round:crashed`, `bet:update`, `balance:update`, `session:ended`, `error`.
- Chat, rain, free-bet and profile events are deleted.

### 5.5 Proof endpoint

`GET /api/rounds/:roundId/proof` returns `serverSeed`, `serverSeedHash`, `clientSeedComposite` (3 client seeds), `crashPoint`, timestamps — only once the round is `CRASHED`. An `ABANDONED` round never derived a crash point and returns `409 ROUND_ABANDONED`. The client offers the same verification the prototype implements in `verifyProofInBrowser`.

### 5.6 Bots

Code paths stay behind `botCount`, default 0, forced to 0 by env in V1. When enabled later they must not create bet rows, outbox rows or wallet calls.

---

## 6. Client, Telegram bridge, lobby

- `App.tsx` reduces to the game workspace; catalog/operator/superadmin/integration views, top-up, profile and rename are deleted.
- Entry `/play?token=…&lang=am|en&currency=ETB`: handshake → socket → snapshot. Terminal session errors stop at a single screen with no retry loop.
- **postMessage bridge** (both sides validate `event.origin` against `ALLOWED_PARENT_ORIGINS`):

| Direction | Message | Payload |
|---|---|---|
| parent → child | `bingo:theme` | bg, text, hint, button colors, scheme, safe-area insets, viewport height |
| parent → child | `bingo:locale` | `am` \| `en` |
| child → parent | `bingo:haptic` | `impact` \| `success` \| `error` |
| child → parent | `bingo:exit` | reason |

- No theme message within 500ms → URL params + `prefers-color-scheme`; haptics become no-ops. The game remains usable standalone in development.
- Layout: full viewport, `100dvh`, safe-area insets, portrait-first, responsive to 360px, canvas scales with container, no horizontal scroll.
- Localization: game strings ship EN + AM; `bingo:locale` switches live.
- Audio: existing engine, muted until a user gesture, mute toggle persisted.
- Server headers: `Content-Security-Policy: frame-ancestors <bingo web origin(s)>`; no wildcard and no removal of `X-Frame-Options` beyond what frame-ancestors needs.
- Bingo lobby: `window.open(launchUrl, '_blank')` becomes a router push to `/games/play/[sessionId]` rendering a full-viewport iframe (no bottom nav, header hidden, matching bingo room fullscreen behaviour).

---

## 7. Bingo-side changes (additive only)

1. `buildLaunchUrl` resolves `{currency}` to the provider's currency instead of the literal `CREDIT` (`apps/api/src/services/gameProviders.ts`).
2. `balance` reply gains optional `minStake`, `maxStake`, `maxWin` (strings, minor units), resolved from `ProviderGame` → `GameProvider` → `provider.maxWin` as today.
3. `bet`/`win` replies gain optional post-movement `balance` (string, minor units).
4. New web route `/games/play/[sessionId]` + iframe + Telegram theme/locale/haptic bridge on the parent side.
5. Lobby card links to the new route.

All three API changes are optional fields: existing callers and tests are unaffected.

---

## 8. Deployment and configuration

- Dokku app `bingo-crash`, own Postgres `bingo-crash-db`, `dokku ps:scale web=1`.
- Procfile: `web: node dist/server.js`. Migrations run on boot before `listen()`.
- Env (values supplied by the operator, none committed):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | provider Postgres |
| `PORT` | listen port |
| `OPERATOR_CODE` | `bingo251` |
| `OPERATOR_CALLBACK_URL` | `https://<bingo-api>/api/games/callback/stratos` |
| `OPERATOR_HMAC_SECRET` | same value as bingo's provider `webhookSecret` |
| `ALLOWED_PARENT_ORIGINS` | comma-separated bingo web origins |
| `GAME_MIN_STAKE` / `GAME_MAX_STAKE` / `GAME_MAX_WIN` | fallbacks when bingo sends no limits |
| `BOT_COUNT` | forced to 0 in V1 |

- No JWT signing secret: the bingo-issued UUID plus a verified `balance` reply is the whole authentication story; `jsonwebtoken`, `firebase-admin`, `recharts` and portal deps are removed.

---

## 9. Testing

**Provider units**
- Provably-fair fixtures: known digest → exact crashPoint, including the `% 33 → 1.00x` case; curve values at 2x/5x/10x.
- HMAC fixture: our signed string equals bingo's `signBalance` input byte-for-byte.
- Bet state machine: every legal transition, every illegal one rejected.
- Outbox classification: 2xx, 5xx retry, `WIN_LIMIT_EXCEEDED`, `SESSION_CLOSED`, `ROLLBACK_AMOUNT_MISMATCH`.
- Handshake rejects bad signature, stale timestamp, currency mismatch, closed session.

**Contract test (fake bingo server)**
Implements the real schema and checks: full round place → cashout → win applied; same txnId replay → `replayed:true`; rollback path; cap rejection; session-closed mid-round; indeterminate bet resolution.

**Recovery test**
Seed an interrupted `BETTING` round with `ACTIVE` bets, boot, assert `ABANDONED`, refunds issued, next round gated on an empty outbox.

**Bingo side**
Unit tests for the three additive changes; existing provider callback suite stays green.

**Manual E2E in Telegram**
Real session: one win, one loss, balance matches bingo history, close/reopen restores, provider killed mid-flight produces refunds, proof page verifies.

---

## 10. Rollout and rollback

1. bingo additive changes + tests, deploy api then web.
2. Deploy provider with `BOT_COUNT=0`; boot upserts the `bingo251` operator.
3. Register provider `stratos` + game `crash` via the existing admin API with `launchUrlTemplate=https://<crash-host>/play?token={token}&lang={lang}&currency={currency}`; enable for the test player.
4. Real rounds at normal limits for a few days, watching outbox depth and callback error rates.
5. Enable for all players.

**Rollback:** disable the provider or game in bingo's admin — the card disappears and launches are refused immediately. No provider-side revert needed; in-flight wins still drain.

---

## 11. V2 gate (explicit)

V1 ends when the acceptance criteria below are met. Then, before any V2 code:

1. Write `docs/superpowers/specs/<date>-games-provider-v2-requirements.md` covering candidate scope: bots with exposure caps, a second game, per-operator theming, chat + rain, provider admin console, multi-instance/HA story, additional operators.
2. Present it for review.
3. Test the reviewed requirements (contract/acceptance criteria).
4. Start implementation only after explicit approval.

No V2 feature is implemented, scaffolded or stubbed during V1.

---

## 12. Acceptance criteria (V1)

- Player launches crash from bingo's lobby inside the TMA, sees their real ETB balance, places a bet, and either cashes out or loses.
- Every placement, cashout, cancel and crash produces exactly one bingo ledger effect; replaying any call never double-charges or double-credits.
- Balance in bingo's history matches the game's displayed balance after each round.
- Killing the provider during a round leaves no money ambiguous: refunds appear in bingo history after restart.
- Telegram theme, haptics and EN/AM switching work inside the iframe; the game is usable at 360px width.
- `GET /api/rounds/:id/proof` verifies a finished round in the browser.
- Provider suite, contract test, recovery test and bingo's existing callback tests all pass; both apps typecheck clean.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| bingo callback latency makes bets `UNRESOLVED` often | 3s budget is generous on a same-region link; monitor the rate and alert above 0.5% |
| Provider downtime strands mid-round bets | Boot recovery refunds; players see "session ended" and can relaunch |
| Cap mismatch between local clamp and bingo | Limits come from the signed balance reply; `CAP_REJECTED` alerts instead of silent loss |
| Duplicate money movement | Unique txnIds per movement, unique outbox keys, bingo-side idempotency |
| `frame-ancestors` misconfigured blocks embedding | Env-driven allowlist verified in staging before enabling the game card |
