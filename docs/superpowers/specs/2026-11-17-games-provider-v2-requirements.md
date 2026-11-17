# Games Provider — V2 Requirements

**Status:** awaiting review
**Date:** 2026-11-17
**Predecessor:** `2026-11-17-games-provider-design.md` (V1, implemented)
**Scope:** Requirements for the second release of `apps/games-provider`. This
document defines what V2 must do and how it will be accepted. It contains no
implementation decisions beyond the constraints V1 already fixed.

> V1 must be accepted first (`2026-11-17-games-provider-v1-acceptance.md` §4 is
> owner-run and still open). No V2 code, scaffolding or stubs exist or may be
> written until this document is reviewed, tested against, and explicitly
> approved.

---

## 1. Context

V1 ships one crash game for one operator, single instance, no bots, no chat,
no provider console. The wallet contract, provably-fair engine, outbox and
client bridge are in production shape. V2 is where the product becomes a
platform: multiple operators, more than one game, cosmetic life, and the
operational surfaces that make it sellable.

The V1 constraints that V2 must preserve:

- Bingo remains the only wallet. The provider never holds authoritative money.
- Money is `bigint` minor units end-to-end; the wire format is a decimal string.
- Every bet reaches a terminal wallet state; idempotency is keyed on the
  operator, transaction id and type.
- The crash point is derived only from the server seed and the published client
  seeds. Nothing in V2 may change that derivation for a given seed triple.
- Bingo-side changes stay additive: optional fields and new routes.

## 2. Goals

1. Run several operators on one deployment, each with its own branding,
   currency, limits, games and admin view, with provable isolation.
2. Ship a second game through a catalogue seam that reuses the session, wallet,
   outbox and recovery machinery.
3. Add bots as a display feature with hard exposure caps and zero wallet impact.
4. Add chat and rain with moderation and auditable funding.
5. Give operators a console for rounds, settlements, config, moderation and
   health, and the provider a superadmin view.
6. Remove the single-instance constraint without weakening settlement
   guarantees.

## 3. Non-goals (V2)

- A third or later game (the seam must make it cheap, but V2 ships one).
- Provider-hosted player accounts, deposits or withdrawals of any kind.
- Tournament or jackpot mechanics.
- Native mobile apps (the Flutter app is a separate track).
- Cross-operator leaderboards or shared liquidity.

---

## 4. Area A — Multi-operator foundation (prerequisite for everything else)

**Requirement A1 — Operator registry.** A first-class operator record exists
with: code, display name, currency, callback base URL, HMAC secret (versioned
for rotation), allowed parent origins, locale default, limits, enabled games,
theme, status (active/suspended).

**Requirement A2 — Session scoping.** Every session, bot assignment, chat
message, rain, admin query and wallet call is scoped to exactly one operator.
A session token from operator A can never be used, read or settled under
operator B.

**Requirement A3 — Per-operator callback isolation.** Each operator has its own
callback URL and secret. An outbox delivery signed for A is unusable by B
(signature domain includes the operator code). Secret rotation supports an
overlap window with two valid versions.

**Requirement A4 — Per-operator configuration.** Limits (stake, win, max bets
per round), enabled games, bot settings, theme, default locale, and
maintenance mode are configurable per operator without a redeploy.

**Acceptance A**
- Two operators run concurrently against two fake wallet endpoints; each
  wallet's ledger shows only its own transactions.
- Cross-tenant probe tests: session id, bet id, round id and admin query from
  operator A against operator B's context are rejected with a typed error and
  no data leak.
- Rotation test: deliveries succeed with old and new secret during the overlap
  window; the old secret fails after it closes.
- Config change takes effect on the next round without a restart.

**Decisions needed**
- Whether bingo's existing single provider row per operator is reused as the
  registry source, or the provider keeps its own registry and bingo remains a
  single callback consumer per operator.

---

## 5. Area B — Second game

**Requirement B1 — Game catalogue seam.** The provider exposes a game
catalogue (id, name, category, limits, launchable flag). The lobby can list
several games; each launch creates a session bound to one game.

**Requirement B2 — Shared plumbing, separate rules.** A new game reuses the
session lifecycle, wallet client, outbox, limits and recovery. It brings its
own round engine and client screen. Transaction ids are namespaced per game so
the callback idempotency key never collides across games.

