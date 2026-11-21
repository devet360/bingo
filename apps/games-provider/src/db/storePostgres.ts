import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, notExists, or, sql } from 'drizzle-orm';
import type {
  BetRecord,
  BotConfig,
  OperatorRecord,
  OperatorSecretRecord,
  OutboxRecord,
  OutboxStatus,
  RoundRecord,
  SessionRecord,
} from '../domain/types';
import type { DashboardMetrics, NewBet, NewOutbox, NewRound, Store } from '../server/store';
import type { Database } from './index';
import { bets, operatorSecrets, operators, rounds, sessions, walletOutbox } from './schema';

type OperatorRow = typeof operators.$inferSelect;
type OperatorSecretRow = typeof operatorSecrets.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;
type RoundRow = typeof rounds.$inferSelect;
type BetRow = typeof bets.$inferSelect;
type OutboxRow = typeof walletOutbox.$inferSelect;

const UNSETTLED: readonly BetRecord['status'][] = ['PLACING', 'ACTIVE', 'UNRESOLVED'];

/**
 * Drizzle reads `numeric` columns as strings (Postgres sends them as text), but
 * the domain records carry numbers. `numeric(12,2)` values round-trip exactly
 * because both sides go through the same decimal representation.
 */
function numericToNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/** The domain keeps multipliers as numbers; Postgres wants the decimal text. */
function numberToNumeric(value: number): string {
  return value.toFixed(2);
}

function toPanel(value: number): 0 | 1 {
  if (value !== 0 && value !== 1) throw new Error(`Unexpected bet panel: ${value}`);
  return value;
}

function toSessionStatus(value: string): SessionRecord['status'] {
  if (value !== 'OPEN' && value !== 'CLOSED') throw new Error(`Unexpected session status: ${value}`);
  return value;
}

function toOperatorRecord(row: OperatorRow): OperatorRecord {
  const botConfig = row.botConfig;
  const decodedBotConfig = botConfig && typeof botConfig === 'object'
    ? {
        enabled: Boolean(botConfig.enabled),
        count: Number(botConfig.count),
        stakeMin: BigInt(String(botConfig.stakeMin)),
        stakeMax: BigInt(String(botConfig.stakeMax)),
        roundPayoutCap: BigInt(String(botConfig.roundPayoutCap)),
        dayPayoutCap: BigInt(String(botConfig.dayPayoutCap)),
        disclose: Boolean(botConfig.disclose),
      } satisfies BotConfig
    : undefined;
  return {
    code: row.code,
    name: row.name,
    callbackUrl: row.callbackUrl,
    currency: row.currency,
    status: row.status,
    allowedOrigins: [...row.allowedOrigins],
    localeDefault: row.localeDefault === 'am' ? 'am' : 'en',
    limits: {
      minStake: row.minStake,
      maxStake: row.maxStake,
      maxWin: row.maxWin,
      maxBetsPerRound: row.maxBetsPerRound,
    },
    enabledGames: [...row.enabledGames],
    theme: row.theme ?? null,
    botConfig: decodedBotConfig,
    maintenance: row.maintenance,
    probeOkAt: row.probeOkAt,
    createdAt: row.createdAt,
  };
}

function toOperatorSecretRecord(row: OperatorSecretRow): OperatorSecretRecord {
  return {
    operatorCode: row.operatorCode,
    version: row.version,
    secret: row.secret,
    createdAt: row.createdAt,
    retiredAt: row.retiredAt,
  };
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    token: row.token,
    operatorCode: row.operatorCode,
    gameId: row.gameId,
    currency: row.currency,
    minStake: row.minStake,
    maxStake: row.maxStake,
    maxWin: row.maxWin,
    maxBetsPerRound: row.maxBetsPerRound,
    displayBalance: row.displayBalance,
    status: toSessionStatus(row.status),
    createdAt: row.createdAt,
    lastHandshakeAt: row.lastHandshakeAt,
  };
}

function toRoundRecord(row: RoundRow): RoundRecord {
  return {
    id: row.id,
    operatorCode: row.operatorCode ?? undefined,
    gameId: row.gameId,
    serverSeed: row.serverSeed,
    serverSeedHash: row.serverSeedHash,
    clientSeedComposite: row.clientSeedComposite,
    crashPoint: numericToNumber(row.crashPoint),
    coinOutcome: row.coinOutcome === 'HEADS' || row.coinOutcome === 'TAILS'
      ? row.coinOutcome
      : undefined,
    status: row.status,
    startedAt: row.startedAt,
    flewAt: row.flewAt,
    crashedAt: row.crashedAt,
  };
}

