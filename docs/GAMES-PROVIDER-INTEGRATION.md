# Games Provider Integration Guide

This guide explains how another operator can connect a wallet-backed platform
to games served by `apps/games-provider`. The operator remains authoritative for
player balances; the Games Provider owns game sessions, rounds, and provably
fair outcomes.

## Architecture

1. The operator creates a short-lived game session and opens the Games Provider
   launch URL in a browser frame.
2. The Games Provider calls the operator's wallet callback for balance, bet,
   win, and rollback movements.
3. Every callback is HMAC authenticated. Movement transaction IDs must be
   idempotent so retries cannot debit or credit twice.
4. The operator returns signed balances, and the Games Provider uses its
   durable outbox to retry settlement callbacks.

## 1. Register the operator

Give the operator a unique code, public callback URL, allowed web origins,
currency, game IDs, and stake limits. Configure the same code in the Bingo
provider catalogue when using Bingo's provider integration: it is used in the
callback path and HMAC scope.

Create the record with the provider CLI:

```bash
npm run operator -w @bingo/games-provider -- create \
  --code partner01 \
  --name "Partner One" \
  --callback-url https://operator.example.com/games/callback/partner01 \
  --origins https://operator.example.com \
  --currency ETB \
  --locale en \
  --min-stake 100 \
  --max-stake 50000 \
  --max-win 1000000 \
  --max-bets 100 \
  --games crash
```

The command prints the HMAC secret once. Store it in the operator's secret
manager and never send it to the browser. The callback URL is used for the
probe and wallet requests; the probe is sent to the same URL with `/probe`
appended.

## 2. Launch a game session

Create a cryptographically random UUID session token, associate it with the
player and selected operator, and build the launch URL. Replace template
variables with URL-encoded values:

```text
https://games.example.com/play?operator=partner01&game=crash&token=<session-token>&lang=en&currency=ETB
```

For example, in Node.js use `crypto.randomUUID()` to generate the token.
The Games Provider handshake expects a UUID.

Supported template placeholders include `{token}`, `{sessionId}`,
`{operator}`, `{game}`, `{lang}`, and `{currency}`. Embed the URL in an iframe
from an origin listed in `ALLOWED_PARENT_ORIGINS`.

The provider calls the wallet callback with the session token before accepting
a bet. Treat session tokens as bearer credentials: use a short lifetime, do not
log them, and do not expose them outside the player launch flow.

## 3. Verify signed callbacks

The Games Provider sends the exact JSON request bytes and the
`x-provider-signature` header. Verify the HMAC using the configured operator
secret and provider code. Do not parse and re-serialize the body before
verification.

Node.js example:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isValidProviderSignature({ rawBody, signature, secret, providerCode }) {
  if (!rawBody || !signature) return false;
  const supplied = signature.replace(/^sha256=/, '').toLowerCase();
  const expected = createHmac('sha256', secret)
    .update(`${providerCode}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(supplied, 'hex');
  const b = Buffer.from(expected, 'hex');
  return /^[0-9a-f]{64}$/.test(supplied) && a.length === b.length && timingSafeEqual(a, b);
}
```

Use the request's raw body buffer, not the parsed object, for `rawBody`.
`providerCode` must be the same code configured for that operator and used in
the callback URL path.

## 4. Implement the wallet callback

The endpoint accepts JSON requests with these shapes:

```json
{ "type": "balance", "sessionId": "UUID", "nonce": "request-nonce" }
{ "type": "bet", "sessionId": "UUID", "txnId": "unique-id", "amount": "100", "roundId": "123" }
{ "type": "win", "sessionId": "UUID", "txnId": "unique-id", "amount": "200", "roundId": "123" }
{ "type": "rollback", "sessionId": "UUID", "txnId": "bet-id", "amount": "100", "roundId": "123" }
```

Amounts are positive integer minor units sent as decimal strings. The `txnId`
must be idempotent for each movement type. A retry of the same accepted
movement must return success without applying the ledger mutation again.

Movement response:

```json
{
  "data": {
    "accepted": true,
    "replayed": false,
    "balance": "9900"
  }
}
```

`balance` is the current wallet balance in minor units. Return `replayed: true`
when the transaction was already committed. Reject a duplicate transaction ID
if it is reused with different movement data. A win or rollback that settles an
already accepted bet must still be processed if the launch session has since
closed.

## 5. Sign balance replies

For `balance`, return the current wallet balance, currency, Unix timestamp in
seconds, and the request nonce. Sign the period-delimited values exactly as
shown:

```js
const timestamp = Math.floor(Date.now() / 1000);
const balance = String(balanceMinor);
const signature = createHmac('sha256', secret)
  .update(`${sessionId}.${currency}.${balance}.${timestamp}.${nonce}`)
  .digest('hex');

return {
  data: {
    currency,
    balance,
    timestamp,
    nonce,
    signature,
    minStake: String(minStakeMinor),
    maxStake: String(maxStakeMinor),
    maxWin: String(maxWinMinor),
  },
};
```

The balance signature is checked against the session ID, currency, balance,
timestamp, and nonce. Use the supplied nonce unchanged and respond promptly;
stale or malformed replies are rejected. Limits are optional, but when
provided they must be integer minor-unit strings.

## 6. Support the signed probe

Before activation, the Games Provider sends a non-monetary request to
`<callback-url>/probe`:

```json
{ "type": "probe", "operator": "partner01", "timestamp": 1795130000 }
```

Verify the signature in the same way as other callbacks and return any 2xx
response. Do not create a wallet transaction or change a balance for a probe.
After a successful probe, the operator can be activated.

## 7. Configure launch and settlement in Bingo

When integrating with Bingo:

1. In **Super Admin → Games**, create a provider entry with code
   `partner01`, the Games Provider base URL, currency, and the matching
   webhook secret.
2. Add the external game ID. Bingo generates the launch URL at launch from the
   provider's API base URL, provider code, external game ID, and session details. The
   standard Games Provider route is
   `/play?operator=<provider-code>&game=<external-id>&token=<session-token>&lang=<language>&currency=<currency>`.
   Use the advanced custom URL override only if the provider uses a
   non-standard launch route.

3. Probe and activate the operator in the Games Provider. Enable the provider
   and game in Bingo only after staging settlement checks pass.
4. In **Super Admin → Provider dashboard**, inspect recent rounds and wallet
   outbox deliveries. Keep an eye on pending, dead, and capped rows.

If embedding the provider dashboard in Bingo web, include the Bingo web origin
in the Games Provider `ALLOWED_PARENT_ORIGINS`. The Bingo API and Games Provider
must share `CONSOLE_TOKEN_SECRET`; it is separate from the per-operator wallet
HMAC secret.

## 8. Production checklist

- Keep HMAC secrets in a managed secret store and rotate them with an overlap
  window.
- Use TLS for callback and game URLs outside local development.
- Preserve raw callback bytes for signature validation.
- Use database transactions and unique idempotency keys for wallet movements.
- Do not reject committed wins or rollbacks because a session expired.
- Monitor the provider dashboard's unresolved bets and wallet outbox.
- Test timeout, duplicate callback, wallet rejection, operator suspension,
  maintenance mode, and provider restart scenarios in staging.
