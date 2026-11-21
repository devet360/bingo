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
2. `store.upsertOperator()` — the operator row is created or refreshed from config.
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
| `OPERATOR_CODE` | `bingo251` | Key of the operator row refreshed at boot. |
| `OPERATOR_NAME` | `Bingo 251` | Display name of that operator row. |
| `OPERATOR_CALLBACK_URL` | — (required) | Bingo wallet callback, `POST /games/callback/<provider>`. |
| `OPERATOR_HMAC_SECRET` | — (required, 16+ chars) | Shared with the bingo provider record. |
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
| `PROVIDER_ADMIN_TOKEN` | — | Bootstrap token for `/api/admin/operators`; replace with a scoped staff-console token in V2 Area E. |
| `DEFAULT_OPERATOR_CODE` | `OPERATOR_CODE` | Operator used when `/play` or catalogue requests omit `operator`. |
| `CONSOLE_TOKEN_SECRET` | — | Shared HMAC key used to verify short-lived Bingo-issued provider console tokens. |
| `CHAT_ENABLED` | `false` | Opt-in per-process chat feature. |
| `CHAT_RETENTION_DAYS` | `30` | Retention window for room message playback. |

`.env.example` lists every key with placeholder values. Never commit real secrets.

The bootstrap `BOT_*` values seed settings only when the owner operator has no saved
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
| `GET`, `PUT` | `/api/admin/runtime-settings` | Owner-scoped game enablement and bot settings, persisted to the operator row. |
| `WS` | `/ws` | Authenticated game socket (`auth`, `bet:place`, `bet:cancel`, `bet:cashout`). |
| `GET` | `/play?operator=<code>` | Embedded game client (`dist/client`). `frame-ancestors` uses the operator's `allowedOrigins`, falling back to `ALLOWED_PARENT_ORIGINS`. |

## HA

Multiple provider instances may serve handshakes and WebSocket clients. One instance
owns round production and outbox leadership through a Postgres advisory lock; followers
poll for takeover and a new leader must acquire the lock within 10 seconds. Settlement
idempotency remains the final guard, and LISTEN/NOTIFY carries leader state.
