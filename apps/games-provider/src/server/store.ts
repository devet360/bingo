import type {
  BetRecord,
  OperatorRecord,
  OperatorSecretRecord,
  OutboxRecord,
  OutboxType,
  OutboxStatus,
  RoundRecord,
  RoundStatus,
  SessionRecord,
} from '../domain/types';

export type NewRound = Pick<RoundRecord, 'serverSeed' | 'serverSeedHash' | 'startedAt'> &
  Partial<Pick<RoundRecord, 'operatorCode' | 'gameId'>>;
export type NewBet = Omit<BetRecord, 'id' | 'createdAt' | 'settledAt'>;
export type NewOutbox = Pick<
  OutboxRecord,
  'operatorCode' | 'type' | 'txnId' | 'sessionToken' | 'amount'
>;

export interface DashboardRound {
  id: number;
  gameId: string;
  status: RoundStatus;
  crashPoint: number | null;
  coinOutcome?: 'HEADS' | 'TAILS';
  startedAt: Date;
  crashedAt: Date | null;
}

export interface DashboardOutboxEntry {
  type: OutboxType;
  status: OutboxStatus;
  amount: bigint;
  attempts: number;
  updatedAt: Date;
}

export interface DashboardMetrics {
  sessions: { total: number; active: number };
  rounds: { total: number; last24Hours: number; recent: DashboardRound[] };
  bets: { total: number; unsettled: number };
  outbox: {
    pending: number;
    dead: number;
    capRejected: number;
    recent: DashboardOutboxEntry[];
  };
}

export interface Store {
  getOperator(code: string): Promise<OperatorRecord | null>;
  upsertOperator(operator: OperatorRecord): Promise<void>;
  deleteOperatorIfUnused(
    code: string,
  ): Promise<'DELETED' | 'NOT_FOUND' | 'NOT_SUSPENDED' | 'HAS_HISTORY'>;
  listOperators(): Promise<OperatorRecord[]>;
  listOperatorSecrets(operatorCode: string): Promise<OperatorSecretRecord[]>;
  addOperatorSecret(operatorCode: string, secret: string): Promise<OperatorSecretRecord>;
  retireOperatorSecret(operatorCode: string, version: number): Promise<void>;

  getSession(token: string): Promise<SessionRecord | null>;
  saveSession(session: SessionRecord): Promise<void>;
  closeSession(token: string): Promise<void>;
  setSessionBalance(token: string, balance: bigint): Promise<void>;
  listActiveSessionsByOperator(operatorCode: string): Promise<SessionRecord[]>;

  createRound(input: NewRound): Promise<RoundRecord>;
  startFlight(id: number, input: { crashPoint: number; clientSeedComposite: string; at: Date }): Promise<void>;
  finishRound(id: number, input: {
    status: 'CRASHED' | 'ABANDONED';
    at: Date;
    coinOutcome?: 'HEADS' | 'TAILS';
  }): Promise<void>;
  getRound(id: number): Promise<RoundRecord | null>;
  lastUnfinishedRound(): Promise<RoundRecord | null>;

  insertBet(bet: NewBet): Promise<BetRecord>;
  updateBet(id: string, patch: Partial<Pick<BetRecord, 'status' | 'cashoutMultiplier' | 'payout' | 'winTxnId' | 'settledAt'>>): Promise<void>;
  getBet(roundId: number, sessionToken: string, panel: 0 | 1): Promise<BetRecord | null>;
  listBetsForRound(roundId: number): Promise<BetRecord[]>;
  countBetsForRound(roundId: number): Promise<number>;
  countBetsForRoundByOperator(roundId: number, operatorCode: string): Promise<number>;
  listUnsettledBets(): Promise<BetRecord[]>;
  /**
   * Terminal bets whose wallet reconciliation row was never written: a CASHED
   * bet without its WIN row, or a CANCELLED bet without its ROLLBACK row.
   */
  listSettledBetsMissingOutbox(): Promise<BetRecord[]>;

  enqueueOutbox(entry: NewOutbox): Promise<OutboxRecord | null>;
  claimDueOutbox(now: Date, limit: number): Promise<OutboxRecord[]>;
  markOutbox(id: string, status: OutboxStatus, error?: string | null): Promise<void>;
  rescheduleOutbox(id: string, nextAttemptAt: Date, error: string): Promise<void>;
  pendingOutboxCount(): Promise<number>;
  countOutboxByStatus(status: OutboxStatus): Promise<number>;
  getDashboardMetrics(operatorCode?: string): Promise<DashboardMetrics>;
}
