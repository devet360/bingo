import type {
  AgentCommission,
  AgentPaymentAccount,
  AgentProfile,
  BingoCard,
  BingoClaim,
  BingoRoom,
  BingoRound,
  DepositRequest,
  LedgerAccount,
  LedgerEntry,
  RoundWinner,
  TransactionLedger,
  User,
  Wallet,
  WithdrawalRequest,
} from '@prisma/client';
import { parseCardCells } from '../game/types';
import { minorToWire } from './money';

export function serializeUser(user: User) {
  return {
    id: user.id,
    telegramId: user.telegramId?.toString() ?? null,
    telegramUsername: user.telegramUsername,
    phone: user.phone,
    email: user.email,
    phoneVerified: Boolean(user.phoneVerifiedAt),
    phoneVerifiedAt: user.phoneVerifiedAt,
    mustChangePassword: user.mustChangePassword,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    locale: user.locale,
    role: user.role,
    status: user.status,
    kycStatus: user.kycStatus,
    referralCode: user.referralCode,
    hasPassword: Boolean(user.passwordHash),
    createdAt: user.createdAt,
  };
}

export function serializeWallet(wallet: Wallet) {
  return {
    available: minorToWire(wallet.available),
    escrow: minorToWire(wallet.escrow),
    locked: minorToWire(wallet.locked),
    lifetimeDeposited: minorToWire(wallet.lifetimeDeposited),
    lifetimeWithdrawn: minorToWire(wallet.lifetimeWithdrawn),
    lifetimeWagered: minorToWire(wallet.lifetimeWagered),
    lifetimeWon: minorToWire(wallet.lifetimeWon),
  };
}

export function serializeLedger(
  ledger: TransactionLedger & {
    entries: Array<
      LedgerEntry & {
        account: Pick<LedgerAccount, 'code' | 'ownerKind' | 'ownerId'>;
      }
    >;
  },
) {
  return {
    id: ledger.id,
    kind: ledger.kind,
    refType: ledger.refType,
    refId: ledger.refId,
    memo: ledger.memo,
    createdAt: ledger.createdAt,
    entries: ledger.entries.map((entry) => ({
      accountCode: entry.account.code,
      ownerKind: entry.account.ownerKind,
      ownerId: entry.account.ownerId,
      amount: minorToWire(entry.amount),
      balanceAfter: minorToWire(entry.balanceAfter),
    })),
  };
}

export function serializePaymentAccount(account: AgentPaymentAccount) {
  return {
    id: account.id,
    method: account.method,
    provider: account.provider,
    accountName: account.accountName,
    accountNumber: account.accountNumber,
    instructions: account.instructions,
    minAmount: minorToWire(account.minAmount),
    maxAmount: minorToWire(account.maxAmount),
  };
}

export function serializeAgent(
  agent: AgentProfile & {
    user?: Pick<User, 'displayName' | 'avatarUrl'>;
    paymentAccounts?: AgentPaymentAccount[];
  },
  options: { includeBalances?: boolean } = {},
) {
  return {
    id: agent.id,
    agentCode: agent.agentCode,
    displayName: agent.user?.displayName,
    avatarUrl: agent.user?.avatarUrl ?? null,
    status: agent.status,
    tier: agent.tier,
    region: agent.region,
    city: agent.city,
    district: agent.district,
    isOnline: agent.isOnline,
    lastSeenAt: agent.lastSeenAt,
    ratingAvg: agent.ratingAvg.toString(),
    ratingCount: agent.ratingCount,
    completedDeposits: agent.completedDeposits,
    completedWithdrawals: agent.completedWithdrawals,
    depositCommissionBps: agent.depositCommissionBps,
    withdrawalCommissionBps: agent.withdrawalCommissionBps,
    autoDepositEnabled: agent.autoDepositEnabled,
    autoDepositThreshold: minorToWire(agent.autoDepositThreshold),
    paymentAccounts: agent.paymentAccounts?.map(serializePaymentAccount),
    ...(options.includeBalances
      ? {
          floatAvailable: minorToWire(agent.floatAvailable),
          floatEscrow: minorToWire(agent.floatEscrow),
          commissionEarned: minorToWire(agent.commissionEarned),
          perTxnLimit: minorToWire(agent.perTxnLimit),
          dailyDepositLimit: minorToWire(agent.dailyDepositLimit),
          dailyWithdrawalLimit: minorToWire(agent.dailyWithdrawalLimit),
        }
      : {}),
  };
}

export function serializeDeposit(deposit: DepositRequest) {
  return {
    id: deposit.id,
    code: deposit.code,
    status: deposit.status,
    method: deposit.method,
    amount: minorToWire(deposit.amount),
    creditedAmount: minorToWire(deposit.creditedAmount),
    agentProfileId: deposit.agentProfileId,
    paymentAccountId: deposit.paymentAccountId,
    providerCode: deposit.providerCode,
    receiptReference: deposit.receiptReference,
    receiptAccount: deposit.receiptAccount,
    verificationStatus: deposit.verificationStatus,
    verificationMessage: deposit.verificationMessage,
    verificationSource: deposit.verificationSource,
    autoVerified: deposit.autoVerified,
    verifiedAt: deposit.verifiedAt,
    externalRef: deposit.externalRef,
    receiptUrl: deposit.receiptUrl,
    playerNote: deposit.playerNote,
    agentNote: deposit.agentNote,
    expiresAt: deposit.expiresAt,
    claimedAt: deposit.claimedAt,
    settledAt: deposit.settledAt,
    createdAt: deposit.createdAt,
  };
}

