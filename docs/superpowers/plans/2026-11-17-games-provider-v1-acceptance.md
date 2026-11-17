# Games Provider V1 — acceptance run

**Plan:** `docs/superpowers/plans/2026-11-17-games-provider-v1.md` (Task 17)
**Date:** 2026-11-17
**Status:** local suites and browser E2E complete; deploy steps are owner-run and
remain open (see §4).

---

## 1. Suite run (local)

| Command | Result |
|---|---|
| `npm run test -w @bingo/api` | 56/56 pass, 0 fail |
| `npm run games:test` | 114/114 pass, 0 fail |
| `npm run typecheck` | clean (`tsc --noEmit`) |
| `npm run games:typecheck` | clean (`tsc -p tsconfig.json --noEmit`) |
| `npm run games:build` | green — `dist/client/index.html`, `/play/assets/index-r4VuazD9.js`, `/play/assets/index-Bqk5rIo6.css` |

Run from the repo root on Node 24 (package also supports 22).

## 1.1 Final whole-branch review fix round

The final review found no Critical issues and six Important; all were fixed in
`4955048` before merge:

- Bingo accepts `win`/`rollback` callbacks for `CLOSED`/expired sessions
  (`movementRequiresOpenSession`); `balance` and `bet` stay open-session-only.
  A win enqueued while bingo was down can no longer die as `DEAD`.
- `BetManager.place` enforces the operator-signed session `minStake`/`maxStake`
  instead of provider config only.
- A 60 s runtime sweep (`reconcileUnresolvedBets`) replays `UNRESOLVED` bets, so
  a flaky wallet no longer strands a stake until restart. Policy made explicit:
  an indeterminate placement is refunded even when its round crashed.
