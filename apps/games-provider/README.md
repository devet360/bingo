# Crash game provider

A standalone crash game (provably-fair aviator style) that plugs into bingo251 and
other operators through a seamless-wallet contract. Bingo owns the player wallet; this
service owns rounds, bets, seed proofs and the embedded game client at `/play`.

Money is bigint minor units throughout (1 ETB = 100). The operator's wallet is the
authority for balances; every local money movement is mirrored by a durable outbox row
that is retried until bingo accepts it, replays it, or refuses it terminally.

## Boot order

`server.ts` follows the design's §5.3 sequence:

1. `database.migrate()` — drizzle migrations from `drizzle/`.
2. Optional bootstrap — if both `OPERATOR_CALLBACK_URL` and `OPERATOR_HMAC_SECRET` are set,
   the configured operator is seeded only when it does not already exist. Existing
   dashboard-managed operator settings are never overwritten at startup. Otherwise,
   create operators from Bingo Super Admin so their callback and secret are linked automatically.
3. Outbox drain — every pending win is attempted once before anything is decided.
4. `runRecovery()` — interrupted rounds are abandoned and refunded, ambiguous charges
   are replayed with their original txn id, and terminal bets without an outbox row get
   one.
5. Outbox drain again — the rollbacks recovery just enqueued are attempted before the
   first round opens.
6. `server.listen()`, then the outbox loop (1 s) and the round engine start.

Wins that stay `PENDING` are retried in the background and do not block the first round.
`SIGTERM`/`SIGINT` stop the engine and the outbox loop, terminate live sockets, close the
HTTP server and the pool.

## Commands

Run from the repository root:

```bash
npm run games:dev        # tsx watch, reads .env (copy .env.example)
npm run games:test       # node:test suite on the in-memory stores
npm run games:typecheck  # tsc --noEmit
npm run games:build      # vite build -> dist/client, served by /play
SMOKE_CONFIRM=yes npm run games:smoke   # writes rows to the configured database
```

`games:smoke` migrates the database, upserts the operator, seeds a fake session, a
`BETTING` round and an `ACTIVE` bet, then asserts that boot recovery abandons and refunds
them exactly once. It marks its own rollback row `SENT` with `SMOKE_TEST` so bingo is
never called for the fake session, and it refuses to run without `SMOKE_CONFIRM=yes`.
Recovery is global, so point it at a staging database or run it before the provider is
opened to players.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port; Dokku injects its own. |
| `DATABASE_URL` | — (required) | Postgres connection string. |
| `OPERATOR_CODE` | `bingo251` | Default tenant code used by the game runtime. |
| `OPERATOR_NAME` | `Bingo 251` | Name used only for an optional env-seeded bootstrap operator. |
| `OPERATOR_CALLBACK_URL` | unset | Optional bootstrap callback URL. Set with `OPERATOR_HMAC_SECRET` only when env-seeding an operator; dashboard-created operators get this from Bingo. |
| `OPERATOR_HMAC_SECRET` | unset | Optional bootstrap secret (16+ chars). The dashboard generates and synchronizes secrets for managed operators. |
| `OPERATOR_CURRENCY` | `ETB` | Three-letter ISO code. |
| `ALLOWED_PARENT_ORIGINS` | empty | Comma-separated origins allowed to iframe `/play`. |
| `GAME_MIN_STAKE` | `100` | Minor units. |
| `GAME_MAX_STAKE` | `100000` | Minor units. |
| `GAME_MAX_WIN` | `3000000` | Minor units, per-bet payout ceiling. |
| `GAME_MAX_BETS_PER_ROUND` | `200` | Bets accepted per round. |
| `CLIENT_SEEDS` | three prototype seeds | Exactly three comma-separated public client seeds. |
| `BOT_COUNT` | `0` | Initial number of visibly labelled simulation bots; `0` disables them. Editable in the owner dashboard after first boot. |
| `BOT_STAKE_MIN` / `BOT_STAKE_MAX` | `100` / `10000` | Simulation stake range in minor units. |
| `BOT_ROUND_PAYOUT_CAP` / `BOT_DAY_PAYOUT_CAP` | `0` / `0` | Simulation payout caps in minor units; `0` means no simulated payouts. |
| `BOT_DISCLOSE` | `true` | Bots are always visibly labelled as simulations in the game client. |
| `PROVIDER_ADMIN_TOKEN` | — | Optional bootstrap token for CLI/admin API access. Keep it server-side; never expose it in browser code. |
| `DEFAULT_OPERATOR_CODE` | `OPERATOR_CODE` | Operator used when `/play` or catalogue requests omit `operator`. |
| `CONSOLE_TOKEN_SECRET` | — | Shared HMAC key used to verify short-lived Bingo-issued provider console tokens. |
| `CHAT_ENABLED` | `false` | Opt-in per-process chat feature. |
| `CHAT_RETENTION_DAYS` | `30` | Retention window for room message playback. |

