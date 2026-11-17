export type GamePhase = 'BETTING' | 'FLYING' | 'CRASHED';
export type Lang = 'en' | 'am';

export type BetStatus =
  | 'PLACING'
  | 'ACTIVE'
  | 'CASHED'
  | 'LOST'
  | 'CANCELLED'
  | 'REJECTED'
  | 'UNRESOLVED';

export interface BetFrame {
  roundId: number;
  panel: 0 | 1;
  status: BetStatus;
  stake: string;
  autoCashout: number | null;
  cashoutMultiplier: number | null;
  payout: string | null;
}

export interface RoundHistoryItem { roundId: number; crashPoint: number }
export interface BetLimits { minStake: bigint; maxStake: bigint; maxWin: bigint }

export interface HandshakeData {
  sessionId: string;
  gameId: string;
  currency: string;
  balance: string;
  limits: { minStake: string; maxStake: string; maxWin: string };
  expiresAt: string;
}

export interface SnapshotFrame {
  type: 'snapshot';
  roundId: number | null;
  phase: GamePhase;
  multiplier: number;
  elapsedMs: number;
  bettingEndsInMs: number;
  serverSeedHash: string | null;
  balance: string;
  bets: [BetFrame | null, BetFrame | null];
}
export interface BettingFrame {
  type: 'round:betting';
  roundId: number;
  serverSeedHash: string;
  clientSeeds: string[];
  bettingEndsInMs: number;
}
export interface FlyingFrame {
  type: 'round:flying';
  roundId: number;
  serverSeedHash: string;
  multiplier: number;
  elapsedMs: number;
}
export interface TickFrame { type: 'round:tick'; roundId: number; multiplier: number; elapsedMs: number }
export interface CrashedFrame {
  type: 'round:crashed';
  roundId: number;
  crashPoint: number;
  serverSeed: string;
  serverSeedHash: string;
  clientSeedComposite: string | null;
  crashedAt: string;
}
export interface BetUpdateFrame extends BetFrame { type: 'bet:update' }
export interface BalanceFrame { type: 'balance:update'; balance: string }
export interface SessionEndedFrame { type: 'session:ended'; reason: string }
export interface ErrorFrame { type: 'error'; code: string; message: string }

export type ServerFrame =
  | SnapshotFrame | BettingFrame | FlyingFrame | TickFrame | CrashedFrame
  | BetUpdateFrame | BalanceFrame | SessionEndedFrame | ErrorFrame;
