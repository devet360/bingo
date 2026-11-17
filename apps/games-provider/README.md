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
| `BOT_COUNT` | `0` | Must stay `0` in V1. |

`.env.example` lists every key with placeholder values. Never commit real secrets.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/sessions/handshake` | Exchange the launch token for a signed balance and limits. |
| `POST` | `/api/sessions/close` | Close a session. |
| `GET` | `/api/rounds/:id/proof` | Server seed, hash, client seed composite and crash point of a finished round. |
| `GET` | `/api/health` | Liveness probe. |
| `WS` | `/ws` | Authenticated game socket (`auth`, `bet:place`, `bet:cancel`, `bet:cashout`). |
| `GET` | `/play` | Embedded game client (`dist/client`). |

## Single instance

Run exactly one provider process. Round timers live in-process, the outbox has no claim
lease, and socket fan-out is local, so `web=1` is a requirement, not a tuning knob.
Scaling above one replica is unsupported in V1.
