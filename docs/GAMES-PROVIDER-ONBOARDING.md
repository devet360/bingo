# Games Provider Onboarding Runbook

This runbook adds an operator to `apps/games-provider` and links it to one
`apps/api`/`apps/web` deployment.

## Prerequisites

- Provider Postgres is migrated and reachable.
- `PROVIDER_ADMIN_TOKEN` is set to a long random bootstrap token.
- The bingo staff console has registered a `GameProvider` row for the operator.
- The bingo callback URL and provider callback secret match.

## 1. Create the operator

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

Store the returned secret in bingo. It is shown once and must not be committed
to source control or documentation.

## 2. Register games in bingo

In the staff game-provider catalogue, create the games that should be visible
for this operator. Crash must use the launch template:

```text
https://games.example.com/play?operator={operator}&game={game}&token={token}&lang={lang}&currency={currency}
```

## 3. Probe and activate

```bash
npm run operator -w @bingo/games-provider -- probe --code operator-code
npm run operator -w @bingo/games-provider -- activate --code operator-code
```

Activation fails unless a signed probe has succeeded and at least one active
secret exists. A bad callback URL or mismatched secret cannot activate the
operator.

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

```bash
npm run operator -w @bingo/games-provider -- rotate-secret --code operator-code
```

Install the new secret in bingo during the overlap window, probe again, then
close the old secret through the provider administrative workflow after no
deliveries remain on the old version.
