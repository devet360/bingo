import { getRuntimeConfig } from './runtime-config';
import type {
  AdminOverview,
  Agent,
  AuditEntry,
  Card,
  Claim,
  Commission,
  CreatedStaff,
  Deposit,
  DepositProvider,
  DepositStatus,
  FloatRequest,
  LedgerView,
  LobbyRoom,
  Paginated,
  PaymentAccount,
  PaymentMethod,
  ReceiptVerificationView,
  Room,
  Role,
  Round,
  RoundProof,
  RoomView,
  StaffDeposit,
  StaffMember,
  StaffRole,
  StaffWithdrawal,
  TransactionLine,
  User,
  UserDetail,
  UserStatus,
  VerificationStatus,
  VerifyReceiptResult,
  Wallet,
  Withdrawal,
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
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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

export function submitClaim(input: {
  roundId: string;
  cardId: string;
  pattern: WinPattern;
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
  agentProfileId?: string;
  playerNote?: string;
  idempotencyKey: string;
}): Promise<Withdrawal> {
  const { idempotencyKey, ...body } = input;
  return apiRequest('/wallet/withdrawals', { method: 'POST', body, idempotencyKey });
}

export function cancelWithdrawal(id: string): Promise<Withdrawal> {
  return apiRequest(`/wallet/withdrawals/${id}/cancel`, { method: 'POST' });
}

// ─────────────────────────────── agent ───────────────────────────────

export function fetchAgentProfile(): Promise<{ agent: Agent; wallet: Wallet }> {
  return apiRequest('/agent/me');
}

export function setAgentPresence(isOnline: boolean): Promise<Agent> {
  return apiRequest('/agent/presence', { method: 'POST', body: { isOnline } });
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

export function cancelDepositByStaff(depositId: string): Promise<Deposit> {
  return apiRequest(`/support/deposits/${depositId}/cancel`, { method: 'POST' });
}

export function fetchStaffReceipts(
  filter: { status?: VerificationStatus; providerCode?: string; page?: number } = {},
): Promise<Paginated<ReceiptVerificationView>> {
  return apiRequest(`/support/receipts${queryString(filter)}`, { fullEnvelope: true });
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

export function createStaffMember(input: {
  role: StaffRole;
  displayName: string;
  email?: string;
  phone?: string;
  password?: string;
  agent?: { region: string; city?: string; district?: string };
}): Promise<CreatedStaff> {
  return apiRequest('/admin/staff', { method: 'POST', body: input });
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
