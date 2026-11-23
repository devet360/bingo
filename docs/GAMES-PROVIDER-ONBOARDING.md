# Games Provider Onboarding Runbook

This runbook adds an operator to `apps/games-provider` and links it to one
`apps/api`/`apps/web` deployment.

For the full operator administration workflow, see
[Games Provider Operator Administration](./GAMES-PROVIDER-OPERATOR-GUIDE.md). For
the wallet callback and launch contract required to connect another operator,
see the [Games Provider Integration Guide](./GAMES-PROVIDER-INTEGRATION.md).

## Prerequisites

- Provider Postgres is migrated and reachable.
- The Games Provider deployment's public API base URL is registered in Bingo
  **Super Admin → Games**.
- The Bingo API `CORS_ORIGINS` includes the public Bingo web origin.
- `CONSOLE_TOKEN_SECRET` matches between Bingo API and Games Provider.

## Recommended: create and link from Bingo

1. In **Super Admin → Games → Add provider**, choose **Games Provider V2 ·
   automatic secret and linking**. Enter the tenant code, display name and
   Games Provider deployment base URL.
2. Bingo creates the provider operator, generates the callback from the API
   host and allowed web origins from `CORS_ORIGINS`. The Games Provider
   generates the HMAC secret, and Bingo stores it automatically.
3. Use **Run probe**, then activate the operator when the probe succeeds.
4. In **Super Admin → Games**, add or enable games for the linked tenant code.

## CLI alternative: create an operator manually

Use the CLI only when you are not using the Bingo dashboard integration:

```bash
npm run operator -w @bingo/games-provider -- create \
  --code operator-code \
  --name "Operator Name" \
  --callback-url https://api.example.com/games/callback/operator-code \
  --origins https://app.example.com \
  --currency ETB \
  --locale en \
  --min-stake 100 \
  --max-stake 100000 \
  --max-win 3000000 \
  --max-bets 200 \
  --games crash
```

The CLI returns the HMAC secret once. Store it in Bingo's provider integration
with the same operator code.

## 2. Register games in bingo

In **Super Admin → Games**, create the games that should be visible for this
operator. Set the provider API base URL if it is not already registered, then
add each external game ID (such as `crash`). Bingo generates the launch URL from the provider base URL,
operator code, external game ID, and session details. Use the advanced custom
URL override only when the provider uses a non-standard launch route.

## 3. Probe and activate

```bash
npm run operator -w @bingo/games-provider -- probe --code operator-code
npm run operator -w @bingo/games-provider -- activate --code operator-code
```

Activation fails unless a signed probe has succeeded and at least one active
secret exists. The dashboard probe also verifies that Bingo and the Games
Provider are linked to the same operator code and generated secret.

## 4. Run a sandbox round

Create a staging player session, launch from `/games`, place the minimum allowed
stake, and verify:

- the session is bound to the expected operator and game;
- placement and win/rollback callbacks reconcile once;
- the provider round proof verifies;
- closing the frame ends the session.

Suspended or maintenance-mode operators must reject handshakes and sockets
before touching a wallet.

## 5. Rotate a secret

For a coordinated rotation and overlap, follow the
[operator administration guide](./GAMES-PROVIDER-OPERATOR-GUIDE.md).

```bash
npm run operator -w @bingo/games-provider -- rotate-secret --code operator-code
```

The new secret is printed once. Update both sides, probe again, and keep the
old secret available until in-flight wallet deliveries have drained.
