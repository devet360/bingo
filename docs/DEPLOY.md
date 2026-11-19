# Deploying to Dokku

Two apps share one repository and one build context:

| Dokku app | Image | Processes | Serves | Port |
| --- | --- | --- | --- | --- |
| `bingo-api` | `Dockerfile.api` | `web`, `worker`, `bot`, `support-bot` (from `Procfile`) | REST + Socket.io + Swagger, BullMQ worker, Telegram bots | 4000 |
| `bingo-web` | `Dockerfile.web` | `web` | Next.js Mini App + staff dashboards | 3000 |

Postgres and Redis come from Dokku plugins. Linking the services injects
`DATABASE_URL` and `REDIS_URL` into the API app, so no connection string is copied by
hand. The web app never talks to the database.

> The repository has to be under git for `git push` deploys. If `git status` fails, run
> `git init`, commit, then add the Dokku remotes below.

## 1. Create apps and data services

```bash
dokku apps:create bingo-api
dokku apps:create bingo-web

dokku postgres:create bingo-db
dokku redis:create bingo-cache

dokku postgres:link bingo-db bingo-api     # DATABASE_URL
dokku redis:link bingo-cache bingo-api     # REDIS_URL
```

If you already created the services by hand, `dokku postgres:link` is still the
supported way to wire them; alternatively set `DATABASE_URL` / `REDIS_URL` yourself
with `dokku config:set`.

## 2. Point Dokku at the right Dockerfile and port

```bash
dokku builder-dockerfile:set bingo-api dockerfile-path Dockerfile.api
dokku builder-dockerfile:set bingo-web dockerfile-path Dockerfile.web

# Both apps share this repo, so bingo-web must use its own Procfile. Without
# this, Dokku reads the API Procfile and tries to run apps/api/dist/index.js
# inside the Next.js image.
dokku ps:set bingo-web procfile-path Procfile.web

dokku ports:set bingo-api http:80:4000
dokku ports:set bingo-web http:80:3000
```

`.dockerignore` keeps `node_modules`, `dist`, `.next` and `.env` out of the build
context. Prisma is generated twice in the image (before and after `npm prune`) and the
client ships `debian-openssl-3.0.x` engines to match the Debian slim runtime. The API
image keeps `apps/api/src`, `apps/api/scripts` and `apps/api/prisma` so `dokku run`
can execute the seed and `admin:create` with `tsx`.

## 3. Telegram bot in BotFather

Before the first deploy:

