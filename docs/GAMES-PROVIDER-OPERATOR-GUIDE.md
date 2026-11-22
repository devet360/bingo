# Games Provider Operator Administration

This guide covers adding and operating a tenant in `apps/games-provider`. It is
for the Games Provider owner and staff; a tenant is called an **operator** in
the provider database.

For the wallet callback contract and integrating a separate operator platform,
see the [Games Provider Integration Guide](./GAMES-PROVIDER-INTEGRATION.md).

## 1. Prepare the deployment

Confirm that the Games Provider and Bingo API are deployed, use the expected
PostgreSQL database, and can reach each other's public endpoints. For the
dashboard-managed setup, the only provider URL you enter in Bingo is the Games
Provider deployment URL, such as `https://stratos.example.com`. Bingo derives
the callback from the public Bingo API request host and reads allowed game
origins from its `CORS_ORIGINS` setting.

Create the tenant from **Super Admin → Provider dashboard → Operators → Add
operator**. Use the same code for the tenant and Bingo provider integration
(for example, `bingo251`). The Games Provider generates its HMAC secret, and
Bingo stores it automatically. No callback URL or HMAC secret needs to be
copied or typed for this flow.

### How is Bingo's Webhook secret set?

The HMAC/webhook secret signs game-wallet traffic. The dashboard-managed
workflow generates it on the Games Provider and saves it into Bingo
automatically. You do not need to see or copy it or type anything into Bingo's
Webhook secret field:

| Where | Value |
| --- | --- |
| Games Provider | Active HMAC secret for the operator code |
| Bingo **Admin → Games → provider with the same code** | The exact same value in **Webhook secret** |

Use the CLI only when setting up outside the Bingo dashboard:

- **Created with the Games Provider CLI:** copy the one-time secret printed by
  `operator create` into Bingo's **Webhook secret** for that same operator
  code. Enter the callback URL and allowed web origins in the CLI command too.
- **Rotating from the Provider dashboard:** use the dashboard's Rotate secret
  action; it synchronizes the new key and temporarily retains the previous
  key. Run a probe, then retire the previous key only after the probe succeeds.
- **Rotating with the CLI:** the CLI prints the new secret once. Update Bingo's
  **Webhook secret** to that exact value promptly, then run a probe. CLI
  rotation does not synchronize Bingo or preserve the previous secret there;
  use the dashboard rotation flow when you need managed overlap.

`OPERATOR_CALLBACK_URL` and `OPERATOR_HMAC_SECRET` are optional paired
environment settings for legacy env-seeded operators. Do not set them for a
dashboard-created operator. Changing an env bootstrap secret later does **not**
rotate an already stored secret. Remove the pair from deployment configuration
when moving an existing tenant to dashboard management so startup does not
reapply legacy connection settings.

`CONSOLE_TOKEN_SECRET` is a different key used for short-lived dashboard
authentication. It must be shared between the Bingo API and Games Provider,
but it must **not** be entered as Bingo's webhook secret.

For the Bingo super-admin provider dashboard:

- Set the same `CONSOLE_TOKEN_SECRET` (at least 32 characters) on the Bingo API
  and Games Provider.
- Include the Bingo web application's origin in Bingo API `CORS_ORIGINS`.
  The provider dashboard copies those origins into the operator configuration;
  no separate provider `ALLOWED_PARENT_ORIGINS` value is needed for it.
- Keep `PROVIDER_ADMIN_TOKEN` as a separate, long random CLI bootstrap token.
  Do not put it in a browser or expose it to operators.
- The interactive provider API reference is available at
  `https://<games-provider-host>/api/docs`; its OpenAPI JSON is at
  `/api/docs/openapi.json`. These routes do not need an additional environment
  variable.

## 2. Create an operator

The recommended setup is to create an operator from Bingo's Provider dashboard;
that automatically creates its Bingo integration and syncs its secret. For
standalone CLI setup, run the operator CLI from the repository root. The following example uses
`bingo251` as both the Games Provider operator code and the Bingo API provider
code:

```bash
npm run operator -w @bingo/games-provider -- create \
  --code bingo251 \
  --name "Bingo 251" \
  --callback-url https://api.example.com/games/callback/bingo251 \
  --origins https://app.example.com \
  --currency ETB \
  --locale en \
  --min-stake 100 \
  --max-stake 100000 \
  --max-win 3000000 \
  --max-bets 200 \
  --games crash,coinflip
```

Stake and payout limits are integer **minor units** (for example, `100` means
`1.00` in a currency with two decimal places). The CLI creates the operator in
`PENDING` state and prints its HMAC secret once. Store that value in the Bingo
API provider record as its webhook secret and in the Games Provider operator
secret store. Never paste secrets into documentation, tickets, or source
control.

`list`, `update`, `probe`, `activate`, `suspend`, and `rotate-secret` are also
available. Use `npm run operator -w @bingo/games-provider -- list` to inspect
the configured operator records.

## 3. Register the provider and games in Bingo

In the Bingo web **Super Admin → Games** page:

1. Add the Games Provider deployment with its public base URL, for example
   `https://stratos.example.com`. This is the provider's host address, not the
   Bingo API or web URL.
