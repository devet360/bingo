import { randomUUID } from 'node:crypto';
import type {
  BetRecord,
  OperatorRecord,
  OperatorSecretRecord,
  OutboxRecord,
  OutboxStatus,
  RoundRecord,
  SessionRecord,
} from '../domain/types';
import type { DashboardMetrics, NewBet, NewOutbox, NewRound, Store } from '../server/store';

export interface MemoryStoreOptions {
  /** Clock used for generated timestamps. Defaults to the real clock. */
  now?: () => Date;
}

export interface MemoryStoreSnapshot {
  operators: OperatorRecord[];
  sessions: SessionRecord[];
  rounds: RoundRecord[];
  bets: BetRecord[];
  outbox: OutboxRecord[];
}

export interface MemoryStore extends Store {
  /** Raw tables, for assertions in tests. */
  dump(): MemoryStoreSnapshot;
}

const UNSETTLED: readonly BetRecord['status'][] = ['PLACING', 'ACTIVE', 'UNRESOLVED'];

const betKey = (roundId: number, sessionToken: string, panel: number): string =>
  `${roundId}|${sessionToken}|${panel}`;
const outboxKey = (operatorCode: string, type: string, txnId: string): string =>
  `${operatorCode}|${type}|${txnId}`;
const clone = <T>(value: T): T => structuredClone(value);