**Requirement B3 — Isolation of failure.** One game crashing, draining, or
disabling its engine must not stall the other game's rounds or settlements.

**Requirement B4 — Provably fair parity.** Any game that uses chance must
publish enough data to re-derive its outcome in the browser, using the same
commit/reveal pattern (hash published during betting, seed revealed after
settlement).

**Acceptance B**
- Two games run concurrently on one deployment; a forced engine error in one
  leaves the other's rounds and settlements unaffected.
- Wallet transactions from both games appear distinguished in the callback
  ledger and reconcile to their game.
- A finished round of the new game verifies in the browser from its proof
  endpoint.

**Decision needed**
- Which game ships: coin-flip (fastest, reuses the two-panel shell), mines or
  plinko (grid interactions), or keno (number draw). Product decision; the
  requirement is only that the chosen game fits the seam.

---

## 6. Area C — Bots with exposure caps

**Requirement C1 — Bots are display-only.** Bots never call the wallet, never
appear in operator ledgers, never affect the outbox, and never appear in
per-player history. Their presence is cosmetic.

**Requirement C2 — No influence on outcomes.** Bot existence, count, stakes and
cash-out decisions must not affect the crash point, the client seeds, the
tick schedule or any real player's payout.

**Requirement C3 — Exposure caps.** Bot payouts are bounded per round and per
day by operator configuration. When a cap is reached, bots lose — they never
exceed it. Caps are enforced before a bot cash-out is applied, not after.

**Requirement C4 — Operator controls.** Bot count per round (including 0),
stake range, cash-out behaviour distribution, and caps are configurable per
operator and take effect without a redeploy. Bots can be disabled entirely.

**Requirement C5 — Honest presentation.** If the operator enables a bot
disclosure label, the UI can mark bot participants. The data model must make
that possible (a bot flag on the participant frame).

**Acceptance C**
- A run with bots produces zero wallet calls (asserted at the wallet client).
- With a cap configured, the sum of bot payouts in any round/day never exceeds
  it, across randomised simulation.
- Crash points for a fixed seed triple are identical with bots on and off.
- Disabling bots mid-deployment takes effect on the next round.

---

## 7. Area D — Chat and rain

**Requirement D1 — Chat.** Per-room, per-operator chat with: message length and
rate limits, a profanity/word filter, mute and ban controls, message retention
policy, and playback of recent messages on join. Chat is opt-in per operator.

**Requirement D2 — Rain.** An operator triggers a rain event (amount, number of
recipients, eligibility window). Recipients are active real players only, one
rain per player per event. Bots are never eligible.

**Requirement D3 — Auditable funding.** Every rain credit is traceable to an
operator-funded source and appears in the bingo ledger. The provider never
mints value; a rain that cannot be funded and recorded is cancelled.

**Requirement D4 — Legibility.** A rain event announces itself in chat and in
the game UI, shows its amount and expiry, and surfaces claim failures to the
player in plain language.

**Acceptance D**
- Chat limits and filters reject the configured patterns; muted users cannot
  post; retention removes old messages per policy.
- A rain event credits exactly the eligible recipients, once each, and every
  credit reconciles in the bingo ledger.
- A rain that exceeds the operator's funding or eligibility fails cleanly with
  no partial credits.
- No player-identifying data leaves the provider beyond what the operator
  already holds.

**Decision needed**
- The bingo-side mechanism for rain funding: a new operator-initiated credit
  route, an admin action, or a bonus balance. This must not reuse the `win`
  callback type, which is settlement of a bet.

---

## 8. Area E — Provider admin console

**Requirement E1 — Surfaces.** Two roles: operator admin (their own data) and
provider superadmin (all operators). Screens: rounds list with proof
inspection, sessions, settlements and outbox status (including DEAD and
CAP_REJECTED), config (limits, games, bots, theme, maintenance), chat
moderation, rain triggers, and an audit log.

**Requirement E2 — Authentication.** No Firebase. Staff authenticate through
the existing bingo staff identity or an equivalent signed, short-lived
credential. A console session is scoped to a role and an operator.

**Requirement E3 — Audit.** Every mutating action records actor, target,
before/after values and timestamp. Secrets are never displayed; only whether
they are set and their version.

**Requirement E4 — Operability.** Outbox health, round lag, session counts and
error rates are visible without reading logs, and can trigger an alert.