- The boot anti-join is one `NOT EXISTS` statement (the old `inArray` probe
  would exceed Postgres' bind-parameter ceiling on a large history).
- Player-facing socket errors carry stable codes mapped to EN/AM strings.
- Dead `wallet_calls` table dropped (migration `0001`), unused `pino`/`motion`
  removed, stepper/countdown/`COUNT(*)` minors cleaned up.
- One provably-fair vector is asserted by both the server and browser verifiers.
- The guarded smoke gained one full round (place → cash out at 2.37 → crash →
  settle → WIN outbox row), still without calling bingo.

## 2. Browser E2E (local harness, headless Chrome over CDP)

The local environment has no Postgres/Docker, so the client ran against
`startTestServer` with a fake bingo wallet, the memory store, and a real
`OutboxWorker`. The in-app browser is `visibilityState: hidden` (rAF frozen),
so verification used headless Chrome driven over the DevTools protocol.

| Check | Evidence |
|---|---|
| Betting screen, two panels, countdown ticking | countdown sampled 4.6 → 3.3 → 2.3 → 1.3 → 0.3 s |
| Flight + crash | tick stream to 1.03x, `round:crashed` |
| Manual cash-out | "WON +10.00 ETB"; balance 890.20 → 880.20 → 890.20 |
| Auto cash-out | "WON +10.10 ETB", balance 960.20 |
| Losing round | "Lost", stake only in balance |
| Cancel during betting | "Cancelled — stake refunded"; balance 900.20 → 910.20 |
| Provably-fair proof | round #257 verified in-browser ("Verified authentic in your browser") |
| Reconnect / session restore | snapshot carries own bets per panel (socket test + socket.ts snapshot) |
| EN + AM | Amharic UI renders (ክራሽ, የቅርብ ጊዜ ዙሮች, SHA-256 ቁርጠኝነት, ተሸንፈዋል) |
| Theme + haptic bridge | parent posts theme+locale at iframe load: CSS vars + light scheme applied, Amharic active, `bingo:haptic {payload:'tap'}` received |
| CSP framing | `frame-ancestors` rejects a parent origin outside `ALLOWED_PARENT_ORIGINS` |
| 360 px width | layout is a single column at `sm` breakpoint; no horizontal scroll observed |

Screenshots (git-ignored workspace): `verify-1-betting.png`, `verify-4-proof.png`,
`verify-6-cashout.png`, `verify-8-auto-cashout.png`, `verify-10-bridge-early.png`,
`verify-11-cancel.png`, `verify-12-cashout.png`, `verify-13-lost.png`.

## 3. Not reproducible locally

- Production Postgres store and migrations (needs a real database).
- `npm run games:smoke` (guarded by `SMOKE_CONFIRM`, needs the deployed app + DB).
- Interrupted-round boot recovery against a live wallet (`kill mid-flight`).
- Telegram Mini App embedding, lobby handoff, and bingo-side history rows.

## 4. Owner-run steps (open)

Deployment is owner-run. Exact commands:

**4.1 Deploy bingo (api + web)** — `docs/DEPLOY.md` §2 and §6:

```bash
git push dokku-api main
git push dokku-web main
dokku ps:scale bingo-api web=1 worker=1 bot=1 support-bot=1
```

**4.2 Deploy the provider** — `docs/DEPLOY.md` §12 (create app once, then push):

```bash
dokku apps:create bingo-crash
dokku postgres:create bingo-crash-db
dokku postgres:link bingo-crash-db bingo-crash
dokku builder-dockerfile:set bingo-crash dockerfile-path Dockerfile.games
dokku ps:set bingo-crash procfile-path Procfile.games
dokku ports:set bingo-crash http:80:3001
dokku ps:scale bingo-crash web=1
git remote add dokku-crash dokku@YOUR_VPS:bingo-crash   # once
# then set the config from §12 (DATABASE_URL is linked; set OPERATOR_*,
# ALLOWED_PARENT_ORIGINS, GAME_* limits; OPERATOR_HMAC_SECRET must equal the
# provider's webhookSecret in bingo admin)
git push dokku-crash main
```

Then run the guarded smoke against the deployed app (report numbers, not the
secret). Boot applies migration `0001` (drops the unused `wallet_calls` table);
the smoke now also plays one full round through the store:

```bash
dokku run bingo-crash env PORT=3001 SMOKE_CONFIRM=yes npm run games:smoke
```

**4.3 Register provider + game in bingo admin**

- Provider: code `stratos`, kind matching the other integrated providers,
  currency `ETB`, `webhookSecret` = `OPERATOR_HMAC_SECRET`, `apiBaseUrl` =
  provider origin.
- Game: `externalId` `crash`, name `Crash`, category `Crash`,
  `launchUrlTemplate`
  `https://<crash-host>/play?token={token}&lang={lang}&currency={currency}`,
  minStake `100`, maxStake `100000`, maxWin `3000000`, enabled.

**4.4 Manual checklist in Telegram** — record pass/fail for each:

| # | Check | Local evidence | Deployed |
|---|---|---|---|
| 1 | Launch from lobby; iframe fills the screen; theme matches | iframe + theme verified in harness | pending |
| 2 | Bet, cash out ~2x; bingo history shows bet + win, same amounts | cash-out verified; bingo history is bingo-side | pending |
| 3 | Lose a round; only the bet appears | "Lost" verified | pending |
| 4 | Cancel during betting; refund appears | "Cancelled — stake refunded", refund verified | pending |
| 5 | Close and reopen the game; session restores | snapshot restores per-panel bets | pending |
| 6 | Stop the provider mid-flight, start again; stakes refunded, new round | boot recovery unit-tested; live wallet pending | pending |
| 7 | Open a finished round's proof and verify it in the browser | verified locally (#257) | pending |
| 8 | Switch language in bingo; game strings switch | locale bridge verified (load-time post) | pending |
| 9 | 360 px width; no horizontal scroll | single-column layout at `sm` | pending |
| 10 | Set an auto cash-out, close the game before it fires; the win still lands in bingo history | settlement-after-close accepted by bingo (fix `4955048`) | pending |

## 5. Known gaps accepted for V1

- The Postgres store is not unit-tested (no local DB). The guarded smoke covers
  boot paths plus one full round (numeric round-trip, cash-out, settle, WIN
  outbox); the deployed run in §4.2 is the remaining evidence.
- `dokku ps:scale web=1` is a hard requirement (single instance; the engine is
  in-process).
- Some fairness-modal labels (`SHA-256:`, `SHA-512 →`) remain as algorithm
  tokens in both languages.
- Settlement callbacks for a user whose account was blocked or whose phone
  verification was revoked are still refused by bingo (`ACCOUNT_INACTIVE`,
  `PHONE_VERIFICATION_REQUIRED`) and surface as `DEAD` outbox rows for operator
  follow-up. Accepted for V1: rare, and visible in the log.
- `FlightCanvas` re-renders per animation frame during flight; a lower display
  cadence is a V1.x performance cleanup, not a correctness issue.
