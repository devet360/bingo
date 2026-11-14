# Deploying to Dokku

Two apps share one repository and one build context:

| Dokku app | Image | Processes | Serves | Port |
| --- | --- | --- | --- | --- |
| `bingo-api` | `Dockerfile.api` | `web`, `worker`, `bot` (from `Procfile`) | REST + Socket.io + Swagger, BullMQ worker, Telegram bot | 4000 |
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
  OTP_HASH_PEPPER="<32+ chars>" \
  BOT_TOKEN="<telegram bot token>" \
  TELEGRAM_WEBAPP_URL="https://app.example.com" \
  TELEGRAM_BOT_USERNAME="<bot username without @>" \
  CORS_ORIGINS="https://app.example.com" \
  BINGO_ENGINE_ENABLED=true \
  WORKER_CONCURRENCY=2

dokku config:set bingo-web \
  NODE_ENV=production \
  API_URL="https://api.example.com" \
  SOCKET_URL="https://api.example.com" \
  TELEGRAM_BOT_USERNAME="<bot username without @>"
```

`API_URL`, `SOCKET_URL` and `TELEGRAM_BOT_USERNAME` are read at runtime by
`/config.js` in the web app, so they can be changed with a restart and no rebuild.
`CORS_ORIGINS` is a comma-separated allow-list and must contain every browser origin
that calls the API (the Mini App origin and any staff dashboard preview origin).

Dokku injects `PORT`, which the API honours (`API_PORT` overrides it for local runs).
Do not set `PORT` yourself.

## 6. Deploy

```bash
git remote add dokku-api dokku@YOUR_VPS:bingo-api
git remote add dokku-web dokku@YOUR_VPS:bingo-web

git push dokku-api main
git push dokku-web main
```

`Procfile` defines three processes. After the first deploy scale all of them:

```bash
dokku ps:scale bingo-api web=1 worker=1 bot=1
```

- `web` runs the API and Socket.io gateway — keep it at exactly one container.
  `RoundEngine` timers are in-process, and horizontal socket fan-out would need the
  Socket.io Redis adapter.
- `worker` owns the BullMQ sweep for expired deposits/withdrawals. It is safe to run
  more than one, but one is enough.
- `bot` long-polls Telegram. Run **exactly one** instance; two pollers hit
  `409 Conflict` and Telegram aborts the newer one (`dokku logs bingo-api -t bot`).

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

## 8. Access model

- **Players — Telegram only.** There is no web registration. A player opens the bot,
  shares their own contact once (`request_contact`) and the bot links the verified
  phone to their Telegram account. Purchases and withdrawals are blocked until
  `phoneVerifiedAt` is set. The Mini App signs in with Telegram `initData`.
- **Staff — web only.** Agents, support and super admins sign in on the web app with
  email/phone + password. They are rejected inside Telegram and cannot share a contact
  to verify a player account.
- First staff account comes from `admin:create` above. After that, a super admin uses
  **Admin → Staff** to provision AGENT/SUPPORT/SUPER_ADMIN accounts, reset passwords,
  suspend accounts and top up agent float. Every action is written to the audit log.
- Support gets read-only views of users, ledger transactions, deposits, withdrawals
  and agents (plus cancel-open-deposit/withdrawal actions). The full console lives at
  `/admin`; support staff land on `/support`.

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
| 502 from the proxy | Wrong `ports:set` mapping, or the process is not listening on `PORT`/4000. |
| `P1001` on `/ready` | `DATABASE_URL` missing; link the Postgres service. |
| Socket connects to `localhost` | `SOCKET_URL` not set on `bingo-web` (check `/config.js`). |
| `P1012`/engine error at boot | Prisma client generated for another libc; rebuild with `Dockerfile.api`. |
| Rounds never start | `BINGO_ENGINE_ENABLED` false, or API replicas scaled beyond one. |
| CORS error in browser | Add the page origin to `CORS_ORIGINS` and restart the API. |
| Bot exits with `409` / `TelegramError: Conflict` | More than one `bot` process is polling; scale `bot=1`. |
| Player sign-in shows no bot link | `TELEGRAM_BOT_USERNAME` missing on `bingo-web`; set it and restart. |
| Buy/withdraw says phone required | Player has not shared contact with the bot yet; send them `https://t.me/<bot>?start=verify`. |
| Staff cannot sign in from Telegram | Expected — staff must use a normal browser. |

## 11. Phase 6 (Flutter) impact

The Flutter app will be another client of the same API and Socket.io gateway. It needs
no new Dokku app: point it at `https://api.example.com` and authenticate with Telegram
`initData` after the same bot contact-share verification. Mobile HTTP clients are not
subject to browser CORS.