export function serializeWithdrawal(withdrawal: WithdrawalRequest) {
  return {
    id: withdrawal.id,
    payoutCode: withdrawal.payoutCode,
    status: withdrawal.status,
    method: withdrawal.method,
    amount: minorToWire(withdrawal.amount),
    fee: minorToWire(withdrawal.fee),
    netAmount: minorToWire(withdrawal.netAmount),
    agentProfileId: withdrawal.agentProfileId,
    paymentAccountId: withdrawal.paymentAccountId,
    playerNote: withdrawal.playerNote,
    agentNote: withdrawal.agentNote,
    expiresAt: withdrawal.expiresAt,
    settledAt: withdrawal.settledAt,
    cancelledAt: withdrawal.cancelledAt,
    createdAt: withdrawal.createdAt,
  };
}

export function serializeCommission(commission: AgentCommission) {
  return {
    id: commission.id,
    kind: commission.kind,
    baseAmount: minorToWire(commission.baseAmount),
    bps: commission.bps,
    amount: minorToWire(commission.amount),
    depositId: commission.depositId,
    withdrawalId: commission.withdrawalId,
    createdAt: commission.createdAt,
  };
}

const REVEALED_ROUND_STATUSES = new Set(['COMPLETED', 'CANCELLED']);

export function serializeRoom(room: BingoRoom) {
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    variant: room.variant,
    stakePerCard: minorToWire(room.stakePerCard),
    maxCardsPerPlayer: room.maxCardsPerPlayer,
    minPlayersToStart: room.minPlayersToStart,
    rakeBps: room.rakeBps,
    allowedPatterns: room.allowedPatterns,
    status: room.status,
    timings: {
      purchaseWindowSecs: room.purchaseWindowSecs,
      lockWindowSecs: room.lockWindowSecs,
      drawIntervalMs: room.drawIntervalMs,
      claimWindowSecs: room.claimWindowSecs,
    },
    autoDaubEnabled: room.autoDaubEnabled,
  };
}

/** Public round view. Seeds stay hidden until the round is settled or cancelled. */
export function serializeRound(round: BingoRound) {
  const revealed = REVEALED_ROUND_STATUSES.has(round.status);
  return {
    id: round.id,
    roomId: round.roomId,
    roundNumber: round.roundNumber,
    status: round.status,
    variant: round.variant,
    stakePerCard: minorToWire(round.stakePerCard),
    rakeBps: round.rakeBps,
    allowedPatterns: round.allowedPatterns,
    serverSeedHash: round.serverSeedHash,
    serverSeed: revealed ? round.serverSeed : null,
    clientSeed: revealed ? round.clientSeed : null,
    clientSeedCount: round.clientSeedCount,
    nonce: round.nonce,
    rngVersion: round.rngVersion,
    ballOrder: revealed ? round.ballOrder : null,
    drawnBalls: round.drawnBalls,
    currentBall: round.currentBall,
    cardsSold: round.cardsSold,
    uniquePlayers: round.uniquePlayers,
    grossPot: minorToWire(round.grossPot),
    rakeAmount: minorToWire(round.rakeAmount),
    prizePool: minorToWire(round.prizePool),
    winningPattern: round.winningPattern,
    purchaseClosesAt: round.purchaseClosesAt,
    startedAt: round.startedAt,
    lastDrawAt: round.lastDrawAt,
    claimsOpenAt: round.claimsOpenAt,
    claimsCloseAt: round.claimsCloseAt,
    completedAt: round.completedAt,
    seedRevealedAt: round.seedRevealedAt,
  };
}

export function serializeCard(card: BingoCard) {
  return {
    id: card.id,
    roundId: card.roundId,
    cardIndex: card.cardIndex,
    stake: minorToWire(card.stake),
    variant: card.variant,
    cells: parseCardCells(card.cells),
    markedNumbers: card.markedNumbers,
    autoDaub: card.autoDaub,
    status: card.status,
    wonPattern: card.wonPattern,
    purchasedAt: card.purchasedAt,
  };
}

export function serializeClaim(claim: BingoClaim) {
  return {
    id: claim.id,
    roundId: claim.roundId,
    cardId: claim.cardId,
    pattern: claim.pattern,
    status: claim.status,
    rejectionReason: claim.rejectionReason,
    drawnSnapshot: claim.drawnSnapshot,
    claimedAt: claim.claimedAt,
    validatedAt: claim.validatedAt,
  };
}

export function serializeWinner(winner: RoundWinner) {
  return {
    id: winner.id,
    roundId: winner.roundId,
    cardId: winner.cardId,
    userId: winner.userId,
    pattern: winner.pattern,
    payout: minorToWire(winner.payout),
    isSplitPot: winner.isSplitPot,
  };
}
