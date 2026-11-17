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

export function signBody(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
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
  // Reject malformed hex before it reaches timingSafeEqual, which throws a
  // RangeError on length mismatch and would leak a non-WalletError to callers.
  const givenHex = reply.signature.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(givenHex)) {
    throw new WalletError(502, 'BALANCE_SIGNATURE_INVALID', 'Balance reply signature is malformed');
  }
  const given = Buffer.from(givenHex, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
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
  if (Math.abs(nowMs - reply.timestamp * 1000) > skewMs) {
    throw new WalletError(502, 'BALANCE_STALE', 'Balance reply timestamp outside allowed skew');
  }
}

interface WalletConfig {
  callbackUrl: string;
  hmacSecret: string;
  timeoutMs?: number;
}

export class HttpWalletClient implements WalletClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly cfg: WalletConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.timeoutMs = cfg.timeoutMs ?? 3000;
  }

  private async post(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    let response: Response;
    try {
      response = await this.fetchImpl(this.cfg.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-provider-signature': signBody(this.cfg.hmacSecret, raw) },
        body: raw,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const code = (error as Error)?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
      throw new WalletError(null, code, `Wallet call failed: ${(error as Error)?.message ?? code}`);
    }
    const payload = (await response.json().catch(() => ({}))) as {
      data?: Record<string, unknown>;
      error?: { code?: string; message?: string };
    };
    if (!response.ok) {
      throw new WalletError(
        response.status,
        payload.error?.code ?? 'WALLET_HTTP_ERROR',
        payload.error?.message ?? `Wallet responded ${response.status}`,
      );
    }
    return payload.data ?? {};
  }

  async balance(sessionToken: string, nonce: string): Promise<BalanceReply> {
    const data = await this.post({ type: 'balance', sessionId: sessionToken, nonce });
    const balanceRaw = String(data.balance);
    const opt = (value: unknown) => (value === undefined || value === null ? null : BigInt(String(value)));
    return {
      currency: String(data.currency),
      balance: BigInt(balanceRaw),
      balanceRaw,
      timestamp: Number(data.timestamp),
      nonce: String(data.nonce ?? nonce),
      signature: String(data.signature),
      minStake: opt(data.minStake),
      maxStake: opt(data.maxStake),
      maxWin: opt(data.maxWin),
    };
  }

  private async movement(type: 'bet' | 'win' | 'rollback', input: MovementInput): Promise<MovementReply> {
    const data = await this.post({
      type,
      sessionId: input.sessionToken,
      txnId: input.txnId,
      amount: input.amount.toString(),
      roundId: input.roundId,
    });
    return {
      accepted: Boolean(data.accepted),
      replayed: Boolean(data.replayed),
      balance: data.balance === undefined ? null : BigInt(String(data.balance)),
    };
  }

  bet(input: MovementInput) { return this.movement('bet', input); }
  win(input: MovementInput) { return this.movement('win', input); }
  rollback(input: MovementInput) { return this.movement('rollback', input); }
}