2. Create the operator from **Super Admin → Provider dashboard**. This creates
   the matching Bingo provider integration using the operator code and generated
   secret. Do not separately add a duplicate integration or type a callback URL.
3. Select each enabled provider game from the **Available provider game**
   selector. Bingo fills in the provider's default game ID, name, category and
   thumbnail. The name and thumbnail URL remain editable; upload a PNG, JPEG or
   WebP thumbnail when you want a custom image. Bingo generates the launch URL
   from the provider API base URL,
   provider code, external game ID, and session details at launch. The standard route is
   `/play?operator=<provider-code>&game=<external-id>&token=<session-token>&lang=<language>&currency=<currency>`.
   Use the **Advanced: custom launch URL** override only if a provider uses a
   non-standard route.

4. Keep each intended game disabled until the probe and staging checks below
   pass. The provider must be enabled to test a launch; enable individual games
   from this page only when they are ready to appear in the player lobby.

5. Use **Play** beside a game to open its generated launch URL in a new tab.
   This admin-only action launches a session for an active test player (not the
   signed-in admin), and can test a hidden game while its provider is enabled.
   Set `TEST_PLAYER_LOGIN_ENABLED=true` and create a test player from the
   Provider dashboard first. Test rounds use that account's configured
   starting balance and cannot deposit or withdraw.

Use the operator code consistently for the Games Provider tenant, Bingo
provider integration, callback path, and generated launch URL. The Games
Provider deployment URL can be shared by multiple Bingo provider integrations;
do not use the deployment label in place of the tenant code.

## 4. Probe, activate, and test

Run a signed, non-monetary probe and activate only after it succeeds:

```bash
npm run operator -w @bingo/games-provider -- probe --code bingo251
npm run operator -w @bingo/games-provider -- activate --code bingo251
```

The operator remains unavailable until its probe succeeds and an active secret
exists. In staging, verify all of the following before enabling public games:

- A player launch opens the expected game and is bound to the right operator.
- A balance request returns the expected currency and a valid signed balance.
- Bet, win, and rollback callbacks are idempotent and reflected once in the
  operator ledger.
- The game round proof is available after settlement.
- Closing or expiring a session does not block a previously committed win or
  rollback.
- The Bingo **Super Admin → Provider dashboard** shows the operator, recent
  rounds, unsettled bets, and wallet outbox state.

## 5. Use the provider dashboard

In Bingo web, open **Super Admin → Provider dashboard**. The native pages are
directly addressable at `/admin/provider/overview`,
`/admin/provider/operators`, `/admin/provider/settings`, and
`/admin/provider/test-player`. Choose the registered Games Provider connection.
The Bingo API proxies requests to the provider using a short-lived server-side
superadmin token; no provider bootstrap token is sent to the browser. The
dashboard shows operator status, active sessions, recent rounds, unsettled
bets, and pending or terminal wallet outbox deliveries.

The owner dashboard also controls the bootstrap operator's enabled game IDs and
simulation bot settings. Changes are persisted and apply to the next crash round.
Bots are explicitly labelled as simulations and never place real bets or call
the wallet; they appear in Crash rounds only. Bootstrap `BOT_*` environment values are defaults only until an
owner-managed configuration is saved.

The provider catalogue shows only games enabled for the operator. Enable or
disable Crash and Coin Flip in the owner dashboard; game metadata and thumbnail
defaults are served by the Games Provider itself.

If the embedded page is blocked, verify that Bingo API `CORS_ORIGINS` contains
the exact web origin (scheme and host, without a path), that the provider
`apiBaseUrl` is reachable over HTTPS, and that both deployments use the same
`CONSOLE_TOKEN_SECRET`. `ALLOWED_PARENT_ORIGINS` is only a fallback for older
or manually seeded operators.

## 6. Update configuration and rotate a secret

Use the operator CLI to update limits, allowed origins, enabled game IDs, or
maintenance mode:

```bash
npm run operator -w @bingo/games-provider -- update \
  --code bingo251 \
  --maintenance true \
  --games crash,coinflip
```

For secret rotation, coordinate both sides. `rotate-secret` prints the new
secret only once; install it in the provider and Bingo API using the secret
overlap process supported by your deployment, run a new probe, and confirm
wallet callbacks succeed before retiring the old key. Do not remove the last
working secret while bets or wallet deliveries are in flight.

To suspend an operator immediately:

```bash
npm run operator -w @bingo/games-provider -- suspend --code bingo251
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `OPERATOR_NOT_FOUND` | The `operator` query value, `OPERATOR_CODE`, and operator CLI `--code` must identify the same record. |
| Games selector is empty in Bingo | Match the Bingo provider code to the Games Provider operator code, enable Crash or Coin Flip for that operator, and deploy the current Games Provider and Bingo API versions. |
| Probe fails or callbacks return 401 | Compare the callback path code and HMAC secret on both sides; signatures use the exact raw request bytes. |
| `GAME_UNAVAILABLE` | Confirm the external game ID is listed in `enabledGames` and is enabled in Bingo. |
| Dashboard iframe is blank | Check Bingo API `CORS_ORIGINS`, the Games Provider API base URL, and shared `CONSOLE_TOKEN_SECRET`. |
| Provider starts but health checks fail | Inspect startup logs for migration failures before trying manual SQL changes. |
