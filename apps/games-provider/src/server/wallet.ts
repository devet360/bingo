import { createHmac, timingSafeEqual } from 'node:crypto';

export class WalletError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

export interface MovementInput {
  sessionToken: string;
  txnId: string;
  amount: bigint;
  roundId: string;
}

export interface BalanceReply {
  currency: string;
  balance: bigint;
  balanceRaw: string;
  timestamp: number;
  nonce: string;
  signature: string;
  minStake: bigint | null;
  maxStake: bigint | null;
  maxWin: bigint | null;
}

export interface MovementReply {
  accepted: boolean;
  replayed: boolean;
  balance: bigint | null;
}

export interface WalletClient {
  balance(sessionToken: string, nonce: string): Promise<BalanceReply>;
  bet(input: MovementInput): Promise<MovementReply>;
  win(input: MovementInput): Promise<MovementReply>;
  rollback(input: MovementInput): Promise<MovementReply>;
}

export function signBody(secret: string, rawBody: string, operatorCode = ''): string {
  const payload = operatorCode.length > 0 ? `${operatorCode}.${rawBody}` : rawBody;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function balanceSignatureInput(input: {
  sessionId: string;
  currency: string;
  balance: string;
  timestamp: number;
  nonce: string;
}): string {
  return `${input.sessionId}.${input.currency}.${input.balance}.${input.timestamp}.${input.nonce}`;
}

export function verifyBalanceReply(
  secret: string,
  sessionToken: string,
  reply: BalanceReply,
  nowMs: number,
  skewMs = 120_000,
): void {
  // Reject malformed hex before it reaches timingSafeEqual, which throws a
  // RangeError on length mismatch and would leak a non-WalletError to callers.
  const givenHex = typeof reply.signature === 'string' ? reply.signature.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(givenHex)) {
    throw new WalletError(502, 'BALANCE_SIGNATURE_INVALID', 'Balance reply signature is malformed');
  }
  const expected = createHmac('sha256', secret)
    .update(
      balanceSignatureInput({
        sessionId: sessionToken,
        currency: reply.currency,
        balance: reply.balanceRaw,
        timestamp: reply.timestamp,
        nonce: reply.nonce,
      }),
    )
    .digest();
  const given = Buffer.from(givenHex, 'hex');
  if (!timingSafeEqual(expected, given)) {
    throw new WalletError(502, 'BALANCE_SIGNATURE_INVALID', 'Balance reply signature mismatch');
  }
  // The signature covers the wire string; make sure no caller swapped in a
  // different numeric amount while reusing that string.
  if (!/^\d+$/.test(reply.balanceRaw)) {
    throw new WalletError(502, 'BALANCE_SIGNATURE_INVALID', 'Balance reply amount is malformed');
  }
  if (BigInt(reply.balanceRaw) !== reply.balance) {
    throw new WalletError(502, 'BALANCE_SIGNATURE_INVALID', 'Balance reply amount does not match its signed value');
  }
  // A non-finite timestamp makes the skew comparison below vacuously false, so
  // it must be rejected explicitly or the freshness check fails open.
  if (!Number.isFinite(reply.timestamp) || Math.abs(nowMs - reply.timestamp * 1000) > skewMs) {
    throw new WalletError(502, 'BALANCE_STALE', 'Balance reply timestamp outside allowed skew');
  }
}

interface WalletConfig {
  callbackUrl: string;
  hmacSecret: string;
  operatorCode?: string;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Our only abort source is the request timeout, so an aborted body read means
 * the call timed out. `fetch` reports that as `TimeoutError` in newer runtimes
 * and `AbortError` in older ones; everything else is a transport failure.
 */
function transportErrorCode(error: unknown): 'TIMEOUT' | 'NETWORK' {
  const name = (error as Error | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
}

function transportError(error: unknown, phase: string): WalletError {
  const code = transportErrorCode(error);
  const message = (error as Error | undefined)?.message;
  return new WalletError(null, code, `Wallet call failed during ${phase}: ${message ?? code}`);
}

/** A non-negative integer amount on the wire, as a decimal string or a safe integer. */
function decimalString(value: unknown, field: string, invalid: (field: string) => WalletError): string {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw invalid(field);
}

export class HttpWalletClient implements WalletClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly cfg: WalletConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.timeoutMs = cfg.timeoutMs ?? 3000;
  }

