# Games Provider Operator Administration

This guide covers adding and operating a tenant in `apps/games-provider`. It is
for the Games Provider owner and staff; a tenant is called an **operator** in
the provider database.

For the wallet callback contract and integrating a separate operator platform,
see the [Games Provider Integration Guide](./GAMES-PROVIDER-INTEGRATION.md).

## 1. Prepare the deployment

Confirm that the Games Provider and Bingo API are deployed, use the expected
PostgreSQL database, and can reach each other's public endpoints. Set the
provider's `DATABASE_URL`, `OPERATOR_CODE`, `OPERATOR_CALLBACK_URL`,
`OPERATOR_HMAC_SECRET`, and `ALLOWED_PARENT_ORIGINS`.

The callback code is significant: `OPERATOR_CODE` must match the provider code
in the callback URL and in the Bingo **Admin → Games** provider record. The
signature covers this code as well as the raw request body.

For the Bingo super-admin embedded dashboard:

- Set the same `CONSOLE_TOKEN_SECRET` (at least 32 characters) on the Bingo API
  and Games Provider.
- Add the Bingo web application's origin to `ALLOWED_PARENT_ORIGINS` on the
  Games Provider, for example `https://app.example.com`. This lets the provider
  console be embedded by that site.
- Keep `PROVIDER_ADMIN_TOKEN` as a separate, long random CLI bootstrap token.
  Do not put it in a browser or expose it to operators.

## 2. Create an operator

Run the operator CLI from the repository root. The following example uses
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

1. Add a provider with code `bingo251` (the same value as `--code` above),
   the Games Provider public base URL, currency `ETB`, and the same webhook
   secret returned by the CLI.
2. Select each enabled provider game from the **Available provider game**
   selector. Bingo fills in the provider's default game ID, name, category and
   thumbnail. The name and thumbnail URL remain editable; upload a PNG, JPEG or
   WebP thumbnail when you want a custom image. Bingo generates the launch URL
   from the provider API base URL,
   provider code, external game ID, and session details at launch. The standard route is
   `/play?operator=<provider-code>&game=<external-id>&token=<session-token>&lang=<language>&currency=<currency>`.
   Use the **Advanced: custom launch URL** override only if a provider uses a
   non-standard route.

3. Keep the provider and each intended game disabled until the probe and
   staging checks below pass. Enable them from this page when ready to launch.

If the provider was created with code `stratos`, use `stratos` consistently for
the Games Provider operator code, callback path, and Bingo provider code. Do
not mix identifiers: the HMAC signature is scoped to the callback provider
code.

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

In Bingo web, open **Super Admin → Provider dashboard**, choose the registered
Games Provider, and refresh as needed. The dashboard is embedded from the
provider deployment and uses a short-lived token scoped to the provider owner.
It shows operator status, active sessions, recent rounds, unsettled bets, and
pending or terminal wallet outbox deliveries.

The owner dashboard also controls the bootstrap operator's enabled game IDs and
simulation bot settings. Changes are persisted and apply to the next crash round.
Bots are explicitly labelled as simulations and never place real bets or call
the wallet; they appear in Crash rounds only. Bootstrap `BOT_*` environment values are defaults only until an
owner-managed configuration is saved.

The provider catalogue shows only games enabled for the operator. Enable or
disable Crash and Coin Flip in the owner dashboard; game metadata and thumbnail
defaults are served by the Games Provider itself.

If the embedded page is blocked, verify that `ALLOWED_PARENT_ORIGINS` contains
the exact web origin (scheme and host, without a path), that the provider
`apiBaseUrl` is reachable over HTTPS, and that both deployments use the same
`CONSOLE_TOKEN_SECRET`.

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
| Dashboard iframe is blank | Check the Games Provider `ALLOWED_PARENT_ORIGINS`, API base URL, and shared `CONSOLE_TOKEN_SECRET`. |
| Provider starts but health checks fail | Inspect startup logs for migration failures before trying manual SQL changes. |