1. Open [@BotFather](https://t.me/BotFather) and run `/newbot`; keep the token.
2. Pick the public bot username (without `@`) — the web app builds its
   `https://t.me/<username>?start=verify` sign-in link from it.
3. Optional: `/setdescription`, `/setuserpic`. Do **not** enable payments or games
   platform; this bot only verifies phone numbers and opens the Mini App.

The bot process configures itself on boot: localized command lists (`en`, `am`) and a
Web App menu button pointing at `TELEGRAM_WEBAPP_URL`. You can still set the menu
button manually with `/setmenubutton` if you prefer.

### Customer-support bot

The support chat is a **second** BotFather bot (a separate token keeps the support
graceful-shutdown sweep and player onboarding on independent Telegram long polls):

1. `@BotFather` → `/newbot` → name it e.g. “Bingo 251 Support”, keep the token.
2. `/setdescription` with the support hours, and `/setuserpic` so players recognise it.
3. Do **not** add it as a Mini App / payments bot; it only chats.
4. Put the token in `SUPPORT_BOT_TOKEN` on `bingo-api` (section 5). If it is missing the
   `support-bot` process exits immediately, and the rest of the API is unaffected.

Player commands: `/start`, `/menu`, `/ticket` (talk to an agent), `/help` (FAQ) and
`/end`. Tickets created here appear in **Support → Tickets** and **Admin → Tickets**;
staff replies are pushed back to the player by the support-bot process, which sweeps
undelivered `SupportMessage` rows every three seconds. Run **exactly one**
`support-bot` process — it owns the Telegram long poll for that token.

Operating hours are `SUPPORT_HOURS_START`–`SUPPORT_HOURS_END` in `SUPPORT_TIMEZONE`
(defaults 08–22 `Africa/Addis_Ababa`; `start == end` means 24/7). Outside the window the
bot still takes messages and queue length grows; players see the offline notice.

## 4. Domains and TLS

```bash
dokku domains:add bingo-api api.example.com
dokku domains:add bingo-web app.example.com

dokku letsencrypt:enable bingo-api
dokku letsencrypt:enable bingo-web
```

Telegram requires HTTPS with a valid certificate for both the Mini App and the bot's
Web App button.

## 5. Configuration

Generate production secrets first (`openssl rand -hex 32`), then:

```bash
dokku config:set bingo-api \
  NODE_ENV=production \
  JWT_ACCESS_SECRET="<64 hex chars>" \
  JWT_REFRESH_SECRET="<64 hex chars>" \
  CONSOLE_TOKEN_SECRET="<64 hex chars shared with the games provider>" \
  OTP_HASH_PEPPER="<32+ chars>" \
  BOT_TOKEN="<telegram bot token>" \
  SUPPORT_BOT_TOKEN="<second telegram bot token>" \
  TELEGRAM_WEBAPP_URL="https://app.example.com" \
  TELEGRAM_BOT_USERNAME="<bot username without @>" \
  CORS_ORIGINS="https://app.example.com" \
  BINGO_ENGINE_ENABLED=true \
  WORKER_CONCURRENCY=2 \
  RECEIPT_RELAY_URL="https://YOUR-RELAY-HOST"

dokku config:set bingo-web \
  NODE_ENV=production \
  API_URL="https://api.example.com" \
  SOCKET_URL="https://api.example.com" \
  TELEGRAM_BOT_USERNAME="<bot username without @>"
```

`API_URL`, `SOCKET_URL` and `TELEGRAM_BOT_USERNAME` are read at runtime by
`/config.js` in the web app, so they can be changed with a restart and no rebuild.

The embedded provider game iframe (`/games/play/<sessionId>`) needs no provider
host of its own: the play page takes the launch URL from the API's game-session
response and derives the iframe origin — and the `postMessage` target origin for
the theme/locale bridge — from that URL at runtime.

`CORS_ORIGINS` is a comma-separated allow-list and must contain every browser origin
that calls the API (the Mini App origin and any staff dashboard preview origin).

`RECEIPT_RELAY_URL` points at the PHP relay (`apps/receipt-relay`) on Ethio Telecom
hosting. With it set, Telebirr and M-Pesa deposits **and** the staff/agent receipt
checker (`POST /support|/admin|/agent/receipts/check`) verify through the relay and
record `source: "RELAY"`; without it those rails stay `UNREACHABLE` for the checker
and `MANUAL` for deposits. `RECEIPT_RELAY_TIMEOUT_MS` (default 15000, max 30000) is
optional.

Dokku injects `PORT`, which the API honours (`API_PORT` overrides it for local runs).
Do not set `PORT` yourself.

## 6. Deploy

```bash
git remote add dokku-api dokku@YOUR_VPS:bingo-api
git remote add dokku-web dokku@YOUR_VPS:bingo-web

git push dokku-api main
git push dokku-web main
```

`Procfile` defines four processes. After the first deploy scale all of them:

```bash
dokku ps:scale bingo-api web=1 worker=1 bot=1 support-bot=1
```

- `web` runs the API and Socket.io gateway — keep it at exactly one container.
  `RoundEngine` timers are in-process, and horizontal socket fan-out would need the
  Socket.io Redis adapter.
- `worker` owns the BullMQ sweep for expired deposits/withdrawals. It is safe to run
  more than one, but one is enough.
- `bot` long-polls Telegram. Run **exactly one** instance; two pollers hit
  `409 Conflict` and Telegram aborts the newer one (`dokku logs bingo-api -t bot`).
- `support-bot` long-polls the second Telegram bot and delivers staff replies. Also
  **exactly one** instance. It exits at boot when `SUPPORT_BOT_TOKEN` is unset, so scale
  it only after the token is configured (`dokku logs bingo-api -t support-bot`).
- `bingo-web` runs only its default `web` process from `Procfile.web`; leave it at
  `web=1` and do not add worker/bot processes there.

If you prefer a separate app for the worker or bot, create `bingo-worker`, link the same
Postgres and Redis services, set the same secrets, use
`dokku builder-dockerfile:set bingo-worker dockerfile-path Dockerfile.worker`, and set
its Procfile process type to `worker` or `bot`.

## 7. First-boot database steps

Run these once after the API image is deployed (they run inside the container, with the
linked `DATABASE_URL`):

```bash
dokku run bingo-api npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
dokku run bingo-api npx prisma db execute \
  --file apps/api/prisma/sql/constraints.sql \
  --schema apps/api/prisma/schema.prisma
dokku run bingo-api npx tsx apps/api/prisma/seed.ts
```

The constraints file is idempotent and installs the append-only ledger triggers, CHECK
constraints, the one-active-round-per-room index and the ledger idempotency index — the
API refuses to behave correctly without them. Re-run the seed after a fresh database;
it upserts rooms, platform accounts and the demo agent.

Then create the first super admin. Print or copy the generated password; it is shown
only once:

```bash
dokku run bingo-api npm run admin:create -w @bingo/api -- \
  --name "Owner" --email owner@example.com
```

Pass `--phone +2519...` instead of `--email` if the owner signs in by phone, and
`--password '<temporary>'` to choose the first password. Every provisioned staff
account is forced through a password change on first web sign-in.

Repeat the migrate/constraints commands on every release that changes the schema.

The growth-suite release adds `20261114150000_marketing_bonus_providers` (campaigns,
bonus promotions and grants, referral commissions, game providers, provider sessions and
the bonus wallet bucket). It is applied by the same `prisma migrate deploy` above; no
manual SQL is needed. Sign in as a super admin afterwards to set the referral commission
and the default wagering multiplier in **Admin → Bonuses**.

The payment-routing release adds
`20261115120000_phase1_agent_tasks_proofs_providers` (agent tasks and availability,
player payout accounts, withdrawal proofs and media assets, provider callback logs and
per-type provider transactions, and the `PROCESSING` withdrawal status). Re-run both
commands from section 7. `constraints.sql` also rebuilds the open-withdrawal indexes so
`PROCESSING` still counts as an open payout, and adds the one-live-task-per-agent index.

Payment screenshots are files on disk, not database rows. Mount a persistent Dokku
storage directory before taking real proofs, otherwise redeploys erase evidence:

```bash
dokku storage:ensure-directory bingo-api media
dokku storage:mount bingo-api /var/lib/dokku/data/storage/bingo-api/media:/app/.data/media
dokku ps:restart bingo-api
```

The customer-support release adds `20261115140000_support_desk` (support tickets,
messages and the one-active-ticket index) followed by `20261115141000_support_delivery`
(delivery retry bookkeeping). Both are applied by the same `prisma migrate deploy`
above. Scale `support-bot=1` after `SUPPORT_BOT_TOKEN` is set; no extra SQL is needed.

New optional tuning knobs (defaults are fine): `AGENT_TASK_SLA_MINUTES` (30) sets when a
routed deposit/withdrawal shows as overdue, and `MEDIA_DIR` / `MEDIA_MAX_BYTES` control
where screenshots are stored and the upload ceiling. The platform win ceiling lives in
**Admin → Providers** and defaults to 30,000 ETB per single win.

The games/rain release adds `20261119230000_rain_credit`, which adds the
`RAIN_CREDIT` ledger kind to the Prisma enum. It is included in the standard
`prisma migrate deploy` step; no separate SQL is required. Set
`CONSOLE_TOKEN_SECRET` before issuing provider-console tokens.

## 8. Access model

- **Players — Telegram only.** There is no web registration. A player opens the bot,
  shares their own contact once (`request_contact`) and the bot links the verified
  phone to their Telegram account. Purchases and withdrawals are blocked until
  `phoneVerifiedAt` is set. The Mini App signs in with Telegram `initData`.
- **Staff — web or Telegram Mini App.** Agents, support and super admins sign in on the
  web app with email/phone + password. A super admin can also attach a Telegram id in
  **Admin → Staff** (or issue a one-time bot link), after which the same account opens
  its agent/support/admin dashboard inside the Mini App.
- First staff account comes from `admin:create` above. After that, a super admin uses
  **Admin → Staff** to provision AGENT/SUPPORT/SUPER_ADMIN accounts, reset passwords,
  suspend accounts, link Telegram ids and top up agent float. Every action is written to
  the audit log.
- **Deposit receipts.** The migration seeds the bank rails in `DepositProvider`
  (Telebirr and M-Pesa are client-side because the banks block foreign IPs). A super
  admin turns rails on/off and edits prompts and limits in **Admin → Providers**; the
  parsers and endpoint host allowlists are code-owned. Agents enable automation and set
  a threshold in **Agent → Settings**, and register the receiving accounts players pay
  into. Telebirr/M-Pesa receipts are fetched by the player's phone and verified by the
  API; auto-credit only happens when the receipt matches the amount, the receiver and
  the agent's threshold.
- Support gets read-only views of users, ledger transactions, deposits, withdrawals
  and agents (plus cancel-open-deposit/withdrawal actions). The full console lives at
  `/admin`; support staff land on `/support`.
- **Support tickets.** Players reach the support bot (second BotFather bot), browse the
  FAQ or open a chat; each player has at most one open ticket. SUPPORT and SUPER_ADMIN
  see the queue in **Tickets**, claim a conversation, reply with text, and resolve it.
  Replies and photos sent from the dashboard are delivered to the player's Telegram
  chat by the `support-bot` process.

## 9. Smoke test

```bash
curl -fsS https://api.example.com/health
curl -fsS https://api.example.com/ready
curl -fsS https://api.example.com/openapi.json | head -c 200
curl -fsS https://app.example.com/config.js
```

- API docs: `https://api.example.com/docs` (Swagger UI; the API disables CSP for it).
- Web: sign in as a staff account at `https://app.example.com` to reach `/admin` or
  `/support`. Players must open `https://t.me/<bot>?start=verify`, share contact, then
  launch the Mini App from the bot button.
- Locale: switch EN/አማርኛ in the shell header; the choice is saved on the user and
  drives the bot's replies on the next message.
- A healthy end-to-end round needs `worker` running and `BINGO_ENGINE_ENABLED=true`;
  `bot` is only required for player onboarding.

## 10. Operations

```bash
dokku logs bingo-api -t
dokku ps:report bingo-api
dokku postgres:info bingo-db
dokku postgres:export bingo-db > bingo-$(date +%F).dump
dokku enter bingo-api web
```

Common failures:

| Symptom | Cause / fix |
| --- | --- |
| `Invalid environment configuration: { PORT: [...] }` on `worker`/`bot` | Dokku sets `PORT=0` for non-web processes; rebuild the API image (the env schema accepts `0`), then redeploy |
| `MODULE_NOT_FOUND /app/apps/api/dist/index.js` on `bingo-web` | The web app inherited the API `Procfile`; run `dokku ps:set bingo-web procfile-path Procfile.web`, commit `Procfile.web`, and redeploy |
| 502 from the proxy | Wrong `ports:set` mapping, or the process is not listening on `PORT`/4000. |
| `P1001` on `/ready` | `DATABASE_URL` missing; link the Postgres service. |
| Socket connects to `localhost` | `SOCKET_URL` not set on `bingo-web` (check `/config.js`). |
| `P1012`/engine error at boot | Prisma client generated for another libc; rebuild with `Dockerfile.api`. |
| Rounds never start | `BINGO_ENGINE_ENABLED` false, or API replicas scaled beyond one. |
| CORS error in browser | Add the page origin to `CORS_ORIGINS` and restart the API. |
| Bot exits with `409` / `TelegramError: Conflict` | More than one `bot` process is polling; scale `bot=1`. |
| Support bot exits immediately | `SUPPORT_BOT_TOKEN` is missing or rejected, or it equals `BOT_TOKEN` (both bots would long-poll the same token); set a separate BotFather token with `dokku config:set bingo-api SUPPORT_BOT_TOKEN=...`, then restart the process. |
| Player sign-in shows no bot link | `TELEGRAM_BOT_USERNAME` missing on `bingo-web`; set it and restart. |
| Buy/withdraw says phone required | Player has not shared contact with the bot yet; send them `https://t.me/<bot>?start=verify`. |
| Staff sees the player view in Telegram | The staff account has no Telegram id; link it from **Admin → Staff** (or send the one-time bot link). |
| Deposit stays PENDING after the receipt | Auto mode off, amount above the agent threshold, receiver mismatch, or the rail is unsupported; check **Support → Receipts** for the message. |

## 11. Phase 6 (Flutter) impact

The Flutter app will be another client of the same API and Socket.io gateway. It needs
no new Dokku app: point it at `https://api.example.com` and authenticate with Telegram
`initData` after the same bot contact-share verification. Mobile HTTP clients are not
subject to browser CORS.

## 12. Crash game provider (`bingo-crash`)

The crash game provider is a third Dokku app built from this repository. It keeps its
own Postgres database and serves the game client plus its HTTP/WebSocket API on one
process:

| Dokku app | Image | Processes | Serves | Port |
| --- | --- | --- | --- | --- |
| `bingo-crash` | `Dockerfile.games` | `web` (from `Procfile.games`) | Handshake/close/proof API, `/ws` gateway, `/play` client | 3001 |

Create the app and its database:

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

`postgres:link` injects `DATABASE_URL`; Dokku injects `PORT` for the web process, so
neither is set by hand. Configure everything else (copy
`apps/games-provider/.env.example`, type the real values):

```bash
dokku config:set bingo-crash \
  NODE_ENV=production \
  OPERATOR_CODE=bingo251 \
  OPERATOR_NAME="Bingo 251" \
  OPERATOR_CALLBACK_URL="https://api.example.com/games/callback/stratos" \
  OPERATOR_HMAC_SECRET="<provider secret from Admin → Providers>" \
  OPERATOR_CURRENCY=ETB \
  ALLOWED_PARENT_ORIGINS="https://app.example.com" \
  GAME_MIN_STAKE=100 \
  GAME_MAX_STAKE=100000 \
  GAME_MAX_WIN=3000000 \
  GAME_MAX_BETS_PER_ROUND=200 \
  CLIENT_SEEDS="stratos_slot_1_00000001,stratos_slot_2_00000002,stratos_slot_3_00000003" \
  BOT_COUNT=0 \
  BOT_STAKE_MIN=100 \
  BOT_STAKE_MAX=10000 \
  BOT_ROUND_PAYOUT_CAP=0 \
  BOT_DAY_PAYOUT_CAP=0 \
  BOT_DISCLOSE=false \
  CHAT_ENABLED=false \
  CHAT_MAX_MESSAGE_LENGTH=500 \
  CHAT_RATE_LIMIT_PER_MINUTE=10 \
  CHAT_BLOCKED_PATTERNS="" \
  CHAT_RETENTION_DAYS=30 \
  PROVIDER_ADMIN_TOKEN="<long random bootstrap admin token>" \
  DEFAULT_OPERATOR_CODE=bingo251 \
  CONSOLE_TOKEN_SECRET="<the exact same value set on bingo-api>"
```

`OPERATOR_HMAC_SECRET` must equal the webhook secret of the provider record in the bingo
admin; it is never committed and never printed. `ALLOWED_PARENT_ORIGINS` is the
comma-separated list of origins allowed to iframe `/play`.

The new shared secret variables are:

| Variable | App | Purpose |
| --- | --- | --- |
| `CONSOLE_TOKEN_SECRET` | `bingo-api` and `bingo-crash` | Must be identical. Bingo signs short-lived provider-console tokens; the provider verifies the HMAC and operator scope. |
| `OPERATOR_HMAC_SECRET` | `bingo-crash` | Signs all wallet/rain callbacks for the bootstrap operator. Store the matching secret in Bingo’s provider record. |
| `PROVIDER_ADMIN_TOKEN` | `bingo-crash` | Bootstrap-only operator CLI/admin API token. Keep set on managed deployments and rotate it through Dokku config. |

Bot variables are display-only and never call the wallet:
`BOT_COUNT`, `BOT_STAKE_MIN`, `BOT_STAKE_MAX`, `BOT_ROUND_PAYOUT_CAP`,
`BOT_DAY_PAYOUT_CAP`, and `BOT_DISCLOSE`.

Chat variables control opt-in room chat: `CHAT_ENABLED`,
`CHAT_MAX_MESSAGE_LENGTH`, `CHAT_RATE_LIMIT_PER_MINUTE`,
`CHAT_BLOCKED_PATTERNS`, and `CHAT_RETENTION_DAYS`.
Chat is disabled by default. Rain currently uses the provider callback route
`POST /api/games/rain/<provider-code>/credit`; it credits Bingo ledger type
`RAIN_CREDIT` atomically and cannot reuse the settlement `win` callback.

Deploy and expose it:

```bash
git push dokku-crash main:main

dokku domains:add bingo-crash crash.example.com
dokku letsencrypt:enable bingo-crash
```

The image builds the client (`vite`) and then prunes devDependencies, so `tsx` must stay
a runtime dependency; `Procfile.games` runs `server.ts` directly through it.

First boot does everything itself; expect these log lines:

```
games-provider: boot drain { sent: 0, retried: 0, capped: 0, dead: 0 }
games-provider: boot recovery { abandonedRoundIds: [], refundedBets: 0, ... }
games-provider: recovery drain { ... }
games-provider: listening on 3001
games-provider: leadership acquired
```

Migrations run from `apps/games-provider/drizzle` at boot and the operator row is
upserted from the config every time. A `wallet rows need operator attention` line means
`DEAD`/`CAP_REJECTED` outbox rows exist: a payout or rollback was refused terminally and
needs a human (`dokku logs bingo-crash`).

Register the provider in the bingo admin (**Admin → Providers**):

1. Add provider: code `stratos`, kind `AGGREGATOR`, currency `ETB`, the win cap, and the
   same webhook secret as `OPERATOR_HMAC_SECRET`. Bingo shows the callback it signs:
   `POST https://api.example.com/games/callback/stratos` — that URL is what
   `OPERATOR_CALLBACK_URL` points at, and it must be reachable from `bingo-crash`.
2. Add game: external id `crash`, category `crash`, launch URL template
   `https://<crash-host>/play?token={token}&lang={lang}&currency={currency}`.
   To publish coin flip later, add external id `coinflip` and launch
   `https://<crash-host>/play?operator={operator}&game={game}&token={token}&lang={lang}&currency={currency}`.
3. Enable both. Players then get enabled games in the Mini App lobby.

Smoke test (writes rows, so it demands confirmation; recovery is global, so run it
before the provider is opened to players or against a staging database). A one-off
`dokku run` container gets no port mapping and can be handed `PORT=0`, which the
config rejects, so pass a real port explicitly:

```bash
dokku run bingo-crash env PORT=3001 SMOKE_CONFIRM=yes npm run games:smoke
```

The games provider now uses a Postgres advisory lock for the round/outbox leader and
LISTEN/NOTIFY for runtime state. Gateways may run more than one replica, but this HA
story should be staged before opening a second replica to players. During a rolling
deploy, keep `web=1` as the conservative default until failover and 20-cycle
reconciliation have been run in staging.

## Provider dashboard

The games provider has its own `/provider-console` page and protected
`/api/admin/operators*` API. Bingo staff does not share the provider’s bootstrap admin
token. From **Admin → Providers**, a SUPER_ADMIN can issue a short-lived, HMAC-signed
provider-console token for the selected provider. The token is scoped to either that
operator or all operators and expires after 10 minutes.

Until provider-owned staff accounts are introduced, provider operator staff should use
this Bingo-issued console-token path. `PROVIDER_ADMIN_TOKEN` remains only a
bootstrapping/on-call CLI mechanism and should not be shared with staff. Secrets are
never rendered in the console.

A public marketing/promotions website is not required for gameplay and is not deployed
with the provider yet. It should be a later separate app that consumes the public
catalogue and provider landing metadata, while mutations and admin auth remain inside
the provider/Bingo staff consoles.

