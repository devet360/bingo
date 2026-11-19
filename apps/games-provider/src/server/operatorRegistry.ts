import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { OperatorRecord, OperatorSecretRecord } from '../domain/types';
import type { Store } from './store';
import { HttpWalletClient, signBody, verifyBalanceReply, WalletError, type BalanceReply, type WalletClient } from './wallet';

export class OperatorError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'OperatorError';
  }
}

export interface OperatorWallets {
  walletFor(operatorCode: string, fetchImpl?: typeof fetch): Promise<WalletClient>;
}

function sameHex(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class OperatorRegistry implements OperatorWallets {
  private readonly store: Store;

  constructor(deps: { store: Store }) {
    this.store = deps.store;
  }

  async get(code: string): Promise<OperatorRecord> {
    const operator = await this.store.getOperator(code);
    if (operator === null) {
      throw new OperatorError(404, 'OPERATOR_NOT_FOUND', `Unknown operator ${code}`);
    }
    return operator;
  }

  /** Active secrets, newest version first. */
  async listActiveSecrets(code: string): Promise<OperatorSecretRecord[]> {
    const secrets = (await this.store.listOperatorSecrets(code))
      .filter((row) => row.retiredAt === null)
      .sort((a, b) => b.version - a.version);
    if (secrets.length === 0) {
      throw new OperatorError(503, 'OPERATOR_SECRET_MISSING', `No active secret for ${code}`);
    }
    return secrets;
  }

  async signOutbound(code: string, rawBody: string): Promise<string> {
    const [current] = await this.listActiveSecrets(code);
    return signBody(current!.secret, rawBody, code);
  }

  async verifyInbound(code: string, rawBody: Buffer | string, signature: string | undefined): Promise<boolean> {
    if (!signature) return false;
    const raw = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const given = signature.replace(/^sha256=/, '').toLowerCase();
    for (const { secret } of await this.listActiveSecrets(code)) {
      if (sameHex(signBody(secret, raw, code), given)) return true;
      // V1 signed the bare body; keep accepting it while the old deployment drains.
      if (sameHex(signBody(secret, raw), given)) return true;
    }
    return false;
  }

  async verifyBalance(code: string, sessionToken: string, reply: BalanceReply, nowMs: number): Promise<void> {
    let lastError: unknown = null;
    for (const { secret } of await this.listActiveSecrets(code)) {
      try {
        verifyBalanceReply(secret, sessionToken, reply, nowMs);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new WalletError(502, 'BALANCE_SIGNATURE_INVALID', 'No signing secret could verify the balance reply');
  }

  async walletFor(code: string, fetchImpl?: typeof fetch): Promise<WalletClient> {
    const operator = await this.get(code);
    const [current] = await this.listActiveSecrets(code);
    return new HttpWalletClient(
      { callbackUrl: operator.callbackUrl, hmacSecret: current!.secret, operatorCode: operator.code },
      fetchImpl,
    );
  }

  /** Adds a secret, retiring the oldest active one when two are already live. */
  async rotateSecret(code: string): Promise<{ version: number; secret: string }> {
    await this.get(code);
    const active = (await this.store.listOperatorSecrets(code))
      .filter((row) => row.retiredAt === null)
      .sort((a, b) => a.version - b.version);
    if (active.length >= 2) await this.store.retireOperatorSecret(code, active[0]!.version);
    const secret = randomBytes(32).toString('hex');
    // Two rotations racing for the same MAX(version)+1 can collide on the
    // composite primary key (23505). The concurrent winner already advanced the
    // version, so one retry of the same single-statement insert resolves it.
    let row: OperatorSecretRecord;
    try {
      row = await this.store.addOperatorSecret(code, secret);
    } catch (error) {
      // Drizzle wraps driver errors, leaving the pg SQLSTATE on `cause` only.
      const failure = error as { code?: unknown; cause?: { code?: unknown } } | null;
      if ((failure?.code ?? failure?.cause?.code) !== '23505') throw error;
      row = await this.store.addOperatorSecret(code, secret);
    }
    return { version: row.version, secret: row.secret };
  }
}