**Acceptance E**
- Operator admins see only their own operator's data; a cross-operator query is
  denied and logged.
- Every mutation appears in the audit log with actor and diff.
- Health views show a real DEAD/CAP_REJECTED backlog and clear it when resolved.

---

## 9. Area F — Multi-instance and HA

**Requirement F1 — Single leader, many gateways.** Round production runs under
a leader lock; any instance can serve handshakes and WebSocket clients. State
needed across instances (round state, bet intents, pushes) travels through a
shared channel.

**Requirement F2 — Exactly-once settlement.** A failover mid-round must not
double-charge, double-pay, or lose a charge. Idempotency keys remain the final
guard; leases and locks must never be the only guard.

**Requirement F3 — Recovery bounds.** After a leader failure, a new leader
starts within a defined window, refunds interrupted stakes per the V1 recovery
rules, and resumes rounds without reusing a round id.

**Requirement F4 — Zero-downtime deploys.** Deploying a new version drains
connections and hands leadership over without ending player sessions
abruptly.

**Acceptance F**
- Two instances running: kill the leader mid-flight; the surviving instance
  takes over, interrupted stakes are refunded exactly once, and wallet
  reconciliation shows no drift.
- Repeated failover simulation (at least 20 cycles) produces zero duplicate
  transactions.
- A rolling deploy ends with no dropped settlements.

**Decision needed**
- The coordination substrate (Postgres advisory locks and NOTIFY vs Redis) and
  the target recovery time. Bingo already runs Redis; the provider currently
  does not.

---

## 10. Area G — Onboarding additional operators

**Requirement G1 — Self-serve data entry.** An operator can be added with code,
currency, callback URL, secret, origins and limits, validated before it is
enabled.

**Requirement G2 — Onboarding verification.** A signed health probe confirms
the callback URL, secret and origin allowlist before the operator goes live.

**Requirement G3 — Runbook.** A documented onboarding runbook exists: create
operator, register games in bingo, set config, run the probe, run a sandbox
round, enable.

**Acceptance G**
- A new operator reaches a verified sandbox round using only the runbook.
- Enabling an operator with a bad secret or origin fails the probe and cannot
  start accepting players.

---

## 11. Cross-cutting requirements

1. **Money and idempotency** — all V1 invariants hold per operator and per game.
2. **Provable fairness** — every chance-based game publishes a browser-verifiable
   proof; seed derivation for existing games is unchanged.
3. **Localization** — EN and AM are required for every new player-facing string
   at the time the feature ships; operator-level defaults are supported.
4. **Observability** — structured logs, metrics for rounds/settlements/outbox,
   and alerts for DEAD/CAP_REJECTED, leader loss and drift.
5. **Security** — no secrets in the repo, tests or docs; per-operator secrets
   rotatable; admin surfaces require role-scoped auth; all inbound frames
   validated as today.
6. **Data retention** — chat and session retention are configurable and
   documented per operator.

## 12. Suggested sequencing

1. Area A (multi-operator foundation) — everything else depends on it.
2. Area G (onboarding) — proves A with a second operator early.
3. Area C (bots) — cosmetic, isolated, fast to validate.
4. Area B (second game) — the largest engine effort.
5. Area D (chat + rain) — needs the bingo funding decision.
6. Area E (console) — follows the features it exposes.
7. Area F (HA) — last, because it changes the runtime under everything else.

Sequencing may be re-cut after review; the ordering constraint that matters is
A before B–G, and E after the surfaces it exposes exist.

## 13. Open decisions (blocking review)

| # | Decision | Blocks |
|---|---|---|
| 1 | Operator registry lives in bingo, the provider, or both | A |
| 2 | Second game choice | B |
| 3 | Rain funding mechanism on the bingo side | D |
| 4 | Console auth source (bingo staff identity or signed credential) | E |
| 5 | Coordination substrate and recovery-time target | F |
| 6 | Bot disclosure label on/off by default | C |

## 14. Acceptance of the requirements themselves

Before implementation:

1. This document is reviewed and the six open decisions are answered.
2. Each area's acceptance criteria are turned into test cases (contract tests
   for isolation and idempotency first).
3. Only then does implementation start, area by area, with the V1 SDD process
   (task briefs, per-task review, whole-branch review).
