/** Wire types mirroring `apps/api/src/lib/serializers.ts`. */

export type Role = 'PLAYER' | 'AGENT' | 'SUPPORT' | 'SUPER_ADMIN';
export type StaffRole = 'AGENT' | 'SUPPORT' | 'SUPER_ADMIN';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DELETED';
export type RoundStatus =
  | 'WAITING'
  | 'LOCKED'
  | 'PLAYING'
  | 'CLAIM_VERIFICATION'
  | 'RUNNER_UP'
  | 'COMPLETED'
  | 'CANCELLED';
export type CardStatus = 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'WON' | 'LOST' | 'REFUNDED';
export type Variant = 'US_75' | 'UK_90';
export type WinPattern = 'HORIZONTAL' | 'VERTICAL' | 'DIAGONAL' | 'FOUR_CORNERS' | 'FULL_HOUSE';
export type RoomMode = 'MAIN' | 'FAST';
export type ClaimPhase = 'MAIN' | 'RUNNER_UP';

export interface BonusTier {
  minCards: number;
  bonusCards: number;
}
export type PaymentMethod = 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'CASH' | 'CARD' | 'CRYPTO';
export type DepositStatus = 'PENDING' | 'PROCESSING' | 'CREDITED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED' | 'DISPUTED';
export type WithdrawalStatus =
  | 'ESCROWED'
  | 'PROCESSING'
  | 'SETTLED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'DISPUTED';
export type VerificationStatus = 'NOT_REQUIRED' | 'PENDING' | 'VERIFIED' | 'FAILED' | 'MANUAL';
export type VerificationSource = 'SERVER' | 'CLIENT' | 'RELAY';

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
  /** Restricted promo grant; becomes playable once wagering completes. */
  bonus: string;
  lifetimeDeposited: string;
  lifetimeWithdrawn: string;
  lifetimeWagered: string;
  lifetimeWon: string;
}

export interface PaymentAccount {
  id: string;
  method: PaymentMethod;
  provider: string | null;
  accountName: string;
  accountNumber: string;
  instructions: string | null;
  minAmount: string | null;
  maxAmount: string | null;
  isActive?: boolean;
}

export interface DepositLimits {
  /** Platform-wide floor in minor units. */
  minAmount: string;
  /** Platform-wide ceiling in minor units, or null when uncapped. */
  maxAmount: string | null;
}

export interface DepositProvider {
  code: string;
  name: string;
  method: PaymentMethod;
  requiresPhone: boolean;
  accountDigits: number | null;
  opaqueReference: boolean;
  clientSide: boolean;
  supported: boolean;
  enabled: boolean;
  sortOrder: number;
  instructions: string | null;
  refHint: string | null;
  refPattern: string | null;
  minAmount: string | null;
  maxAmount: string | null;
  parser: string | null;
  endpoint: string | null;
}

export interface ReceiptVerificationView {
  id: string;
  providerCode: string;
  providerName: string;
  reference: string;
  status: VerificationStatus;
  source: VerificationSource | null;
  amount: string | null;
  currency: string | null;
  senderName: string | null;
  senderAccount: string | null;
  receiverName: string | null;
  receiverAccount: string | null;
  transactionDate: string | null;
  transactionStatus: string | null;
  message: string | null;
  attempts: number;
  verifiedAt: string | null;
  createdAt: string;
  deposit: {
    code: string;
    amount: string;
    status: DepositStatus;
    autoVerified: boolean;
    player: { displayName: string; phone: string | null };
  } | null;
}

export interface VerifyReceiptResult {
  data: Deposit;
  verification: { status: VerificationStatus | string; message: string };
  autoCredited: boolean;
  needsClientFetch?: boolean;
}

