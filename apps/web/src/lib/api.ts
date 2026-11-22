import { getRuntimeConfig } from './runtime-config';
import type {
  AdminBingoRoom,
  AdminOverview,
  AdminReferralRow,
  AdminSettings,
  Agent,
  AgentTask,
  AuditEntry,
  Bonus,
  BonusPromotion,
  BonusWithPlayer,
  Campaign,
  CampaignAudience,
  CampaignKind,
  Card,
  Claim,
  Commission,
  CreatedStaff,
  Deposit,
  DepositLimits,
  DepositProvider,
  DepositStatus,
  FloatRequest,
  GameProvider,
  GameProviderGame,
  LedgerView,
  LobbyRoom,
  Paginated,
  PaymentAccount,
  PaymentMethod,
  PayoutAccount,
  ProviderCallbackLog,
  ProviderCatalogueGame,
  ProviderKind,
  ProviderSession,
  ProviderTransaction,
  ReceiptLookupResult,
  ReceiptVerificationView,
  RecheckReceiptResult,
  ReferralOverview,
  Role,
  Room,
  Round,
  RoundProof,
  RoomView,
  StaffDeposit,
  StaffMember,
  StaffRole,
  StaffWithdrawal,
  SupportMessage,
  SupportTicket,
  SupportTicketDetail,
  SupportTicketRow,
  SupportTicketStatus,
  TransactionLine,
  User,
  UserDetail,
  UserStatus,
  VerificationStatus,
  VerifyReceiptResult,
  Wallet,
  Withdrawal,
  WithdrawalProof,
  WithdrawalStatus,
  WinPattern,
} from './types';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let currentTokens: Tokens | null = null;
let persistHandler: ((tokens: Tokens | null) => void) | null = null;
let sessionLostHandler: (() => void) | null = null;

export function setTokens(tokens: Tokens | null): void {
  currentTokens = tokens;
  persistHandler?.(tokens);
}

export function getTokens(): Tokens | null {
  return currentTokens;
}

export function configureApi(handlers: {
  persist: (tokens: Tokens | null) => void;
  sessionLost: () => void;
}): void {
  persistHandler = handlers.persist;
  sessionLostHandler = handlers.sessionLost;
}

export function newIdempotencyKey(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  auth?: boolean;
  signal?: AbortSignal;
  /** Return `{ data, page }` instead of unwrapping `data` (paginated endpoints). */
  fullEnvelope?: boolean;
}

function urlFor(path: string): string {
  return `${getRuntimeConfig().apiUrl}${path}`;
}

function parseError(status: number, payload: unknown): ApiError {
  const envelope = payload as { error?: { code?: string; message?: string; details?: unknown } } | null;
  const code = envelope?.error?.code ?? 'HTTP_ERROR';
  const message = envelope?.error?.message ?? `Request failed (${status})`;
  return new ApiError(status, code, message, envelope?.error?.details);
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function rawRequest<T>(path: string, options: RequestOptions): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  let accessToken = currentTokens?.accessToken ?? null;
  const response = await fetch(urlFor(path), {
    method: options.method ?? 'GET',
    headers: accessToken ? { ...headers, authorization: `Bearer ${accessToken}` } : headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    cache: 'no-store',
  });

  if (!response.ok) {
    const payload = await readBody(response);
    throw parseError(response.status, payload);
  }
  const payload = (await readBody(response)) as { data?: T } | null;
  if (options.fullEnvelope) return payload as unknown as T;
  return (payload?.data ?? null) as T;
}

let refreshInFlight: Promise<Tokens | null> | null = null;