export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const now = options.now ?? (() => new Date());
  const operators = new Map<string, OperatorRecord>();
  const operatorSecrets = new Map<string, OperatorSecretRecord>();
  const sessions = new Map<string, SessionRecord>();
  const rounds = new Map<number, RoundRecord>();
  const bets = new Map<string, BetRecord>();
  const betIds = new Map<string, string>();
  const outbox = new Map<string, OutboxRecord>();
  const outboxIds = new Map<string, string>();
  let nextRoundId = 0;

  return {
    async getOperator(code) {
      const row = operators.get(code);
      return row ? clone(row) : null;
    },
    async upsertOperator(operator) {
      operators.set(operator.code, clone(operator));
    },
    async listOperators() {
      return [...operators.values()].map(clone);
    },
    async listOperatorSecrets(operatorCode) {
      return [...operatorSecrets.values()]
        .filter((row) => row.operatorCode === operatorCode)
        .sort((a, b) => b.version - a.version)
        .map(clone);
    },
    async addOperatorSecret(operatorCode, secret) {
      const version =
        [...operatorSecrets.values()]
          .filter((row) => row.operatorCode === operatorCode)
          .reduce((max, row) => Math.max(max, row.version), 0) + 1;
      const row: OperatorSecretRecord = {
        operatorCode,
        version,
        secret,
        createdAt: now(),
        retiredAt: null,
      };
      operatorSecrets.set(`${operatorCode}|${version}`, row);
      return clone(row);
    },
    async retireOperatorSecret(operatorCode, version) {
      const key = `${operatorCode}|${version}`;
      const row = operatorSecrets.get(key);
      if (row) operatorSecrets.set(key, { ...row, retiredAt: now() });
    },

    async getSession(token) {
      const row = sessions.get(token);
      return row ? clone(row) : null;
    },
    async saveSession(session) {
      sessions.set(session.token, clone(session));
    },
    async closeSession(token) {
      const row = sessions.get(token);
      if (row) sessions.set(token, { ...row, status: 'CLOSED' });
    },
    async setSessionBalance(token, balance) {
      const row = sessions.get(token);
      if (row) sessions.set(token, { ...row, displayBalance: balance });
    },
    async listActiveSessionsByOperator(operatorCode) {
      return [...sessions.values()]
        .filter((row) => row.operatorCode === operatorCode && row.status === 'OPEN')
        .map(clone);
    },

    async createRound(input: NewRound) {
      const row: RoundRecord = {
        id: ++nextRoundId,
        operatorCode: input.operatorCode,
        gameId: input.gameId ?? 'crash',
        serverSeed: input.serverSeed,
        serverSeedHash: input.serverSeedHash,
        clientSeedComposite: null,
        crashPoint: null,
        status: 'BETTING',
        startedAt: input.startedAt,
        flewAt: null,
        crashedAt: null,
      };
      rounds.set(row.id, row);
      return clone(row);
    },
    async startFlight(id, input) {
      const row = rounds.get(id);
      if (!row) return;
      rounds.set(id, {
        ...row,
        crashPoint: input.crashPoint,
        clientSeedComposite: input.clientSeedComposite,
        flewAt: input.at,
        status: 'FLYING',
      });
    },
    async finishRound(id, input) {
      const row = rounds.get(id);
      if (!row) return;
      rounds.set(id, {
        ...row,
        status: input.status,
        crashedAt: input.at,
        coinOutcome: input.coinOutcome,
      });
    },
    async getRound(id) {
      const row = rounds.get(id);
      return row ? clone(row) : null;
    },
    async lastUnfinishedRound() {
      const open = [...rounds.values()].filter(
        (row) => row.status === 'BETTING' || row.status === 'FLYING',
      );
      const last = open.reduce<RoundRecord | null>(
        (acc, row) => (acc === null || row.id > acc.id ? row : acc),
        null,
      );
      return last ? clone(last) : null;
    },

    async insertBet(bet: NewBet) {
      const key = betKey(bet.roundId, bet.sessionToken, bet.panel);
      if (betIds.has(key)) {
        throw new Error(
          `Bet already exists for round ${bet.roundId}, session ${bet.sessionToken}, panel ${bet.panel}`,
        );
      }
      const row: BetRecord = { ...bet, id: randomUUID(), createdAt: now(), settledAt: null };
      bets.set(row.id, row);
      betIds.set(key, row.id);
      return clone(row);
    },
    async updateBet(id, patch) {
      const row = bets.get(id);
      if (row) bets.set(id, { ...row, ...patch });
    },
    async getBet(roundId, sessionToken, panel) {
      const id = betIds.get(betKey(roundId, sessionToken, panel));
      const row = id === undefined ? undefined : bets.get(id);
      return row ? clone(row) : null;
    },
    async listBetsForRound(roundId) {
      return [...bets.values()].filter((row) => row.roundId === roundId).map(clone);
    },
    async countBetsForRound(roundId) {
      return [...bets.values()].filter((row) => row.roundId === roundId).length;
    },
    async countBetsForRoundByOperator(roundId, operatorCode) {
      return [...bets.values()].filter(
        (row) => row.roundId === roundId && row.operatorCode === operatorCode,
      ).length;
    },
    async listUnsettledBets() {
      return [...bets.values()]
        .filter((row) => UNSETTLED.includes(row.status))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(clone);
    },
    async listSettledBetsMissingOutbox() {
      return [...bets.values()]
        .filter((bet) => {
          if (bet.status === 'CASHED') {
            return bet.winTxnId !== null && !outboxIds.has(outboxKey(bet.operatorCode, 'WIN', bet.winTxnId));
          }
          if (bet.status === 'CANCELLED') {
            return !outboxIds.has(outboxKey(bet.operatorCode, 'ROLLBACK', bet.betTxnId));
          }
          return false;
        })
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(clone);
    },

    async enqueueOutbox(entry: NewOutbox) {
      const key = outboxKey(entry.operatorCode, entry.type, entry.txnId);
      if (outboxIds.has(key)) return null;
      const at = now();
      const row: OutboxRecord = {
        ...entry,
        id: randomUUID(),
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: at,
        lastError: null,
        createdAt: at,
        updatedAt: at,
      };
      outbox.set(row.id, row);
      outboxIds.set(key, row.id);
      return clone(row);
    },
    async claimDueOutbox(at, limit) {
      return [...outbox.values()]
        .filter((row) => row.status === 'PENDING' && row.nextAttemptAt.getTime() <= at.getTime())
        .sort(
          (a, b) =>
            a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        )
        .slice(0, limit)
        .map(clone);
    },
    // Terminal transitions only: `attempts` counts retry rounds, so it is
    // owned exclusively by `rescheduleOutbox`.
    async markOutbox(id, status, error = null) {
      const row = outbox.get(id);
      if (!row) return;
      outbox.set(id, {
        ...row,
        status,
        lastError: error,
        updatedAt: now(),
      });
    },
    // Sole owner of `attempts`: one increment per retry round.
    async rescheduleOutbox(id, nextAttemptAt, error) {
      const row = outbox.get(id);
      if (!row) return;
      outbox.set(id, {
        ...row,
        status: 'PENDING',
        attempts: row.attempts + 1,
        nextAttemptAt,
        lastError: error,
        updatedAt: now(),
      });
    },
    async pendingOutboxCount() {
      return [...outbox.values()].filter((row) => row.status === 'PENDING').length;
    },
    async countOutboxByStatus(status: OutboxStatus) {
      return [...outbox.values()].filter((row) => row.status === status).length;
    },
    async getDashboardMetrics(operatorCode?: string): Promise<DashboardMetrics> {
      const cutoff = now().getTime() - 24 * 60 * 60 * 1000;
      const byOperator = (code: string) => operatorCode === undefined || code === operatorCode;
      const sessionRows = [...sessions.values()].filter((row) => byOperator(row.operatorCode));
      const roundRows = [...rounds.values()].filter((row) =>
        row.operatorCode === undefined
          ? operatorCode === undefined
          : byOperator(row.operatorCode),
      );
      const betRows = [...bets.values()].filter((row) => byOperator(row.operatorCode));
      const outboxRows = [...outbox.values()].filter((row) => byOperator(row.operatorCode));
      return {
        sessions: {
          total: sessionRows.length,
          active: sessionRows.filter((row) => row.status === 'OPEN').length,
        },
        rounds: {
          total: roundRows.length,
          last24Hours: roundRows.filter((row) => row.startedAt.getTime() >= cutoff).length,
          recent: [...roundRows]
            .sort((a, b) => b.id - a.id)
            .slice(0, 10)
            .map((row) => ({
              id: row.id,
              gameId: row.gameId ?? 'crash',
              status: row.status,
              crashPoint: row.crashPoint,
              ...(row.coinOutcome ? { coinOutcome: row.coinOutcome } : {}),
              startedAt: row.startedAt,
              crashedAt: row.crashedAt,
            })),
        },
        bets: {
          total: betRows.length,
          unsettled: betRows.filter((row) =>
            row.status === 'PLACING' || row.status === 'ACTIVE' || row.status === 'UNRESOLVED',
          ).length,
        },
        outbox: {
          pending: outboxRows.filter((row) => row.status === 'PENDING').length,
          dead: outboxRows.filter((row) => row.status === 'DEAD').length,
          capRejected: outboxRows.filter((row) => row.status === 'CAP_REJECTED').length,
          recent: [...outboxRows]
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            .slice(0, 10)
            .map((row) => ({
              type: row.type,
              status: row.status,
              amount: row.amount,
              attempts: row.attempts,
              updatedAt: row.updatedAt,
            })),
        },
      };
    },

    dump() {
      return {
        operators: [...operators.values()].map(clone),
        sessions: [...sessions.values()].map(clone),
        rounds: [...rounds.values()].map(clone),
        bets: [...bets.values()].map(clone),
        outbox: [...outbox.values()].map(clone),
      };
    },
  };
}