export interface PayoutAccount {
  id: string;
  method: PaymentMethod;
  provider: string | null;
  accountName: string;
  accountNumber: string;
  isDefault: boolean;
  isActive: boolean;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface WithdrawalProof {
  id: string;
  withdrawalId: string;
  method: PaymentMethod;
  reference: string | null;
  paidAmount: string | null;
  currency: string;
  senderAccount: string | null;
  receiverAccount: string | null;
  paidAt: string | null;
  mediaAssetId: string | null;
  notes: string | null;
  status: VerificationStatus;
  message: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export type AgentTaskStatus = 'OFFERED' | 'CLAIMED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

export interface AgentTask {
  id: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  status: AgentTaskStatus;
  agentProfileId: string;
  agentCode?: string | null;
  depositId: string | null;
  withdrawalId: string | null;
  assignedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  slaDeadline: string | null;
  overdue: boolean;
  reassignCount: number;
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
  acceptingTasks: boolean;
  lastSeenAt: string | null;
  ratingAvg: string;
  ratingCount: number;
  completedDeposits: number;
  completedWithdrawals: number;
  depositCommissionBps: number;
  withdrawalCommissionBps: number;
  autoDepositEnabled: boolean;
  autoDepositThreshold: string | null;
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
  pressWindowSecs: number;
}

export interface Room {
  id: string;
  code: string;
  name: string;
  mode: RoomMode;
  variant: Variant;
  stakePerCard: string;
  fixedPrize: string | null;
  maxCardsPerPlayer: number;
  minPlayersToStart: number;
  rakeBps: number;
  allowedPatterns: WinPattern[];
  status: string;
  timings: RoomTimings;
  autoDaubEnabled: boolean;
  allowAutoBingoPress: boolean;
  runnerUpEnabled: boolean;
  runnerUpPrize: string | null;
  runnerUpWindowSecs: number;
  bonusTiers: BonusTier[];
}

export interface Round {
  id: string;
  roomId: string;
  roundNumber: number;
  status: RoundStatus;
  mode: RoomMode;
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
  fixedPrize: string | null;
  bonusCards: number;
  winningPattern: WinPattern | null;
  runnerUpEnabled: boolean;
  runnerUpPrize: string | null;
  runnerUpNumber: number | null;
  runnerUpOpensAt: string | null;
  runnerUpClosesAt: string | null;
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
  autoPress: boolean;
  isBonus: boolean;
  status: CardStatus;
  wonPattern: WinPattern | null;
  purchasedAt: string;
}

export interface Claim {
  id: string;
  roundId: string;
  cardId: string;
  pattern: WinPattern;
  phase: ClaimPhase;
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

export interface AdminBingoRoom {
  room: Room;
  round: Round | null;
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
  providerCode: string | null;
  receiptReference: string | null;
  receiptAccount: string | null;
  verificationStatus: VerificationStatus;
  verificationMessage: string | null;
  verificationSource: VerificationSource | null;
  autoVerified: boolean;
  verifiedAt: string | null;
  externalRef: string | null;
  receiptUrl: string | null;
  playerNote: string | null;
  agentNote: string | null;
  expiresAt: string;
  claimedAt: string | null;
  settledAt: string | null;
  createdAt: string;
  /** Present on player-facing responses when the payer's phone can fetch the bank page. */
  clientReceiptUrl?: string;
  agent?: {
    id: string;
    agentCode: string;
    displayName: string | null;
    avatarUrl: string | null;
    phone: string | null;
    telegramUsername: string | null;
    isOnline: boolean;
    autoDepositEnabled: boolean;
    autoDepositThreshold: string | null;
  } | null;
  paymentAccount?: PaymentAccount | null;
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
  payoutAccountId: string | null;
  proofRequired: boolean;
  playerNote: string | null;
  agentNote: string | null;
  holdAt: string | null;
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
  phase: ClaimPhase;
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
  payoutAccount: { accountName: string; accountNumber: string; provider: string | null } | null;
  proofs: WithdrawalProof[];
  task: { status: AgentTaskStatus; slaDeadline: string | null } | null;
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

// ─────────────────────────────── marketing / growth ───────────────────────────────

export type CampaignKind = 'BANNER' | 'POPUP';
export type CampaignAudience = 'ALL' | 'PLAYERS' | 'AGENTS';

export interface Campaign {
  id: string;
  kind: CampaignKind;
  audience: CampaignAudience;
  locale: string;
  title: string;
  body: string;
  imageUrl: string | null;
  linkUrl: string | null;
  linkLabel: string | null;
  enabled: boolean;
  priority: number;
  dismissHours: number;
  startsAt: string | null;
  endsAt: string | null;
  createdById: string | null;
  createdAt: string;
}

export type BonusKind = 'PROMO_CODE' | 'ADMIN_GRANT';
export type BonusStatus = 'ACTIVE' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';

export interface Bonus {
  id: string;
  kind: BonusKind;
  amount: string;
  wagered: string;
  target: string;
  multiplier: number;
  status: BonusStatus;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
  promotionId: string | null;
}

export interface BonusWithPlayer extends Bonus {
  playerName: string;
  playerPhone: string | null;
}

export interface BonusPromotion {
  id: string;
  code: string;
  name: string;
  percentBps: number | null;
  fixedAmount: string | null;
  maxBonus: string | null;
  minDeposit: string | null;
  wageringMultiplier: number;
  expiresInDays: number;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  createdAt: string;
}

export interface ReferralCommissionView {
  id: string;
  playerId: string;
  playerName: string | null;
  roundId: string | null;
  rakeBase: string;
  bps: number;
  amount: string;
  createdAt: string;
}

export interface ReferralOverview {
  code: string;
  inviteLink: string | null;
  commissionBps: number;
  referredCount: number;
  activeReferrals: number;
  totalEarned: string;
  recent: ReferralCommissionView[];
}

export interface AdminReferralRow {
  referrerId: string;
  referrerName: string | null;
  referrerPhone: string | null;
  payments: number;
  rakeBase: string;
  amount: string;
}

export type ProviderKind = 'NATIVE' | 'AGGREGATOR';

export interface GameProviderGame {
  id: string;
  externalId: string;
  name: string;
  category: string | null;
  thumbnailUrl: string | null;
  launchUrlTemplate: string | null;
  minStake: string | null;
  maxStake: string | null;
  maxWin: string | null;
  enabled: boolean;
  sortOrder: number;
}

export interface GameProvider {
  id: string;
  code: string;
  name: string;
  kind: ProviderKind;
  apiBaseUrl: string | null;
  hasSecret: boolean;
  currency: string;
  maxWin: string | null;
  enabled: boolean;
  sortOrder: number;
  config: unknown;
  createdAt: string;
  games: GameProviderGame[];
}

export interface ProviderCallbackLog {
  id: string;
  type: string;
  externalTxnId: string | null;
  externalSessionId: string | null;
  signatureValid: boolean | null;
  httpStatus: number;
  amount: string | null;
  currency: string | null;
  error: string | null;
  ip: string | null;
  payload: unknown;
  createdAt: string;
}

export interface ProviderTransaction {
  id: string;
  type: string;
  externalTxnId: string;
  status: string;
  amount: string;
  currency: string;
  ledgerId: string | null;
  user: { displayName: string; phone: string | null } | null;
  externalSessionId: string | null;
  createdAt: string;
}

export interface ProviderSession {
  id: string;
  providerId: string;
  gameId: string | null;
  externalSessionId: string;
  status: string;
  launchUrl: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface AdminSettings {
  referral: { commissionBps: number; minRakeToPay: string };
  bonus: { defaultWageringMultiplier: number; defaultExpiryDays: number };
  depositLimits: DepositLimits;
}

// ─────────────────────────────── support tickets ───────────────────────────────

export type SupportTicketStatus = 'OPEN' | 'PENDING' | 'RESOLVED' | 'CLOSED';
export type SupportTopic = 'DEPOSIT' | 'WITHDRAWAL' | 'ACCOUNT' | 'PAYMENTS' | 'OTHER';
export type SupportAuthor = 'PLAYER' | 'STAFF' | 'BOT' | 'SYSTEM';

export interface SupportTicket {
  id: string;
  code: string;
  playerId: string;
  topic: SupportTopic;
  status: SupportTicketStatus;
  locale: string;
  subject: string;
  assigneeId: string | null;
  claimedAt: string | null;
  resolvedAt: string | null;
  unreadForStaff: number;
  unreadForPlayer: number;
  lastMessageAt: string;
  lastPlayerMessageAt: string | null;
  lastStaffMessageAt: string | null;
  createdAt: string;
}

export interface SupportPlayerSummary {
  id: string;
  displayName: string;
  phone: string | null;
  telegramUsername: string | null;
  locale?: string;
  status?: string;
  createdAt?: string;
}

export interface SupportPreview {
  author: SupportAuthor;
  body: string;
  mediaAssetId: string | null;
  createdAt: string;
}

export interface SupportTicketRow extends SupportTicket {
  player: SupportPlayerSummary;
  assignee: { id: string; displayName: string } | null;
  /** Absent on the detail endpoint, which returns the full message list instead. */
  preview?: SupportPreview | null;
}

export interface SupportMessage {
  id: string;
  ticketId: string;
  author: SupportAuthor;
  authorUserId: string | null;
  body: string;
  mediaAssetId: string | null;
  deliveredAt: string | null;
  deliveryAttempts: number;
  deliveryError: string | null;
  createdAt: string;
}

export interface SupportWalletSnapshot {
  available: string;
  bonus: string;
  escrow: string;
  locked: string;
}

export interface SupportDepositRow {
  id: string;
  code: string;
  amount: string;
  status: string;
  method: string;
  createdAt: string;
}

export interface SupportWithdrawalRow {
  id: string;
  amount: string;
  netAmount: string;
  status: string;
  method: string;
  createdAt: string;
}

export interface SupportTicketDetail {
  ticket: SupportTicketRow;
  messages: SupportMessage[];
  wallet: SupportWalletSnapshot | null;
  deposits: SupportDepositRow[];
  withdrawals: SupportWithdrawalRow[];
}

