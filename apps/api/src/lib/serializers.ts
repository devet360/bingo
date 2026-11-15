import type {
  AgentCommission,
  AgentPaymentAccount,
  AgentProfile,
  AgentTask,
  BingoCard,
  BingoClaim,
  BingoRoom,
  BingoRound,
  DepositRequest,
  LedgerAccount,
  LedgerEntry,
  MediaAsset,
  RoundWinner,
  SupportMessage,
  SupportTicket,
  TransactionLedger,
  User,
  Wallet,
  WithdrawalProof,
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
    bonus: minorToWire(wallet.bonus),
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

export function serializePayoutAccount(account: {
  id: string;
  method: string;
  provider: string | null;
  accountName: string;
  accountNumber: string;
  isDefault: boolean;
  isActive: boolean;
  verifiedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: account.id,
    method: account.method,
    provider: account.provider,
    accountName: account.accountName,
    accountNumber: account.accountNumber,
    isDefault: account.isDefault,
    isActive: account.isActive,
    verifiedAt: account.verifiedAt,
    lastUsedAt: account.lastUsedAt,
    createdAt: account.createdAt,
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
    acceptingTasks: agent.acceptingTasks,
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
    payoutAccountId: withdrawal.payoutAccountId,
    proofRequired: withdrawal.proofRequired,
    playerNote: withdrawal.playerNote,
    agentNote: withdrawal.agentNote,
    holdAt: withdrawal.holdAt,
    expiresAt: withdrawal.expiresAt,
    settledAt: withdrawal.settledAt,
    cancelledAt: withdrawal.cancelledAt,
    createdAt: withdrawal.createdAt,
  };
}

export function serializeCommission(commission: AgentCommission) {  return {
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
    mode: room.mode,
    variant: room.variant,
    stakePerCard: minorToWire(room.stakePerCard),
    fixedPrize: room.fixedPrize === null ? null : minorToWire(room.fixedPrize),
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
      pressWindowSecs: room.pressWindowSecs,
    },
    autoDaubEnabled: room.autoDaubEnabled,
    allowAutoBingoPress: room.allowAutoBingoPress,
    runnerUpEnabled: room.runnerUpEnabled,
    runnerUpPrize:
      room.runnerUpPrize === null ? null : minorToWire(room.runnerUpPrize),
    runnerUpWindowSecs: room.runnerUpWindowSecs,
    bonusTiers: room.bonusTiers,
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
    mode: round.mode,
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
    fixedPrize: round.fixedPrize === null ? null : minorToWire(round.fixedPrize),
    bonusCards: round.bonusCards,
    winningPattern: round.winningPattern,
    runnerUpEnabled: round.runnerUpEnabled,
    runnerUpPrize:
      round.runnerUpPrize === null ? null : minorToWire(round.runnerUpPrize),
    runnerUpNumber: round.runnerUpNumber,
    runnerUpOpensAt: round.runnerUpOpensAt,
    runnerUpClosesAt: round.runnerUpClosesAt,
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
    autoPress: card.autoPress,
    isBonus: card.isBonus,
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
    phase: claim.phase,
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
    phase: winner.phase,
    payout: minorToWire(winner.payout),
    isSplitPot: winner.isSplitPot,
  };
}

export function serializeAgentTask(
  task: AgentTask & { agentProfile?: { agentCode: string } | null },
) {
  return {
    id: task.id,
    type: task.depositId ? 'DEPOSIT' : 'WITHDRAWAL',
    status: task.status,
    agentProfileId: task.agentProfileId,
    agentCode: task.agentProfile?.agentCode,
    depositId: task.depositId,
    withdrawalId: task.withdrawalId,
    assignedAt: task.assignedAt,
    claimedAt: task.claimedAt,
    completedAt: task.completedAt,
    slaDeadline: task.slaDeadline,
    overdue: !task.completedAt && Boolean(task.slaDeadline && task.slaDeadline < new Date()),
    reassignCount: task.reassignCount,
  };
}

export function serializeMediaAsset(asset: MediaAsset) {
  return {
    id: asset.id,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    purpose: asset.purpose,
    url: `/media/${asset.id}`,
    createdAt: asset.createdAt,
  };
}

export function serializeSupportTicket(ticket: SupportTicket) {
  return {
    id: ticket.id,
    code: ticket.code,
    playerId: ticket.playerId,
    topic: ticket.topic,
    status: ticket.status,
    locale: ticket.locale,
    subject: ticket.subject,
    assigneeId: ticket.assigneeId,
    claimedAt: ticket.claimedAt,
    resolvedAt: ticket.resolvedAt,
    unreadForStaff: ticket.unreadForStaff,
    unreadForPlayer: ticket.unreadForPlayer,
    lastMessageAt: ticket.lastMessageAt,
    lastPlayerMessageAt: ticket.lastPlayerMessageAt,
    lastStaffMessageAt: ticket.lastStaffMessageAt,
    createdAt: ticket.createdAt,
  };
}

export function serializeSupportMessage(message: SupportMessage) {
  return {
    id: message.id,
    ticketId: message.ticketId,
    author: message.author,
    authorUserId: message.authorUserId,
    body: message.body,
    mediaAssetId: message.mediaAssetId,
    deliveredAt: message.deliveredAt,
    deliveryAttempts: message.deliveryAttempts,
    deliveryError: message.deliveryError,
    createdAt: message.createdAt,
  };
}

export function serializeProof(proof: WithdrawalProof) {
  return {
    id: proof.id,
    withdrawalId: proof.withdrawalId,
    method: proof.method,
    reference: proof.reference,
    paidAmount: minorToWire(proof.paidAmount),
    currency: proof.currency,
    senderAccount: proof.senderAccount,
    receiverAccount: proof.receiverAccount,
    paidAt: proof.paidAt,
    mediaAssetId: proof.mediaAssetId,
    notes: proof.notes,
    status: proof.status,
    message: proof.message,
    reviewedAt: proof.reviewedAt,
    createdAt: proof.createdAt,
  };
}
