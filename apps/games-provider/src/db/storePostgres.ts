import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type {
  BetRecord,
  OperatorRecord,
  OutboxRecord,
  OutboxStatus,
  RoundRecord,
  SessionRecord,
} from '../domain/types';
import type { NewBet, NewOutbox, NewRound, Store } from '../server/store';
import type { Database } from './index';
import { bets, operators, rounds, sessions, walletOutbox } from './schema';

type OperatorRow = typeof operators.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;
type RoundRow = typeof rounds.$inferSelect;
type BetRow = typeof bets.$inferSelect;
type OutboxRow = typeof walletOutbox.$inferSelect;

const UNSETTLED: readonly BetRecord['status'][] = ['PLACING', 'ACTIVE', 'UNRESOLVED'];

/** The outbox dedupe key, mirroring the `outbox_dedupe` unique constraint. */
const outboxKey = (operatorCode: string, type: string, txnId: string): string =>
  `${operatorCode}|${type}|${txnId}`;

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
  return {
    code: row.code,
    name: row.name,
    callbackUrl: row.callbackUrl,
    hmacSecret: row.hmacSecret,
    currency: row.currency,
    enabled: row.enabled,
  };
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    token: row.token,
    operatorCode: row.operatorCode,
    currency: row.currency,
    minStake: row.minStake,
    maxStake: row.maxStake,
    maxWin: row.maxWin,
    displayBalance: row.displayBalance,
    status: toSessionStatus(row.status),
    createdAt: row.createdAt,
    lastHandshakeAt: row.lastHandshakeAt,
  };
}

function toRoundRecord(row: RoundRow): RoundRecord {
  return {
    id: row.id,
    serverSeed: row.serverSeed,
    serverSeedHash: row.serverSeedHash,
    clientSeedComposite: row.clientSeedComposite,
    crashPoint: numericToNumber(row.crashPoint),
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
      const values = toOperatorRecord(operator);
      await db
        .insert(operators)
        .values(values)
        .onConflictDoUpdate({
          target: operators.code,
          set: {
            name: values.name,
            callbackUrl: values.callbackUrl,
            hmacSecret: values.hmacSecret,
            currency: values.currency,
            enabled: values.enabled,
          },
        });
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
            currency: values.currency,
            minStake: values.minStake,
            maxStake: values.maxStake,
            maxWin: values.maxWin,
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
        .set({ status: input.status, crashedAt: input.at })
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
    async listUnsettledBets() {
      const rows = await db
        .select()
        .from(bets)
        .where(inArray(bets.status, [...UNSETTLED]))
        .orderBy(asc(bets.createdAt));
      return rows.map(toBetRecord);
    },
    async listSettledBetsMissingOutbox() {
      const rows = await db
        .select()
        .from(bets)
        .where(inArray(bets.status, ['CASHED', 'CANCELLED']))
        .orderBy(asc(bets.createdAt));

      // Only terminal bets that name the txn id to reconcile can be repaired; a
      // CASHED bet without a win txn id has no key to look up.
      const candidates: Array<{ bet: BetRecord; key: string; txnId: string }> = [];
      for (const bet of rows.map(toBetRecord)) {
        if (bet.status === 'CASHED') {
          if (bet.winTxnId !== null) {
            candidates.push({ bet, key: outboxKey(bet.operatorCode, 'WIN', bet.winTxnId), txnId: bet.winTxnId });
          }
          continue;
        }
        candidates.push({
          bet,
          key: outboxKey(bet.operatorCode, 'ROLLBACK', bet.betTxnId),
          txnId: bet.betTxnId,
        });
      }
      if (candidates.length === 0) return [];

      // One probe for every candidate txn id; the rows that come back are the
      // reconciliation rows already written (at any status, since the unique
      // key is status-independent).
      const written = await db
        .select({
          operatorCode: walletOutbox.operatorCode,
          type: walletOutbox.type,
          txnId: walletOutbox.txnId,
        })
        .from(walletOutbox)
        .where(inArray(walletOutbox.txnId, candidates.map(({ txnId }) => txnId)));
      const existing = new Set(written.map((row) => outboxKey(row.operatorCode, row.type, row.txnId)));
      return candidates.filter(({ key }) => !existing.has(key)).map(({ bet }) => bet);
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
  };
}