function toBetRecord(row: BetRow): BetRecord {
  return {
    id: row.id,
    roundId: row.roundId,
    operatorCode: row.operatorCode,
    sessionToken: row.sessionToken,
    panel: toPanel(row.panel),
    stake: row.stake,
    autoCashout: numericToNumber(row.autoCashout),
    status: row.status,
    cashoutMultiplier: numericToNumber(row.cashoutMultiplier),
    payout: row.payout,
    betTxnId: row.betTxnId,
    winTxnId: row.winTxnId,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
  };
}

function toOutboxRecord(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    operatorCode: row.operatorCode,
    type: row.type,
    txnId: row.txnId,
    sessionToken: row.sessionToken,
    amount: row.amount,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Postgres-backed `Store`. This holds mirror/audit rows only: the operator's
 * wallet stays the authority for money, and every mutation here mirrors an
 * outcome the wallet already accepted (or will be reconciled by the outbox).
 */
export function createPostgresStore(db: Database): Store {
  return {
    async getOperator(code) {
      const rows = await db.select().from(operators).where(eq(operators.code, code)).limit(1);
      const row = rows[0];
      return row === undefined ? null : toOperatorRecord(row);
    },
    async upsertOperator(operator) {
      const values: typeof operators.$inferInsert = {
        code: operator.code,
        name: operator.name,
        callbackUrl: operator.callbackUrl,
        currency: operator.currency,
        status: operator.status,
        allowedOrigins: operator.allowedOrigins,
        localeDefault: operator.localeDefault,
        minStake: operator.limits.minStake,
        maxStake: operator.limits.maxStake,
        maxWin: operator.limits.maxWin,
        maxBetsPerRound: operator.limits.maxBetsPerRound,
        enabledGames: operator.enabledGames,
        theme: operator.theme,
        botConfig: operator.botConfig
          ? {
              enabled: operator.botConfig.enabled,
              count: operator.botConfig.count,
              stakeMin: operator.botConfig.stakeMin.toString(),
              stakeMax: operator.botConfig.stakeMax.toString(),
              roundPayoutCap: operator.botConfig.roundPayoutCap.toString(),
              dayPayoutCap: operator.botConfig.dayPayoutCap.toString(),
              disclose: operator.botConfig.disclose,
            }
          : null,
        maintenance: operator.maintenance,
        probeOkAt: operator.probeOkAt,
        createdAt: operator.createdAt,
      };
      await db
        .insert(operators)
        .values(values)
        .onConflictDoUpdate({
          target: operators.code,
          set: {
            name: values.name,
            callbackUrl: values.callbackUrl,
            currency: values.currency,
            status: values.status,
            allowedOrigins: values.allowedOrigins,
            localeDefault: values.localeDefault,
            minStake: values.minStake,
            maxStake: values.maxStake,
            maxWin: values.maxWin,
            maxBetsPerRound: values.maxBetsPerRound,
            enabledGames: values.enabledGames,
            theme: values.theme,
            botConfig: values.botConfig,
            maintenance: values.maintenance,
            probeOkAt: values.probeOkAt,
            createdAt: values.createdAt,
          },
        });
    },
    async listOperators() {
      const rows = await db.select().from(operators).orderBy(asc(operators.code));
      return rows.map(toOperatorRecord);
    },
    async listOperatorSecrets(operatorCode) {
      const rows = await db
        .select()
        .from(operatorSecrets)
        .where(eq(operatorSecrets.operatorCode, operatorCode))
        .orderBy(desc(operatorSecrets.version));
      return rows.map(toOperatorSecretRecord);
    },
    async addOperatorSecret(operatorCode, secret) {
      // One statement so two rotations cannot both read the same `max(version)`:
      // the version is computed by the INSERT's own SELECT rather than a round
      // trip. A concurrent pair still races on the composite primary key.
      const nextVersion = sql`(SELECT COALESCE(MAX(${operatorSecrets.version}), 0) + 1 FROM ${operatorSecrets} WHERE ${operatorSecrets.operatorCode} = ${operatorCode})`;
      const rows = await db
        .insert(operatorSecrets)
        .values({ operatorCode, version: nextVersion, secret })
        .returning();
      const row = rows[0];
      if (row === undefined) throw new Error('operator secret insert returned no row');
      return toOperatorSecretRecord(row);
    },
    async retireOperatorSecret(operatorCode, version) {
      await db
        .update(operatorSecrets)
        .set({ retiredAt: new Date() })
        .where(
          and(
            eq(operatorSecrets.operatorCode, operatorCode),
            eq(operatorSecrets.version, version),
          ),
        );
    },

    async getSession(token) {
      const rows = await db.select().from(sessions).where(eq(sessions.token, token)).limit(1);
      const row = rows[0];
      return row === undefined ? null : toSessionRecord(row);
    },
    async saveSession(session) {
      const values = toSessionRecord(session);
      await db
        .insert(sessions)
        .values(values)
        .onConflictDoUpdate({
          target: sessions.token,
          set: {
            operatorCode: values.operatorCode,
            gameId: values.gameId,
            currency: values.currency,
            minStake: values.minStake,
            maxStake: values.maxStake,
            maxWin: values.maxWin,
            maxBetsPerRound: values.maxBetsPerRound,
            displayBalance: values.displayBalance,
            status: values.status,
            createdAt: values.createdAt,
            lastHandshakeAt: values.lastHandshakeAt,
          },
        });
    },
    async closeSession(token) {
      await db.update(sessions).set({ status: 'CLOSED' }).where(eq(sessions.token, token));
    },
    async listActiveSessionsByOperator(operatorCode) {
      const rows = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.operatorCode, operatorCode), eq(sessions.status, 'OPEN')));
      return rows.map(toSessionRecord);
    },
    async setSessionBalance(token, balance) {
      await db
        .update(sessions)
        .set({ displayBalance: balance })
        .where(eq(sessions.token, token));
    },

    async createRound(input: NewRound) {
      const rows = await db
        .insert(rounds)
        .values({
          operatorCode: input.operatorCode ?? null,
          gameId: input.gameId ?? 'crash',
          serverSeed: input.serverSeed,
          serverSeedHash: input.serverSeedHash,
          status: 'BETTING',
          startedAt: input.startedAt,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) throw new Error('round insert returned no row');
      return toRoundRecord(row);
    },
    async startFlight(id, input) {
      await db
        .update(rounds)
        .set({
          crashPoint: numberToNumeric(input.crashPoint),
          clientSeedComposite: input.clientSeedComposite,
          flewAt: input.at,
          status: 'FLYING',
        })
        .where(eq(rounds.id, id));
    },
    async finishRound(id, input) {
      await db
        .update(rounds)
        .set({
          status: input.status,
          crashedAt: input.at,
          ...(input.coinOutcome ? { coinOutcome: input.coinOutcome } : {}),
        })
        .where(eq(rounds.id, id));
    },
    async getRound(id) {
      const rows = await db.select().from(rounds).where(eq(rounds.id, id)).limit(1);
      const row = rows[0];
      return row === undefined ? null : toRoundRecord(row);
    },
    async lastUnfinishedRound() {
      const rows = await db
        .select()
        .from(rounds)
        .where(inArray(rounds.status, ['BETTING', 'FLYING']))
        .orderBy(desc(rounds.id))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toRoundRecord(row);
    },

    async insertBet(bet: NewBet) {
      // No `onConflictDoNothing` here: `bets_round_session_panel` is the
      // duplicate-bet guard, so a conflict must surface as an error (the memory
      // store throws on the same condition).
      const rows = await db
        .insert(bets)
        .values({
          id: randomUUID(),
          roundId: bet.roundId,
          operatorCode: bet.operatorCode,
          sessionToken: bet.sessionToken,
          panel: bet.panel,
          stake: bet.stake,
          autoCashout: bet.autoCashout === null ? null : numberToNumeric(bet.autoCashout),
          status: bet.status,
          cashoutMultiplier:
            bet.cashoutMultiplier === null ? null : numberToNumeric(bet.cashoutMultiplier),
          payout: bet.payout,
          betTxnId: bet.betTxnId,
          winTxnId: bet.winTxnId,
          settledAt: null,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) throw new Error('bet insert returned no row');
      return toBetRecord(row);
    },
    async updateBet(id, patch) {
      const set: Partial<typeof bets.$inferInsert> = {};
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.cashoutMultiplier !== undefined) {
        set.cashoutMultiplier =
          patch.cashoutMultiplier === null ? null : numberToNumeric(patch.cashoutMultiplier);
      }
      if (patch.payout !== undefined) set.payout = patch.payout;
      if (patch.winTxnId !== undefined) set.winTxnId = patch.winTxnId;
      if (patch.settledAt !== undefined) set.settledAt = patch.settledAt;
      // Absent keys are left out of the SET clause entirely, so they keep their
      // stored value instead of being nulled (the memory store spreads the patch).
      if (Object.keys(set).length === 0) return;
      await db.update(bets).set(set).where(eq(bets.id, id));
    },
    async getBet(roundId, sessionToken, panel) {
      const rows = await db
        .select()
        .from(bets)
        .where(
          and(
            eq(bets.roundId, roundId),
            eq(bets.sessionToken, sessionToken),
            eq(bets.panel, panel),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toBetRecord(row);
    },
    async listBetsForRound(roundId) {
      const rows = await db
        .select()
        .from(bets)
        .where(eq(bets.roundId, roundId))
        .orderBy(asc(bets.createdAt));
      return rows.map(toBetRecord);
    },
    async countBetsForRound(roundId) {
      const rows = await db
        .select({ total: count() })
        .from(bets)
        .where(eq(bets.roundId, roundId));
      return rows[0]?.total ?? 0;
    },
    async countBetsForRoundByOperator(roundId, operatorCode) {
      const rows = await db
        .select({ total: count() })
        .from(bets)
        .where(and(eq(bets.roundId, roundId), eq(bets.operatorCode, operatorCode)));
      return rows[0]?.total ?? 0;
    },
    async listUnsettledBets() {
      const rows = await db
        .select()
        .from(bets)
        .where(inArray(bets.status, [...UNSETTLED]))
        .orderBy(asc(bets.createdAt));
      return rows.map(toBetRecord);
    },
    async listSettledBetsMissingOutbox() {
      // One anti-join rather than an `inArray` probe: a large settled history
      // would exceed Postgres' 65,535 bind-parameter ceiling.
      const delivered = notExists(
        db
          .select({ one: sql`1` })
          .from(walletOutbox)
          .where(
            and(
              eq(walletOutbox.operatorCode, bets.operatorCode),
              or(
                and(
                  eq(bets.status, 'CASHED'),
                  eq(walletOutbox.type, 'WIN'),
                  eq(walletOutbox.txnId, bets.winTxnId),
                ),
                and(
                  eq(bets.status, 'CANCELLED'),
                  eq(walletOutbox.type, 'ROLLBACK'),
                  eq(walletOutbox.txnId, bets.betTxnId),
                ),
              ),
            ),
          ),
      );
      const rows = await db
        .select()
        .from(bets)
        .where(
          and(
            // A CASHED bet without a win txn id has no key to reconcile.
            or(
              and(eq(bets.status, 'CASHED'), isNotNull(bets.winTxnId)),
              eq(bets.status, 'CANCELLED'),
            ),
            delivered,
          ),
        )
        .orderBy(asc(bets.createdAt));
      return rows.map(toBetRecord);
    },

    async enqueueOutbox(entry: NewOutbox) {
      const rows = await db
        .insert(walletOutbox)
        .values({
          id: randomUUID(),
          operatorCode: entry.operatorCode,
          type: entry.type,
          txnId: entry.txnId,
          sessionToken: entry.sessionToken,
          amount: entry.amount,
        })
        .onConflictDoNothing({
          target: [walletOutbox.operatorCode, walletOutbox.type, walletOutbox.txnId],
        })
        .returning();
      const row = rows[0];
      return row === undefined ? null : toOutboxRecord(row);
    },
    async claimDueOutbox(now, limit) {
      if (limit <= 0) return [];
      // V1 runs exactly one provider instance, so due rows are read without a
      // claim lease (no `FOR UPDATE SKIP LOCKED`, no status flip). This matches
      // the memory store, which Task 11's worker tests assert against; adding a
      // lease here would make production behave differently from the tests.
      const rows = await db
        .select()
        .from(walletOutbox)
        .where(and(eq(walletOutbox.status, 'PENDING'), lte(walletOutbox.nextAttemptAt, now)))
        .orderBy(asc(walletOutbox.nextAttemptAt), asc(walletOutbox.createdAt))
        .limit(limit);
      return rows.map(toOutboxRecord);
    },
    // Terminal transitions only: `attempts` counts retry rounds, so it is
    // owned exclusively by `rescheduleOutbox`.
    async markOutbox(id, status: OutboxStatus, error: string | null = null) {
      await db
        .update(walletOutbox)
        .set({ status, lastError: error, updatedAt: new Date() })
        .where(eq(walletOutbox.id, id));
    },
    // Sole owner of `attempts`: one increment per retry round.
    async rescheduleOutbox(id, nextAttemptAt, error) {
      await db
        .update(walletOutbox)
        .set({
          status: 'PENDING',
          attempts: sql`${walletOutbox.attempts} + 1`,
          nextAttemptAt,
          lastError: error,
          updatedAt: new Date(),
        })
        .where(eq(walletOutbox.id, id));
    },
    async pendingOutboxCount() {
      const rows = await db
        .select({ total: count() })
        .from(walletOutbox)
        .where(eq(walletOutbox.status, 'PENDING'));
      return rows[0]?.total ?? 0;
    },
    async countOutboxByStatus(status) {
      const rows = await db
        .select({ total: count() })
        .from(walletOutbox)
        .where(eq(walletOutbox.status, status));
      return rows[0]?.total ?? 0;
    },
    async getDashboardMetrics(operatorCode?: string): Promise<DashboardMetrics> {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const sessionScope = operatorCode === undefined
        ? undefined
        : eq(sessions.operatorCode, operatorCode);
      const roundScope = operatorCode === undefined
        ? undefined
        : eq(rounds.operatorCode, operatorCode);
      const betScope = operatorCode === undefined
        ? undefined
        : eq(bets.operatorCode, operatorCode);
      const outboxScope = operatorCode === undefined
        ? undefined
        : eq(walletOutbox.operatorCode, operatorCode);
      const [sessionTotal, activeSessionTotal, roundTotal, recentRoundRows, recentRoundTotal,
        betTotal, unsettledBetTotal, pendingOutboxTotal, deadOutboxTotal, cappedOutboxTotal,
        recentOutboxRows] = await Promise.all([
        db.select({ total: count() }).from(sessions).where(sessionScope),
        db.select({ total: count() }).from(sessions).where(
          and(sessionScope, eq(sessions.status, 'OPEN')),
        ),
        db.select({ total: count() }).from(rounds).where(roundScope),
        db.select({
          id: rounds.id,
          gameId: rounds.gameId,
          status: rounds.status,
          crashPoint: rounds.crashPoint,
          coinOutcome: rounds.coinOutcome,
          startedAt: rounds.startedAt,
          crashedAt: rounds.crashedAt,
        }).from(rounds)
          .where(roundScope)
          .orderBy(desc(rounds.id))
          .limit(10),
        db.select({ total: count() }).from(rounds).where(
          and(roundScope, gte(rounds.startedAt, since)),
        ),
        db.select({ total: count() }).from(bets).where(betScope),
        db.select({ total: count() }).from(bets).where(
          and(betScope, inArray(bets.status, [...UNSETTLED])),
        ),
        db.select({ total: count() }).from(walletOutbox).where(
          and(outboxScope, eq(walletOutbox.status, 'PENDING')),
        ),
        db.select({ total: count() }).from(walletOutbox).where(
          and(outboxScope, eq(walletOutbox.status, 'DEAD')),
        ),
        db.select({ total: count() }).from(walletOutbox).where(
          and(outboxScope, eq(walletOutbox.status, 'CAP_REJECTED')),
        ),
        db.select({
          type: walletOutbox.type,
          status: walletOutbox.status,
          amount: walletOutbox.amount,
          attempts: walletOutbox.attempts,
          updatedAt: walletOutbox.updatedAt,
        }).from(walletOutbox)
          .where(outboxScope)
          .orderBy(desc(walletOutbox.updatedAt))
          .limit(10),
      ]);
      return {
        sessions: {
          total: sessionTotal[0]?.total ?? 0,
          active: activeSessionTotal[0]?.total ?? 0,
        },
        rounds: {
          total: roundTotal[0]?.total ?? 0,
          last24Hours: recentRoundTotal[0]?.total ?? 0,
          recent: recentRoundRows.map((row) => ({
            id: row.id,
            gameId: row.gameId,
            status: row.status,
            crashPoint: numericToNumber(row.crashPoint),
            ...(row.coinOutcome === 'HEADS' || row.coinOutcome === 'TAILS'
              ? { coinOutcome: row.coinOutcome }
              : {}),
            startedAt: row.startedAt,
            crashedAt: row.crashedAt,
          })),
        },
        bets: {
          total: betTotal[0]?.total ?? 0,
          unsettled: unsettledBetTotal[0]?.total ?? 0,
        },
        outbox: {
          pending: pendingOutboxTotal[0]?.total ?? 0,
          dead: deadOutboxTotal[0]?.total ?? 0,
          capRejected: cappedOutboxTotal[0]?.total ?? 0,
          recent: recentOutboxRows,
        },
      };
    },
  };
}