  private async post(body: Record<string, unknown>): Promise<{ status: number; data: Json }> {
    const raw = JSON.stringify(body);
    let response: Response;
    try {
      response = await this.fetchImpl(this.cfg.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-provider-signature': signBody(this.cfg.hmacSecret, raw, this.cfg.operatorCode) },
        body: raw,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw transportError(error, 'request');
    }

    // Read the body as text and parse it explicitly: `response.json().catch()`
    // would turn an abort or a truncated body into a silent `{}`.
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text()) as unknown;
    } catch (error) {
      const name = (error as Error | undefined)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw transportError(error, 'response body read');
      }
      if (!response.ok) {
        throw new WalletError(
          response.status,
          'WALLET_HTTP_ERROR',
          `Wallet responded ${response.status} with an unreadable body`,
        );
      }
      throw new WalletError(response.status, 'WALLET_RESPONSE_INVALID', 'Wallet reply body is not valid JSON');
    }

    if (!response.ok) {
      const errorBody = isPlainObject(payload) && isPlainObject(payload.error) ? payload.error : {};
      const code = typeof errorBody.code === 'string' && errorBody.code.length > 0 ? errorBody.code : 'WALLET_HTTP_ERROR';
      const message =
        typeof errorBody.message === 'string' && errorBody.message.length > 0
          ? errorBody.message
          : `Wallet responded ${response.status}`;
      throw new WalletError(response.status, code, message);
    }
    if (!isPlainObject(payload)) {
      throw new WalletError(response.status, 'WALLET_RESPONSE_INVALID', 'Wallet reply body is not a JSON object');
    }
    if (payload.data !== undefined && !isPlainObject(payload.data)) {
      throw new WalletError(response.status, 'WALLET_RESPONSE_INVALID', 'Wallet reply "data" is not a JSON object');
    }
    return { status: response.status, data: payload.data ?? {} };
  }

  async balance(sessionToken: string, nonce: string): Promise<BalanceReply> {
    const { status, data } = await this.post({ type: 'balance', sessionId: sessionToken, nonce });
    const invalid = (field: string) =>
      new WalletError(status, 'WALLET_RESPONSE_INVALID', `Wallet balance reply field "${field}" is missing or malformed`);
    const amount = (field: string) => BigInt(decimalString(data[field], field, invalid));
    const optionalAmount = (field: string) => (data[field] === undefined || data[field] === null ? null : amount(field));

    const balanceRaw = decimalString(data.balance, 'balance', invalid);
    const timestamp = data.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      throw invalid('timestamp');
    }
    if (typeof data.currency !== 'string' || data.currency.length === 0) {
      throw invalid('currency');
    }
    // A missing or non-string signature would otherwise reach verifyBalanceReply
    // as the literal 'undefined' and pass the freshness checks first.
    if (typeof data.signature !== 'string' || data.signature.length === 0) {
      throw new WalletError(status, 'BALANCE_SIGNATURE_INVALID', 'Wallet balance reply signature is missing');
    }
    const replyNonce = data.nonce === undefined || data.nonce === null ? nonce : data.nonce;
    if (typeof replyNonce !== 'string' || replyNonce.length === 0) {
      throw invalid('nonce');
    }

    return {
      currency: data.currency,
      balance: BigInt(balanceRaw),
      balanceRaw,
      timestamp,
      nonce: replyNonce,
      signature: data.signature,
      minStake: optionalAmount('minStake'),
      maxStake: optionalAmount('maxStake'),
      maxWin: optionalAmount('maxWin'),
    };
  }

  private async movement(type: 'bet' | 'win' | 'rollback', input: MovementInput): Promise<MovementReply> {
    const { status, data } = await this.post({
      type,
      sessionId: input.sessionToken,
      txnId: input.txnId,
      amount: input.amount.toString(),
      roundId: input.roundId,
    });
    const invalid = (field: string) =>
      new WalletError(status, 'WALLET_RESPONSE_INVALID', `Wallet ${type} reply field "${field}" is missing or malformed`);
    return {
      accepted: Boolean(data.accepted),
      replayed: Boolean(data.replayed),
      balance:
        data.balance === undefined || data.balance === null ? null : BigInt(decimalString(data.balance, 'balance', invalid)),
    };
  }

  bet(input: MovementInput) { return this.movement('bet', input); }
  win(input: MovementInput) { return this.movement('win', input); }
  rollback(input: MovementInput) { return this.movement('rollback', input); }
}
