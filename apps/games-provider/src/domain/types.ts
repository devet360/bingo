export type RoundStatus = 'BETTING' | 'FLYING' | 'CRASHED' | 'ABANDONED';
export type BetStatus =
  | 'PLACING'
  | 'ACTIVE'
  | 'CASHED'
  | 'LOST'
  | 'CANCELLED'
  | 'REJECTED'
  | 'UNRESOLVED';
export type OutboxType = 'WIN' | 'ROLLBACK';
export type OutboxStatus = 'PENDING' | 'SENT' | 'CAP_REJECTED' | 'DEAD';

export type OperatorStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED';

export interface OperatorLimits {
  minStake: bigint;
  maxStake: bigint;
  maxWin: bigint;
  maxBetsPerRound: number;
}

export interface BotConfig {
  enabled: boolean;
  count: number;
  stakeMin: bigint;
  stakeMax: bigint;
  roundPayoutCap: bigint;
  dayPayoutCap: bigint;
  disclose: boolean;
}

export interface ChatMessageRecord {
  id: string;
  operatorCode: string;
  roomId: string;
  sessionToken: string;
  body: string;
  isBot: false;
  createdAt: Date;
}

export interface RainEventRecord {
  id: string;
  operatorCode: string;
  amount: bigint;
  recipientCount: number;
  expiresAt: Date;
  fundingId: string | null;
  status: 'PENDING' | 'FUNDED' | 'CANCELLED';
  createdAt: Date;
}

export interface OperatorRecord {
  code: string;
  name: string;
  callbackUrl: string;
  currency: string;
  status: OperatorStatus;
  allowedOrigins: string[];
  localeDefault: 'en' | 'am';
  limits: OperatorLimits;
  enabledGames: string[];
  theme: Record<string, unknown> | null;
  botConfig?: BotConfig;
  maintenance: boolean;
  probeOkAt: Date | null;
  createdAt: Date;
}

export interface OperatorSecretRecord {
  operatorCode: string;
  version: number;
  secret: string;
  createdAt: Date;
  retiredAt: Date | null;
}

export interface SessionRecord {
  token: string;
  operatorCode: string;
  gameId: string;
  currency: string;
  minStake: bigint;
  maxStake: bigint;
  maxWin: bigint;
  maxBetsPerRound: number;
  displayBalance: bigint;
  status: 'OPEN' | 'CLOSED';
  createdAt: Date;
  lastHandshakeAt: Date;
}

export interface RoundRecord {
  id: number;
  operatorCode?: string;
  gameId?: string;
  serverSeed: string;
  serverSeedHash: string;
  clientSeedComposite: string | null;
  crashPoint: number | null;
  coinOutcome?: 'HEADS' | 'TAILS';
  status: RoundStatus;
  startedAt: Date;
  flewAt: Date | null;
  crashedAt: Date | null;
}

export interface BetRecord {
  id: string;
  roundId: number;
  operatorCode: string;
  sessionToken: string;
  panel: 0 | 1;
  stake: bigint;
  autoCashout: number | null;
  status: BetStatus;
  cashoutMultiplier: number | null;
  payout: bigint | null;
  betTxnId: string;
  winTxnId: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

export interface OutboxRecord {
  id: string;
  operatorCode: string;
  type: OutboxType;
  txnId: string;
  sessionToken: string;
  amount: bigint;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}
