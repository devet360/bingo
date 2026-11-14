/** Wire types mirroring `apps/api/src/lib/serializers.ts`. */

export type Role = 'PLAYER' | 'AGENT' | 'SUPPORT' | 'SUPER_ADMIN';
export type StaffRole = 'AGENT' | 'SUPPORT' | 'SUPER_ADMIN';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DELETED';
export type RoundStatus = 'WAITING' | 'LOCKED' | 'PLAYING' | 'CLAIM_VERIFICATION' | 'COMPLETED' | 'CANCELLED';
export type CardStatus = 'ACTIVE' | 'WON' | 'LOST' | 'REFUNDED';
export type Variant = 'US_75' | 'UK_90';
export type WinPattern = 'HORIZONTAL' | 'VERTICAL' | 'DIAGONAL' | 'FOUR_CORNERS' | 'FULL_HOUSE';
export type PaymentMethod = 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'CASH' | 'CARD' | 'CRYPTO';
export type DepositStatus = 'PENDING' | 'PROCESSING' | 'CREDITED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'DISPUTED';
export type WithdrawalStatus = 'ESCROWED' | 'SETTLED' | 'CANCELLED' | 'EXPIRED' | 'DISPUTED';

export interface User {
  id: string;
  telegramId: string | null;
  telegramUsername: string | null;
  phone: string | null;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  locale: string;
  role: Role;
  status: UserStatus;
  kycStatus: string;
  referralCode: string | null;
  hasPassword: boolean;
  phoneVerified: boolean;
  phoneVerifiedAt: string | null;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface Wallet {
  available: string;
  escrow: string;
  locked: string;
  lifetimeDeposited: string;
  lifetimeWithdrawn: string;
  lifetimeWagered: string;
  lifetimeWon: string;
}

export interface PaymentAccount {
  id: string;
  method: PaymentMethod;
  provider: string;
  accountName: string;
  accountNumber: string;
  instructions: string | null;
  minAmount: string | null;
  maxAmount: string | null;
}

export interface Agent {
  id: string;
  agentCode: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: string;
  tier: string;
  region: string;
  city: string | null;
  district: string | null;
  isOnline: boolean;
  lastSeenAt: string | null;
  ratingAvg: string;
  ratingCount: number;
  completedDeposits: number;
  completedWithdrawals: number;
  depositCommissionBps: number;
  withdrawalCommissionBps: number;
  paymentAccounts?: PaymentAccount[];
  floatAvailable?: string;
  floatEscrow?: string;
  commissionEarned?: string;
  perTxnLimit?: string;
  dailyDepositLimit?: string;
  dailyWithdrawalLimit?: string;
}

export interface RoomTimings {
  purchaseWindowSecs: number;
  lockWindowSecs: number;
  drawIntervalMs: number;
  claimWindowSecs: number;
}

export interface Room {
  id: string;
  code: string;
  name: string;
  variant: Variant;
  stakePerCard: string;
  maxCardsPerPlayer: number;
  minPlayersToStart: number;
  rakeBps: number;
  allowedPatterns: WinPattern[];
  status: string;
  timings: RoomTimings;
  autoDaubEnabled: boolean;
}

export interface Round {
  id: string;
  roomId: string;
  roundNumber: number;
  status: RoundStatus;
  variant: Variant;
  stakePerCard: string;
  rakeBps: number;
  allowedPatterns: WinPattern[];
  serverSeedHash: string;
  serverSeed: string | null;
  clientSeed: string | null;
  clientSeedCount: number;
  nonce: number;
  rngVersion: string;
  ballOrder: number[] | null;
  drawnBalls: number[];
  currentBall: number | null;
  cardsSold: number;
  uniquePlayers: number;
  grossPot: string;
  rakeAmount: string;
  prizePool: string;
  winningPattern: WinPattern | null;
  purchaseClosesAt: string | null;
  startedAt: string | null;
  lastDrawAt: string | null;
  claimsOpenAt: string | null;
  claimsCloseAt: string | null;
  completedAt: string | null;
  seedRevealedAt: string | null;
}

export interface RoomRoundSummary {
  id: string;
  roundNumber: number;
  status: RoundStatus;
  cardsSold: number;
  uniquePlayers: number;
  prizePool: string;
  currentBall: number | null;
  purchaseClosesAt: string | null;
}

export interface LobbyRoom {
  room: Room;
  round: RoomRoundSummary | null;
}

export interface CardGrid {
  variant: Variant;
  rows: number;
  cols: number;
  freeCenter: boolean;
  grid: Array<Array<number | null>>;
}

export interface Card {
  id: string;
  roundId: string;
  cardIndex: number;
  stake: string;
  variant: Variant;
  cells: CardGrid;
  markedNumbers: number[];
  autoDaub: boolean;
  status: CardStatus;
  wonPattern: WinPattern | null;
  purchasedAt: string;
}

export interface Claim {
  id: string;
  roundId: string;
  cardId: string;
  pattern: WinPattern;
  status: 'PENDING' | 'VALID' | 'INVALID';
  rejectionReason: string | null;
  drawnSnapshot: number[];
  claimedAt: string;
  validatedAt: string | null;
}

export interface RoomView {
  room: Room;
  round: Round | null;
  recentRounds: Round[];
}

export interface Deposit {
  id: string;
  code: string;
  status: DepositStatus;
  method: PaymentMethod;
  amount: string;
  creditedAmount: string;
  agentProfileId: string | null;
  paymentAccountId: string | null;
  externalRef: string | null;
  receiptUrl: string | null;
  playerNote: string | null;
  agentNote: string | null;
  expiresAt: string;
  claimedAt: string | null;
  settledAt: string | null;
  createdAt: string;
}

export interface Withdrawal {
  id: string;
  payoutCode: string;
  status: WithdrawalStatus;
  method: PaymentMethod;
  amount: string;
  fee: string;
  netAmount: string;
  agentProfileId: string | null;
  paymentAccountId: string | null;
  playerNote: string | null;
  agentNote: string | null;
  expiresAt: string;
  settledAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

export interface TransactionLine {
  id: string;
  account: string;
  amount: string;
  balanceAfter: string;
  kind: string;
  refType: string | null;
  refId: string | null;
  memo: string | null;
  ledgerId: string;
  createdAt: string;
}

export interface Commission {
  id: string;
  kind: 'DEPOSIT' | 'WITHDRAWAL';
  baseAmount: string;
  bps: number;
  amount: string;
  depositId: string | null;
  withdrawalId: string | null;
  createdAt: string;
}

export interface FloatRequest {
  id: string;
  direction: string;
  amount: string;
  method: PaymentMethod;
  externalRef: string | null;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
}

export interface SettlementWinner {
  userId: string;
  cardId: string;
  pattern: WinPattern;
  payout: string;
}

export interface SettlementEvent {
  roundId: string;
  winners: SettlementWinner[];
  rake: string;
  prizePool: string;
  serverSeed: string;
}

export interface RoundProof {
  roundId: string;
  variant: Variant;
  rngVersion: string;
  serverSeed: string;
  serverSeedHash: string;
  seedHashMatches: boolean;
  clientSeed: string | null;
  clientSeedCount: number;
  clientSeeds: Array<{ userId: string; clientSeed: string }>;
  nonce: number;
  ballOrder: number[];
  recomputedBallOrder: number[];
  committed: boolean;
  matches: boolean;
  drawnBalls: number[];
  alreadyDrawnMatch: boolean;
  status: RoundStatus;
}

// ─────────────────────────────── staff / back office ───────────────────────────────

export interface PageMeta {
  index: number;
  size: number;
  total: number;
}

export interface Paginated<T> {
  data: T[];
  page: PageMeta;
}

export interface LedgerEntryView {
  accountCode: string;
  ownerKind: string;
  ownerId: string;
  amount: string;
  balanceAfter: string;
}

export interface LedgerView {
  id: string;
  kind: string;
  refType: string | null;
  refId: string | null;
  memo: string | null;
  createdAt: string;
  entries: LedgerEntryView[];
}

export interface StaffDeposit extends Deposit {
  player: { displayName: string; phone: string | null };
  agentCode: string | null;
}

export interface StaffWithdrawal extends Withdrawal {
  player: { displayName: string; phone: string | null };
  agentCode: string | null;
}

export interface UserDetail {
  user: User;
  wallet: Wallet | null;
  agent: Agent | null;
  counts: { deposits: number; withdrawals: number; cards: number; wins: number };
  transactions: LedgerView[];
  deposits: Deposit[];
  withdrawals: Withdrawal[];
}

export interface AdminOverview {
  users: number;
  players: number;
  activeAgents: number;
  pendingDeposits: number;
  openWithdrawals: number;
  todayLedgers: number;
  liabilities: { available: string; escrow: string; locked: string };
}

export interface StaffMember extends User {
  agentProfile: { id: string; agentCode: string; status: string } | null;
}

export interface CreatedStaff {
  user: User;
  agent: Agent | null;
  temporaryPassword: string;
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}
