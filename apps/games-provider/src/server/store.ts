import type {
  BetRecord,
  OperatorRecord,
  OutboxRecord,
  OutboxStatus,
  RoundRecord,
  SessionRecord,
} from '../domain/types';

export type NewRound = Pick<RoundRecord, 'serverSeed' | 'serverSeedHash' | 'startedAt'>;
export type NewBet = Omit<BetRecord, 'id' | 'createdAt' | 'settledAt'>;
export type NewOutbox = Pick<
  OutboxRecord,
  'operatorCode' | 'type' | 'txnId' | 'sessionToken' | 'amount'
>;

export interface Store {
  getOperator(code: string): Promise<OperatorRecord | null>;
  upsertOperator(operator: OperatorRecord): Promise<void>;

  getSession(token: string): Promise<SessionRecord | null>;
  saveSession(session: SessionRecord): Promise<void>;
  closeSession(token: string): Promise<void>;
  setSessionBalance(token: string, balance: bigint): Promise<void>;

  createRound(input: NewRound): Promise<RoundRecord>;
  startFlight(id: number, input: { crashPoint: number; clientSeedComposite: string; at: Date }): Promise<void>;
  finishRound(id: number, input: { status: 'CRASHED' | 'ABANDONED'; at: Date }): Promise<void>;
  getRound(id: number): Promise<RoundRecord | null>;
  lastUnfinishedRound(): Promise<RoundRecord | null>;

  insertBet(bet: NewBet): Promise<BetRecord>;
  updateBet(id: string, patch: Partial<Pick<BetRecord, 'status' | 'cashoutMultiplier' | 'payout' | 'winTxnId' | 'settledAt'>>): Promise<void>;
  getBet(roundId: number, sessionToken: string, panel: 0 | 1): Promise<BetRecord | null>;
  listBetsForRound(roundId: number): Promise<BetRecord[]>;
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
}