async function refreshTokens(): Promise<Tokens | null> {
  if (refreshInFlight) return refreshInFlight;
  const tokens = currentTokens;
  if (!tokens?.refreshToken) return null;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(urlFor('/auth/refresh'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
      if (!response.ok) {
        setTokens(null);
        sessionLostHandler?.();
        return null;
      }
      const payload = (await response.json()) as {
        data: { accessToken: string; refreshToken: string; refreshExpiresAt?: string };
      };
      const next: Tokens = {
        accessToken: payload.data.accessToken,
        refreshToken: payload.data.refreshToken,
        refreshExpiresAt: payload.data.refreshExpiresAt,
      };
      setTokens(next);
      return next;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Authenticated request with a single retry after a silent token refresh. A
 * 401 with no usable refresh token drops the client back to the login screen.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const requiresAuth = options.auth !== false;
  try {
    return await rawRequest<T>(path, options);
  } catch (error) {
    const canRefresh = error instanceof ApiError && error.status === 401 && requiresAuth;
    if (!canRefresh) throw error;
    const refreshed = await refreshTokens();
    if (!refreshed) {
      sessionLostHandler?.();
      throw error;
    }
    return rawRequest<T>(path, options);
  }
}

/** Private evidence is bearer-protected, so the UI renders it from a blob URL. */
export async function fetchMediaBlobUrl(assetId: string): Promise<string> {
  const accessToken = currentTokens?.accessToken ?? null;
  const response = await fetch(urlFor(`/media/${assetId}`), {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new ApiError(response.status, 'MEDIA_UNAVAILABLE', 'Could not load the attachment.');
  }
  return URL.createObjectURL(await response.blob());
}

// ─────────────────────────────── auth ───────────────────────────────

export interface AuthPayload {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn?: string;
  refreshExpiresAt?: string;
  user: User;
}

export async function telegramLogin(initData: string, startParam?: string): Promise<AuthPayload> {
  return rawRequest<AuthPayload>('/auth/telegram', {
    method: 'POST',
    body: { initData, startParam },
    auth: false,
  });
}

export async function passwordLogin(identifier: string, password: string): Promise<AuthPayload> {
  return rawRequest<AuthPayload>('/auth/login', {
    method: 'POST',
    body: { identifier, password },
    auth: false,
  });
}

export async function fetchMe(): Promise<{ user: User; wallet: Wallet; agent: Agent | null }> {
  return apiRequest('/auth/me');
}

export function changePassword(currentPassword: string, newPassword: string): Promise<{ changed: true }> {
  return apiRequest('/auth/password', {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
}

export function updateLocale(locale: 'en' | 'am'): Promise<{ user: User }> {
  return apiRequest('/auth/locale', { method: 'PATCH', body: { locale } });
}

export async function logoutRequest(): Promise<void> {
  await apiRequest('/auth/logout', { method: 'POST' });
}

// ─────────────────────────────── bingo ───────────────────────────────

export function fetchRooms(): Promise<LobbyRoom[]> {
  return apiRequest('/bingo/rooms', { auth: false });
}

export function fetchRoom(code: string): Promise<RoomView> {
  return apiRequest(`/bingo/rooms/${encodeURIComponent(code)}`, { auth: false });
}

export function fetchRound(roundId: string): Promise<{ round: Round; room: Room; claimCount: number }> {
  return apiRequest(`/bingo/rounds/${roundId}`, { auth: false });
}

export function fetchMyCards(roundId: string): Promise<Card[]> {
  return apiRequest(`/bingo/rounds/${roundId}/my-cards`);
}

export function fetchRoundProof(roundId: string): Promise<RoundProof> {
  return apiRequest(`/bingo/rounds/${roundId}/verify`, { auth: false });
}

export function buyCards(input: {
  roomCode: string;
  quantity: number;
  clientSeed?: string;
  idempotencyKey: string;
}): Promise<{ round: Round; cards: Card[] }> {
  return apiRequest(`/bingo/rooms/${encodeURIComponent(input.roomCode)}/cards`, {
    method: 'POST',
    body: { quantity: input.quantity, clientSeed: input.clientSeed || undefined },
    idempotencyKey: input.idempotencyKey,
  });
}

export function addPreviewCards(input: {
  roomCode: string;
  quantity: number;
}): Promise<Card[]> {
  return apiRequest(`/bingo/rooms/${encodeURIComponent(input.roomCode)}/cards/preview`, {
    method: 'POST',
    body: { quantity: input.quantity },
  });
}

export function registerCards(input: {
  roundId: string;
  cardIds: string[];
  clientSeed?: string;
  autoPress?: boolean;
}): Promise<{ round: Round; cards: Card[] }> {
  return apiRequest(`/bingo/rounds/${input.roundId}/cards/register`, {
    method: 'POST',
    body: {
      cardIds: input.cardIds,
      clientSeed: input.clientSeed || undefined,
      autoPress: input.autoPress,
    },
  });
}

export function removePreviewCards(input: {
  roundId: string;
  cardIds: string[];
}): Promise<{ removed: number }> {
  return apiRequest(`/bingo/rounds/${input.roundId}/cards/preview`, {
    method: 'DELETE',
    body: { cardIds: input.cardIds },
  });
}

export function submitClaim(input: {
  roundId: string;
  cardId: string;
  pattern?: WinPattern;
}): Promise<Claim> {
  return apiRequest(`/bingo/rounds/${input.roundId}/claims`, {
    method: 'POST',
    body: { cardId: input.cardId, pattern: input.pattern },
  });
}

// ─────────────────────────────── wallet ───────────────────────────────

export function fetchWallet(): Promise<Wallet> {
  return apiRequest('/wallet');
}

export function fetchTransactions(limit = 50): Promise<TransactionLine[]> {
  return apiRequest(`/wallet/transactions?limit=${limit}`);
}

export function fetchAgents(): Promise<Agent[]> {
  return apiRequest('/agents');
}

export function fetchDeposits(status?: DepositStatus): Promise<Deposit[]> {
  return apiRequest(`/wallet/deposits${status ? `?status=${status}` : ''}`);
}

export function fetchDepositProviders(method?: PaymentMethod): Promise<DepositProvider[]> {
  return apiRequest(`/wallet/deposit-providers${method ? `?method=${method}` : ''}`);
}

export function fetchDepositLimits(): Promise<DepositLimits> {
  return apiRequest('/wallet/deposit-config');
}

export function createDeposit(input: {
  amount: number;
  method: PaymentMethod;
  agentProfileId?: string;
  agentCode?: string;
  paymentAccountId?: string;
  providerCode?: string;
  receiptReference?: string;
  receiptAccount?: string;
  receiptPhone?: string;
  playerNote?: string;
  idempotencyKey: string;
}): Promise<Deposit> {
  const { idempotencyKey, ...body } = input;
  return apiRequest('/wallet/deposits', { method: 'POST', body, idempotencyKey });
}

export function fetchDeposit(id: string): Promise<Deposit> {
  return apiRequest(`/wallet/deposits/${id}`);
}

export function verifyDepositReceipt(
  code: string,
  payload?: {
    contentType?: string;
    bodyBase64?: string;
    receiptReference?: string;
    receiptAccount?: string;
    receiptPhone?: string;
    proofBase64?: string;
    proofContentType?: string;
  },
): Promise<VerifyReceiptResult> {
  return apiRequest(`/wallet/deposits/${encodeURIComponent(code)}/verify-receipt`, {
    method: 'POST',
    body: payload ?? {},
    fullEnvelope: true,
  });
}

export function fetchWithdrawals(status?: WithdrawalStatus): Promise<Withdrawal[]> {
  return apiRequest(`/wallet/withdrawals${status ? `?status=${status}` : ''}`);
}

export function createWithdrawal(input: {
  amount: number;
  method: PaymentMethod;
  providerCode?: string;
  agentProfileId?: string;
  payoutAccountId?: string;
  payoutAccount?: { accountName: string; accountNumber: string; provider?: string | null };
  playerNote?: string;
  idempotencyKey: string;
}): Promise<Withdrawal> {
  const { idempotencyKey, ...body } = input;
  return apiRequest('/wallet/withdrawals', { method: 'POST', body, idempotencyKey });
}

export function cancelWithdrawal(id: string): Promise<Withdrawal> {
  return apiRequest(`/wallet/withdrawals/${id}/cancel`, { method: 'POST' });
}

export interface PayoutAccountInput {
  method: PaymentMethod;
  provider?: string | null;
  accountName: string;
  accountNumber: string;
  isDefault?: boolean;
}

export function fetchPayoutAccounts(): Promise<PayoutAccount[]> {
  return apiRequest('/wallet/payout-accounts');
}

export function createPayoutAccount(input: PayoutAccountInput): Promise<PayoutAccount> {
  return apiRequest('/wallet/payout-accounts', { method: 'POST', body: input });
}

export function updatePayoutAccount(
  id: string,
  patch: Partial<PayoutAccountInput> & { isActive?: boolean },
): Promise<PayoutAccount> {
  return apiRequest(`/wallet/payout-accounts/${id}`, { method: 'PATCH', body: patch });
}

export function deactivatePayoutAccount(id: string): Promise<PayoutAccount> {
  return apiRequest(`/wallet/payout-accounts/${id}`, { method: 'DELETE' });
}

export function fetchWithdrawalProofs(withdrawalId: string): Promise<WithdrawalProof[]> {
  return apiRequest(`/wallet/withdrawals/${withdrawalId}/proofs`);
}

export function confirmCashReceived(
  withdrawalId: string,
): Promise<{ withdrawal: Withdrawal; proof: WithdrawalProof }> {
  return apiRequest(`/wallet/withdrawals/${withdrawalId}/confirm-received`, { method: 'POST' });
}

// ─────────────────────────────── agent ───────────────────────────────

export function fetchAgentProfile(): Promise<{ agent: Agent; wallet: Wallet }> {
  return apiRequest('/agent/me');
}

export function setAgentPresence(isOnline: boolean): Promise<Agent> {
  return apiRequest('/agent/presence', { method: 'POST', body: { isOnline } });
}

export function setAgentAvailability(acceptingTasks: boolean): Promise<Agent> {
  return apiRequest('/agent/availability', { method: 'POST', body: { acceptingTasks } });
}

export function fetchAgentTasks(): Promise<AgentTask[]> {
  return apiRequest('/agent/tasks');
}

export function releaseAgentTask(taskId: string): Promise<AgentTask> {
  return apiRequest(`/agent/tasks/${taskId}/release`, { method: 'POST' });
}

export function fetchAgentWithdrawalProofs(withdrawalId: string): Promise<WithdrawalProof[]> {
  return apiRequest(`/agent/withdrawals/${withdrawalId}/proofs`);
}

export interface WithdrawalProofInput {
  reference?: string;
  paidAmount?: number;
  currency?: string;
  senderAccount?: string;
  receiverAccount?: string;
  paidAt?: string;
  notes?: string;
  mediaAssetId?: string;
  screenshotBase64?: string;
}

export function submitWithdrawalProof(
  withdrawalId: string,
  input: WithdrawalProofInput,
): Promise<WithdrawalProof> {
  return apiRequest(`/agent/withdrawals/${withdrawalId}/proof`, { method: 'POST', body: input });
}

export function updateAgentSettings(input: {
  autoDepositEnabled?: boolean;
  autoDepositThreshold?: number | null;
}): Promise<Agent> {
  return apiRequest('/agent/me', { method: 'PATCH', body: input });
}

export interface PaymentAccountInput {
  method: PaymentMethod;
  provider?: string | null;
  accountName: string;
  accountNumber: string;
  instructions?: string | null;
  minAmount?: number | null;
  maxAmount?: number | null;
}

export function fetchPaymentAccounts(): Promise<PaymentAccount[]> {
  return apiRequest('/agent/payment-accounts');
}

export function createPaymentAccount(input: PaymentAccountInput): Promise<PaymentAccount> {
  return apiRequest('/agent/payment-accounts', { method: 'POST', body: input });
}

export function updatePaymentAccount(
  id: string,
  patch: Partial<PaymentAccountInput> & { isActive?: boolean },
): Promise<PaymentAccount> {
  return apiRequest(`/agent/payment-accounts/${id}`, { method: 'PATCH', body: patch });
}

export function deactivatePaymentAccount(id: string): Promise<PaymentAccount> {
  return apiRequest(`/agent/payment-accounts/${id}`, { method: 'DELETE' });
}

export function fetchAgentDeposits(status?: DepositStatus): Promise<Deposit[]> {
  return apiRequest(`/agent/deposits${status ? `?status=${status}` : ''}`);
}

export function claimAgentDeposit(code: string): Promise<Deposit> {
  return apiRequest(`/agent/deposits/${encodeURIComponent(code)}/claim`, { method: 'POST' });
}

export function creditAgentDeposit(input: {
  code: string;
  creditedAmount?: number;
  note?: string;
}): Promise<Deposit> {
  return apiRequest(`/agent/deposits/${encodeURIComponent(input.code)}/credit`, {
    method: 'POST',
    body: { creditedAmount: input.creditedAmount, note: input.note },
  });
}

export function rejectAgentDeposit(code: string, note?: string): Promise<Deposit> {
  return apiRequest(`/agent/deposits/${encodeURIComponent(code)}/reject`, {
    method: 'POST',
    body: { note },
  });
}

export function recheckAgentDepositReceipt(code: string): Promise<RecheckReceiptResult> {
  return apiRequest(`/agent/deposits/${encodeURIComponent(code)}/recheck-receipt`, {
    method: 'POST',
    fullEnvelope: true,
  });
}

/** `amount` is the figure read on the bank receipt, in minor units. */
export function confirmAgentDepositReceipt(code: string, amount: number): Promise<Deposit> {
  return apiRequest(`/agent/deposits/${encodeURIComponent(code)}/confirm-receipt`, {
    method: 'POST',
    body: { amount },
  });
}

export function fetchAgentWithdrawals(status?: WithdrawalStatus): Promise<Withdrawal[]> {
  return apiRequest(`/agent/withdrawals${status ? `?status=${status}` : ''}`);
}

export function redeemAgentWithdrawal(payoutCode: string, note?: string): Promise<Withdrawal> {
  return apiRequest('/agent/withdrawals/redeem', {
    method: 'POST',
    body: { payoutCode, note },
  });
}

export function fetchAgentCommissions(limit = 50): Promise<Commission[]> {
  return apiRequest(`/agent/commissions?limit=${limit}`);
}

export function fetchAgentFloatRequests(limit = 20): Promise<FloatRequest[]> {
  return apiRequest(`/agent/float-requests?limit=${limit}`);
}

// ─────────────────────────────── support & super admin ───────────────────────────────

function queryString(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export interface StaffListFilter {
  query?: string;
  role?: Role;
  status?: UserStatus;
  page?: number;
}

export function fetchStaffUsers(filter: StaffListFilter = {}): Promise<Paginated<User>> {
  return apiRequest(`/support/users${queryString(filter)}`, { fullEnvelope: true });
}

export function fetchStaffUser(userId: string): Promise<UserDetail> {
  return apiRequest(`/support/users/${userId}`);
}

export function fetchStaffTransactions(
  filter: { userId?: string; kind?: string; refType?: string; page?: number } = {},
): Promise<Paginated<LedgerView>> {
  return apiRequest(`/support/transactions${queryString(filter)}`, { fullEnvelope: true });
}

export function fetchStaffDeposits(
  filter: { status?: DepositStatus; userId?: string; page?: number } = {},
): Promise<Paginated<StaffDeposit>> {
  return apiRequest(`/support/deposits${queryString(filter)}`, { fullEnvelope: true });
}

export function fetchStaffWithdrawals(
  filter: { status?: WithdrawalStatus; userId?: string; page?: number } = {},
): Promise<Paginated<StaffWithdrawal>> {
  return apiRequest(`/support/withdrawals${queryString(filter)}`, { fullEnvelope: true });
}

export function fetchStaffAgents(): Promise<Agent[]> {
  return apiRequest('/support/agents');
}

export function setUserStatus(userId: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<{ userId: string; status: string }> {
  return apiRequest(`/support/users/${userId}/status`, { method: 'POST', body: { status } });
}

export function cancelWithdrawalByStaff(withdrawalId: string): Promise<Withdrawal> {
  return apiRequest(`/support/withdrawals/${withdrawalId}/cancel`, { method: 'POST' });
}

export function fetchWithdrawalProofsByStaff(withdrawalId: string): Promise<WithdrawalProof[]> {
  return apiRequest(`/support/withdrawals/${withdrawalId}/proofs`);
}

export function reviewWithdrawalProof(
  withdrawalId: string,
  proofId: string,
  input: { decision: 'VERIFIED' | 'FAILED'; note?: string },
): Promise<WithdrawalProof> {
  return apiRequest(`/support/withdrawals/${withdrawalId}/proofs/${proofId}/review`, {
    method: 'POST',
    body: input,
  });
}

export function cancelDepositByStaff(depositId: string): Promise<Deposit> {
  return apiRequest(`/support/deposits/${depositId}/cancel`, { method: 'POST' });
}

export function recheckDepositReceiptByStaff(depositId: string): Promise<RecheckReceiptResult> {
  return apiRequest(`/support/deposits/${depositId}/recheck-receipt`, {
    method: 'POST',
    fullEnvelope: true,
  });
}

/** `amount` is the figure read on the bank receipt, in minor units. */
export function confirmDepositReceiptByStaff(depositId: string, amount: number): Promise<Deposit> {
  return apiRequest(`/support/deposits/${depositId}/confirm-receipt`, {
    method: 'POST',
    body: { amount },
  });
}

export interface ReceiptLookupInput {
  providerCode: string;
  reference: string;
  accountNumber?: string;
  phoneNumber?: string;
  /** The bank's own response (HTML, JSON envelope or PDF), base64. */
  payload?: { contentType?: string; bodyBase64: string };
}

export function fetchReceiptCheckerProviders(scope: 'staff' | 'agent'): Promise<DepositProvider[]> {
  return apiRequest(scope === 'agent' ? '/agent/receipt-providers' : '/support/receipt-providers');
}

/** Read-only: looks a receipt up and returns what the bank says. */
export function checkReceipt(
  scope: 'staff' | 'agent',
  input: ReceiptLookupInput,
): Promise<ReceiptLookupResult> {
  return apiRequest(scope === 'agent' ? '/agent/receipts/check' : '/support/receipts/check', {
    method: 'POST',
    body: input,
  });
}

export function fetchStaffReceipts(
  filter: { status?: VerificationStatus; providerCode?: string; page?: number } = {},
): Promise<Paginated<ReceiptVerificationView>> {
  return apiRequest(`/support/receipts${queryString(filter)}`, { fullEnvelope: true });
}

export interface SupportTicketFilter {
  status?: SupportTicketStatus;
  assignee?: string;
  query?: string;
  page?: number;
}

export function fetchSupportTickets(
  filter: SupportTicketFilter = {},
): Promise<Paginated<SupportTicketRow>> {
  return apiRequest(`/support/tickets${queryString(filter)}`, { fullEnvelope: true });
}

export function fetchSupportTicket(ticketId: string): Promise<SupportTicketDetail> {
  return apiRequest(`/support/tickets/${ticketId}`);
}

export function replySupportTicket(
  ticketId: string,
  body: string,
): Promise<{ ticket: SupportTicket; message: SupportMessage }> {
  return apiRequest(`/support/tickets/${ticketId}/messages`, {
    method: 'POST',
    body: { body },
  });
}

export function claimSupportTicket(ticketId: string): Promise<SupportTicket> {
  return apiRequest(`/support/tickets/${ticketId}/claim`, { method: 'POST' });
}

export function resolveSupportTicket(
  ticketId: string,
): Promise<{ ticket: SupportTicket; message: SupportMessage | null }> {
  return apiRequest(`/support/tickets/${ticketId}/resolve`, { method: 'POST' });
}

export function fetchDepositProvidersAdmin(): Promise<DepositProvider[]> {
  return apiRequest('/admin/deposit-providers');
}

export interface DepositProviderPatch {
  name?: string;
  enabled?: boolean;
  supported?: boolean;
  requiresPhone?: boolean;
  accountDigits?: number | null;
  opaqueReference?: boolean;
  clientSide?: boolean;
  sortOrder?: number;
  instructions?: string | null;
  refPattern?: string | null;
  refHint?: string | null;
  minAmount?: number | null;
  maxAmount?: number | null;
  endpoint?: string | null;
}

export function updateDepositProvider(code: string, patch: DepositProviderPatch): Promise<DepositProvider> {
  return apiRequest(`/admin/deposit-providers/${encodeURIComponent(code)}`, { method: 'PATCH', body: patch });
}

export function fetchAdminBingoRooms(): Promise<AdminBingoRoom[]> {
  return apiRequest('/admin/bingo/rooms');
}

export interface BingoRoomPatch {
  name?: string;
  status?: 'OPEN' | 'MAINTENANCE' | 'CLOSED';
  stakePerCard?: number;
  fixedPrize?: number | null;
  maxCardsPerPlayer?: number;
  minPlayersToStart?: number;
  rakeBps?: number;
  drawIntervalMs?: number;
  purchaseWindowSecs?: number;
  lockWindowSecs?: number;
  claimWindowSecs?: number;
  pressWindowSecs?: number;
  autoDaubEnabled?: boolean;
  allowAutoBingoPress?: boolean;
  runnerUpEnabled?: boolean;
  runnerUpPrize?: number | null;
  runnerUpWindowSecs?: number;
  bonusTiers?: Array<{ minCards: number; bonusCards: number }>;
}

export function updateAdminBingoRoom(code: string, patch: BingoRoomPatch): Promise<Room> {
  return apiRequest(`/admin/bingo/rooms/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function setStaffTelegram(userId: string, telegramId: string | null): Promise<{ user: User }> {
  return apiRequest(`/admin/staff/${userId}/telegram`, { method: 'PATCH', body: { telegramId } });
}

export function createStaffTelegramLink(
  userId: string,
): Promise<{ token: string; expiresAt: string; url: string }> {
  return apiRequest(`/admin/staff/${userId}/telegram-link`, { method: 'POST' });
}

export function fetchAdminOverview(): Promise<AdminOverview> {
  return apiRequest('/admin/overview');
}

export function fetchStaffMembers(
  filter: { query?: string; status?: UserStatus; page?: number } = {},
): Promise<Paginated<StaffMember>> {
  return apiRequest(`/admin/staff${queryString(filter)}`, { fullEnvelope: true });
}

export interface AgentAccountInput {
  method: PaymentMethod;
  provider?: string;
  accountName: string;
  accountNumber: string;
  instructions?: string;
}

export function createStaffMember(input: {
  role: StaffRole;
  displayName: string;
  email?: string;
  phone?: string;
  password?: string;
  agent?: {
    region: string;
    city?: string;
    district?: string;
    account?: AgentAccountInput;
  };
}): Promise<CreatedStaff> {
  return apiRequest('/admin/staff', { method: 'POST', body: input });
}

export function createAgentPaymentAccount(
  agentId: string,
  input: AgentAccountInput,
): Promise<{ id: string }> {
  return apiRequest(`/admin/agents/${agentId}/payment-accounts`, { method: 'POST', body: input });
}

export function setStaffMemberStatus(userId: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<{ user: User }> {
  return apiRequest(`/admin/staff/${userId}/status`, { method: 'PATCH', body: { status } });
}

export function resetStaffPassword(userId: string): Promise<{ temporaryPassword: string }> {
  return apiRequest(`/admin/staff/${userId}/reset-password`, { method: 'POST' });
}

export function fetchAuditLog(
  filter: { action?: string; actorId?: string; entityType?: string; page?: number } = {},
): Promise<Paginated<AuditEntry>> {
  return apiRequest(`/admin/audit${queryString(filter)}`, { fullEnvelope: true });
}

export function updateAgentByAdmin(
  agentId: string,
  patch: { status?: string; tier?: string },
): Promise<Agent> {
  return apiRequest(`/admin/agents/${agentId}`, { method: 'PATCH', body: patch });
}

export function topUpAgentFloat(input: {
  agentId: string;
  amount: number;
  method: PaymentMethod;
  externalRef?: string;
  idempotencyKey: string;
}): Promise<{ id: string; agentProfileId: string; amount: string; status: string; createdAt: string }> {
  const { agentId, idempotencyKey, ...body } = input;
  return apiRequest(`/admin/agents/${agentId}/float`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

// ─────────────────────────────── marketing ───────────────────────────────

export function fetchCampaigns(locale: 'en' | 'am'): Promise<Campaign[]> {
  return apiRequest(`/marketing/campaigns?locale=${locale}`);
}

export interface CampaignInput {
  kind: CampaignKind;
  audience: CampaignAudience;
  locale: 'en' | 'am';
  title: string;
  body: string;
  imageUrl?: string | null;
  linkUrl?: string | null;
  linkLabel?: string | null;
  enabled: boolean;
  priority: number;
  dismissHours: number;
  startsAt?: string | null;
  endsAt?: string | null;
}

export function fetchAdminCampaigns(): Promise<Campaign[]> {
  return apiRequest('/admin/campaigns');
}

export function createCampaign(input: CampaignInput): Promise<Campaign> {
  return apiRequest('/admin/campaigns', { method: 'POST', body: input });
}

export function updateCampaign(id: string, patch: Partial<CampaignInput>): Promise<Campaign> {
  return apiRequest(`/admin/campaigns/${id}`, { method: 'PATCH', body: patch });
}

export function deleteCampaign(id: string): Promise<{ deleted: true }> {
  return apiRequest(`/admin/campaigns/${id}`, { method: 'DELETE' });
}

// ─────────────────────────────── bonuses ───────────────────────────────

export function fetchBonuses(): Promise<{ active: Bonus | null; history: Bonus[]; wallet: Wallet }> {
  return apiRequest('/bonuses');
}

export function redeemPromoCode(code: string): Promise<{ bonus: Bonus; wallet: Wallet }> {
  return apiRequest('/bonuses/redeem', { method: 'POST', body: { code } });
}

export function fetchBonusPromotions(): Promise<BonusPromotion[]> {
  return apiRequest('/admin/bonus-promotions');
}

export interface BonusPromotionInput {
  code: string;
  name: string;
  percentBps?: number | null;
  fixedAmount?: number | null;
  maxBonus?: number | null;
  minDeposit?: number | null;
  wageringMultiplier: number;
  expiresInDays: number;
  enabled: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  maxRedemptions?: number | null;
}

export function createBonusPromotion(input: BonusPromotionInput): Promise<BonusPromotion> {
  return apiRequest('/admin/bonus-promotions', { method: 'POST', body: input });
}

export function updateBonusPromotion(
  id: string,
  patch: Partial<BonusPromotionInput>,
): Promise<BonusPromotion> {
  return apiRequest(`/admin/bonus-promotions/${id}`, { method: 'PATCH', body: patch });
}

export function deleteBonusPromotion(id: string): Promise<{ deleted: true }> {
  return apiRequest(`/admin/bonus-promotions/${id}`, { method: 'DELETE' });
}

export function fetchAdminBonuses(
  filter: { userId?: string; page?: number } = {},
): Promise<Paginated<BonusWithPlayer>> {
  return apiRequest(`/admin/bonuses${queryString(filter)}`, { fullEnvelope: true });
}

export function grantBonus(input: {
  userId: string;
  amount: number;
  multiplier?: number;
  expiresInDays?: number;
  note?: string;
}): Promise<Bonus> {
  return apiRequest('/admin/bonuses/grant', { method: 'POST', body: input });
}

// ─────────────────────────────── referrals ───────────────────────────────

export function fetchReferralOverview(): Promise<ReferralOverview> {
  return apiRequest('/referrals');
}

export function fetchAdminReferrals(): Promise<AdminReferralRow[]> {
  return apiRequest('/admin/referrals');
}

export function fetchAdminSettings(): Promise<AdminSettings> {
  return apiRequest('/admin/settings');
}

export function updateReferralSettings(input: {
  commissionBps: number;
  minRakeToPay?: number;
}): Promise<{ commissionBps: number; minRakeToPay?: number }> {
  return apiRequest('/admin/settings/referrals', { method: 'PUT', body: input });
}

export function updateBonusSettings(input: {
  defaultWageringMultiplier: number;
  defaultExpiryDays: number;
}): Promise<{ defaultWageringMultiplier: number; defaultExpiryDays: number }> {
  return apiRequest('/admin/settings/bonuses', { method: 'PUT', body: input });
}

export function updateDepositLimits(input: {
  minAmount: number;
  maxAmount: number | null;
}): Promise<DepositLimits> {
  return apiRequest('/admin/settings/deposit-limits', { method: 'PUT', body: input });
}

// ─────────────────────────────── external game providers ───────────────────────────────

export function fetchPlayableGames(): Promise<GameProvider[]> {
  return apiRequest('/games');
}

export function launchGame(gameId: string, lang: 'en' | 'am'): Promise<ProviderSession> {
  return apiRequest(`/games/${gameId}/launch`, { method: 'POST', body: { lang } });
}

export function fetchGameSession(sessionId: string): Promise<ProviderSession> {
  return apiRequest(`/games/sessions/${sessionId}`);
}

export function closeGameSession(sessionId: string): Promise<{ closed: true }> {
  return apiRequest(`/games/sessions/${sessionId}/close`, { method: 'POST' });
}

export function fetchGameProviders(): Promise<GameProvider[]> {
  return apiRequest('/admin/game-providers');
}

export interface GamesProviderOperator {
  code: string;
  name: string;
  callbackUrl: string;
  currency: string;
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
  allowedOrigins: string[];
  localeDefault: 'en' | 'am';
  limits: {
    minStake: string;
    maxStake: string;
    maxWin: string;
    maxBetsPerRound: number;
  };
  enabledGames: string[];
  theme: Record<string, unknown> | null;
  botConfig: {
    enabled: boolean;
    count: number;
    stakeMin: string;
    stakeMax: string;
    roundPayoutCap: string;
    dayPayoutCap: string;
    disclose: boolean;
  } | null;
  maintenance: boolean;
  probeOkAt: string | null;
  createdAt: string;
  hasSecret: boolean;
  secretVersion: number | null;
  hasPreviousSecret?: boolean;
}

export interface GamesProviderRuntimeSettings {
  operatorCode: string;
  enabledGames: Array<'crash' | 'coinflip'>;
  botConfig: NonNullable<GamesProviderOperator['botConfig']>;
}

export interface GamesProviderDashboard {
  operators: Array<Pick<GamesProviderOperator, 'code' | 'name' | 'status' | 'currency' | 'enabledGames' | 'maintenance' | 'probeOkAt' | 'createdAt'>>;
  metrics: {
    sessions: { total: number; active: number };
    rounds: { total: number; last24Hours: number; recent: Array<{ id: number; gameId: string; status: string; crashPoint: number | null; coinOutcome?: 'HEADS' | 'TAILS'; startedAt: string; crashedAt: string | null }> };
    bets: { total: number; unsettled: number };
    outbox: { pending: number; dead: number; capRejected: number; recent: Array<{ type: string; status: string; amount: string; attempts: number; updatedAt: string }> };
  };
}

export interface GamesProviderOperatorInput {
  code: string;
  name: string;
  currency?: string;
  localeDefault?: 'en' | 'am';
  limits?: GamesProviderOperator['limits'];
  enabledGames?: string[];
  theme?: Record<string, unknown> | null;
  botConfig?: NonNullable<GamesProviderOperator['botConfig']>;
}

export type GamesProviderOperatorPatch = Partial<Omit<GamesProviderOperatorInput, 'code'>> & {
  maintenance?: boolean;
};

export function fetchGamesProviderDashboard(hostCode: string): Promise<GamesProviderDashboard> {
  return apiRequest(`/admin/provider-management/${encodeURIComponent(hostCode)}/dashboard`);
}

export function fetchGamesProviderOperators(hostCode: string): Promise<GamesProviderOperator[]> {
  return apiRequest(`/admin/provider-management/${encodeURIComponent(hostCode)}/operators`);
}

export function fetchGamesProviderOperator(hostCode: string, operatorCode: string): Promise<GamesProviderOperator> {
  return apiRequest(`/admin/provider-management/${encodeURIComponent(hostCode)}/operators/${encodeURIComponent(operatorCode)}`);
}

export function createGamesProviderOperator(hostCode: string, input: GamesProviderOperatorInput): Promise<{ operator: GamesProviderOperator; secretVersion: number; bingoLinked: true }> {
  return apiRequest(`/admin/provider-management/${encodeURIComponent(hostCode)}/operators`, { method: 'POST', body: input });
}

export function updateGamesProviderOperator(hostCode: string, operatorCode: string, patch: GamesProviderOperatorPatch): Promise<GamesProviderOperator> {
  return apiRequest(`/admin/provider-management/${encodeURIComponent(hostCode)}/operators/${encodeURIComponent(operatorCode)}`, { method: 'PATCH', body: patch });
}

export function probeGamesProviderOperator(hostCode: string, operatorCode: string): Promise<{ ok: true; checkedAt: string }> {
  return apiRequest(`/admin/provider-management/${encodeURIComponent(hostCode)}/operators/${encodeURIComponent(operatorCode)}/probe`, { method: 'POST' });
}

export function setGamesProviderOperatorStatus(hostCode: string, operatorCode: string, status: GamesProviderOperator['status']): Promise<GamesProviderOperator> {
  return apiRequest(`/admin/provider-management/${encodeURIComponent(hostCode)}/operators/${encodeURIComponent(operatorCode)}/status`, { method: 'POST', body: { status } });
}

export function rotateGamesProviderOperatorSecret(hostCode: string, operatorCode: string): Promise<{ operator: GamesProviderOperator; secretVersion: number; bingoSynced: true }> {
  return apiRequest(`/admin/provider-management/${encodeURIComponent(hostCode)}/operators/${encodeURIComponent(operatorCode)}/secrets`, { method: 'POST' });
}

export function retirePreviousGamesProviderSecret(hostCode: string, operatorCode: string): Promise<{ retired: true }> {
  return apiRequest(`/admin/provider-management/${encodeURIComponent(hostCode)}/operators/${encodeURIComponent(operatorCode)}/secrets/retire-previous`, { method: 'POST' });
}

export function deleteGamesProviderOperator(hostCode: string, operatorCode: string): Promise<{ deleted: true; bingoIntegrationDisabled: true }> {
  return apiRequest(`/admin/provider-management/${encodeURIComponent(hostCode)}/operators/${encodeURIComponent(operatorCode)}`, { method: 'DELETE' });
}

export function fetchGamesProviderRuntimeSettings(hostCode: string): Promise<GamesProviderRuntimeSettings> {
  return apiRequest(`/admin/provider-management/${encodeURIComponent(hostCode)}/runtime-settings`);
}

export function updateGamesProviderRuntimeSettings(hostCode: string, settings: Pick<GamesProviderRuntimeSettings, 'botConfig' | 'enabledGames'>): Promise<GamesProviderRuntimeSettings> {
  return apiRequest(`/admin/provider-management/${encodeURIComponent(hostCode)}/runtime-settings`, { method: 'PUT', body: settings });
}

export function testLaunchGameProviderGame(gameId: string): Promise<{ launchUrl: string | null }> {
  return apiRequest(`/admin/game-providers/games/${encodeURIComponent(gameId)}/test-launch`, {
    method: 'POST',
  });
}

export interface GameProviderInput {
  name: string;
  kind: ProviderKind;
  apiBaseUrl?: string | null;
  webhookSecret?: string | null;
  currency?: string;
  maxWin?: number | null;
  enabled: boolean;
  sortOrder?: number;
  config?: unknown;
}

export function upsertGameProvider(code: string, input: GameProviderInput): Promise<GameProvider> {
  return apiRequest(`/admin/game-providers/${encodeURIComponent(code)}`, {
    method: 'PUT',
    body: input,
  });
}

export function deleteGameProvider(code: string): Promise<{ deleted: true }> {
  return apiRequest(`/admin/game-providers/${encodeURIComponent(code)}`, { method: 'DELETE' });
}

export function issueGameProviderConsoleToken(
  code: string,
  role: 'provider_viewer' | 'operator_admin' | 'superadmin' = 'provider_viewer',
): Promise<{ token: string; expiresAt: string }> {
  return apiRequest(`/admin/game-providers/${encodeURIComponent(code)}/console-token`, {
    method: 'POST',
    body: { role, ttlSeconds: 600 },
  });
}

export interface TestPlayerCredentials {
  user: User;
  email: string;
  password: string;
  startingBalanceMinor: string;
}

export function createTestPlayer(displayName?: string): Promise<TestPlayerCredentials> {
  return apiRequest('/admin/test-players', {
    method: 'POST',
    body: displayName ? { displayName } : {},
  });
}

export function fetchProviderSettings(): Promise<{ maxWin: string; defaultMaxWin: string }> {
  return apiRequest('/admin/game-providers/settings');
}

export function updateProviderSettings(maxWin: number): Promise<{ maxWin: string }> {
  return apiRequest('/admin/game-providers/settings', { method: 'PUT', body: { maxWin } });
}

export function fetchProviderCallbacks(
  code: string,
  filter: { page?: number } = {},
): Promise<Paginated<ProviderCallbackLog>> {
  return apiRequest(`/admin/game-providers/${encodeURIComponent(code)}/callbacks${queryString(filter)}`, {
    fullEnvelope: true,
  });
}

export function fetchProviderTransactions(
  code: string,
  filter: { type?: string; status?: string; page?: number } = {},
): Promise<Paginated<ProviderTransaction>> {
  return apiRequest(
    `/admin/game-providers/${encodeURIComponent(code)}/transactions${queryString(filter)}`,
    { fullEnvelope: true },
  );
}

export interface GameProviderGameInput {
  externalId: string;
  name: string;
  category?: string | null;
  thumbnailUrl?: string | null;
  launchUrlTemplate?: string | null;
  minStake?: number | null;
  maxStake?: number | null;
  maxWin?: number | null;
  enabled: boolean;
  sortOrder?: number;
}

export function upsertGameProviderGame(
  code: string,
  input: GameProviderGameInput,
): Promise<Pick<GameProviderGame, 'id' | 'externalId' | 'name' | 'enabled'>> {
  return apiRequest(`/admin/game-providers/${encodeURIComponent(code)}/games`, {
    method: 'POST',
    body: input,
  });
}

export function fetchProviderGameCatalogue(code: string): Promise<ProviderCatalogueGame[]> {
  return apiRequest(`/admin/game-providers/${encodeURIComponent(code)}/catalogue`);
}

export async function uploadGameProviderThumbnail(file: File): Promise<{ assetId: string; url: string }> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Could not read the selected image.'));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(new Error('Could not read the selected image.'));
    reader.readAsDataURL(file);
  });
  const uploaded = await apiRequest<{ assetId: string; url: string }>('/admin/game-provider-thumbnails', {
    method: 'POST',
    body: { base64, originalName: file.name },
  });
  return { ...uploaded, url: `${getRuntimeConfig().apiUrl}${uploaded.url}` };
}

export function deleteGameProviderGame(
  code: string,
  externalId: string,
): Promise<{ deleted: true }> {
  return apiRequest(
    `/admin/game-providers/${encodeURIComponent(code)}/games/${encodeURIComponent(externalId)}`,
    { method: 'DELETE' },
  );
}