`.env.example` lists the values needed for a dashboard-managed deployment.
Optional bootstrap-only values are described in the table; never commit real secrets.
For dashboard-managed setup, the only provider URL entered in Bingo is the Games
Provider deployment URL. Bingo derives the callback from the API host, takes allowed
game origins from `CORS_ORIGINS`, and stores the Games Provider-generated HMAC secret.

The `BOT_*` values seed settings only when the owner operator has no saved
configuration. The Bingo251 owner can change supported games and simulation settings in
the embedded **Provider dashboard**. Simulated bots are clearly labelled in the client,
appear in Crash rounds only, do not place real bets, and never call the wallet.

See [the operator onboarding runbook](../../docs/GAMES-PROVIDER-ONBOARDING.md)
for create, probe, activation and secret-rotation steps. The
[operator administration guide](../../docs/GAMES-PROVIDER-OPERATOR-GUIDE.md) and
[integration guide](../../docs/GAMES-PROVIDER-INTEGRATION.md) provide the complete
deployment and wallet callback procedures.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/catalogue?operator=<code>` | Operator identity, currency, locale, enabled game IDs and their default names/categories/thumbnails, limits and theme. Unknown codes answer `404`. |
| `GET` | `/api/catalogue/games/:gameId/thumbnail.svg` | Provider-owned game thumbnail asset. |
| `POST` | `/api/sessions/handshake` | Exchange the launch token for a signed balance and limits. |
| `POST` | `/api/sessions/close` | Close a session. |
| `GET` | `/api/rounds/:id/proof` | Server seed, hash, client seed composite and crash point of a finished round. |
| `GET` | `/api/health` | Liveness probe. |
| `GET` | `/api/docs` | Interactive Swagger UI for the Games Provider API. |
| `GET` | `/api/docs/openapi.json` | OpenAPI 3.0 specification. |
| `GET`, `POST` | `/api/admin/operators` | List or create operators; creation returns a one-time secret. |
| `GET`, `PATCH`, `DELETE` | `/api/admin/operators/:code` | Read, update, or guarded-delete an operator. Deletion requires suspension and no session or financial history. |
| `POST` | `/api/admin/operators/:code/status` | Change operator status. |
| `POST` | `/api/admin/operators/:code/probe` | Probe the operator wallet callback. |
| `POST` | `/api/admin/operators/:code/secrets` | Rotate the operator secret; the new value is returned once. |
| `POST` | `/api/admin/operators/:code/secrets/:version/retire` | Retire an older secret while retaining the newest active version. |
| `GET`, `PUT` | `/api/admin/runtime-settings` | Owner-scoped game enablement and bot settings, persisted to the operator row. |
| `WS` | `/ws` | Authenticated game socket (`auth`, `bet:place`, `bet:cancel`, `bet:cashout`). |
| `GET` | `/play?operator=<code>` | Embedded game client (`dist/client`). `frame-ancestors` uses the operator's `allowedOrigins`, falling back to `ALLOWED_PARENT_ORIGINS`. |

The Bingo Super Admin has native, direct-linkable provider management pages at
`/admin/provider/overview`, `/admin/provider/operators`,
`/admin/provider/settings`, and `/admin/provider/test-player`. The API requests
are proxied server-side with short-lived console tokens; the bootstrap
`PROVIDER_ADMIN_TOKEN` is not sent to the browser. The CLI remains available for
recovery and automation.

## HA

Multiple provider instances may serve handshakes and WebSocket clients. One instance
owns round production and outbox leadership through a Postgres advisory lock; followers
poll for takeover and a new leader must acquire the lock within 10 seconds. Settlement
idempotency remains the final guard, and LISTEN/NOTIFY carries leader state.
