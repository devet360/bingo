import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { balanceSignatureInput } from '../server/wallet';

/**
 * A fake bingo wallet for contract tests. It mirrors `POST
 * /api/games/callback/:providerCode` in apps/api: HMAC over the raw body,
 * `{ data }` / `{ error: { code, message } }` envelopes, 201 on first
 * application and 200 on replay, signed balance replies, 409 on insufficient
 * funds and 404 on a rollback of an unknown transaction.
 */

export const FAKE_BINGO_TOKEN = '8f14e45f-ceea-4a67-9c2b-1a2b3c4d5e6f';

export interface FakeBingoLimits {
  minStake: bigint;
  maxStake: bigint;
  maxWin: bigint;
}

export interface FakeBingoOptions {
  hmacSecret: string;
  balance: bigint;
  currency?: string;
  /** Delays the bet response only, before the movement is applied. */
  betDelayMs?: number;
}

export interface FakeBingoCall {
  type: string;
  status: number;
  signatureValid: boolean;
  txnId: string | null;
  replayed: boolean;
}

export interface FakeBingoState {
  balance: bigint;
  currency: string;
  applied: string[];
  limits: FakeBingoLimits;
  calls: FakeBingoCall[];
}

export interface FakeBingo {
  /** Base URL, e.g. `http://127.0.0.1:PORT`. */
  readonly url: string;
  /** The one session id this fake wallet knows about. */
  readonly token: string;
  state(): FakeBingoState;
  setLimits(limits: Partial<FakeBingoLimits>): void;
  /** Stops the server; resolves once it is no longer accepting requests. */
  close(): Promise<void>;
}

const DEFAULT_LIMITS: FakeBingoLimits = { minStake: 100n, maxStake: 100_000n, maxWin: 3_000_000n };
const CALLBACK_TYPES = ['balance', 'bet', 'win', 'rollback'] as const;
type CallbackType = (typeof CALLBACK_TYPES)[number];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALLBACK_PATH_RE = /^\/api\/games\/callback\/[A-Za-z0-9_-]+$/;
const MAX_BODY_BYTES = 1_000_000;

interface AppliedMovement {
  type: 'bet' | 'win';
  amount: bigint;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bytes in, bytes out: never re-serialize before verifying. */
function hmacHex(secret: string, raw: Buffer): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function signatureValid(secret: string, raw: Buffer, header: string | string[] | undefined): boolean {
  if (typeof header !== 'string' || header.length === 0) return false;
  const expected = Buffer.from(hmacHex(secret, raw), 'utf8');
  const given = Buffer.from(header.replace(/^sha256=/, '').toLowerCase(), 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: Json): void {
  if (res.writableEnded || res.destroyed) return;
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw).toString(),
  });
  res.end(raw);
}

const sendData = (res: ServerResponse, status: number, data: Json): void => send(res, status, { data });
const sendError = (res: ServerResponse, status: number, code: string, message: string): void =>
  send(res, status, { error: { code, message } });

/** Positive integer minor units, as a decimal string or an integer number. */
function parseAmount(value: unknown): bigint | null {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return null;
    const amount = BigInt(value);
    return amount > 0n ? amount : null;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return BigInt(value);
  }
  return null;
}

export async function createFakeBingo(options: FakeBingoOptions): Promise<FakeBingo> {
  const secret = options.hmacSecret;
  const currency = (options.currency ?? 'ETB').toUpperCase();
  const limits: FakeBingoLimits = { ...DEFAULT_LIMITS };
  const applied = new Set<string>();
  const movements = new Map<string, AppliedMovement>();
  const rolledBack = new Set<string>();
  const calls: FakeBingoCall[] = [];
  let balance = options.balance;
  let closed = false;

  const pendingWaits = new Set<() => void>();

  function wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        pendingWaits.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      pendingWaits.add(finish);
    });
  }

  function record(call: FakeBingoCall): void {
    calls.push(call);
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !CALLBACK_PATH_RE.test(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)) {
      sendError(res, 404, 'NOT_FOUND', 'Route not found');
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRawBody(req);
    } catch {
      sendError(res, 400, 'CALLBACK_MALFORMED', 'Request body could not be read');
      return;
    }

    const signed = signatureValid(secret, raw, req.headers['x-provider-signature']);
    let body: unknown;
    try {
      body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    } catch {
      record({ type: 'malformed', status: 400, signatureValid: signed, txnId: null, replayed: false });
      sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
      return;
    }

    if (!signed) {
      record({ type: 'malformed', status: 403, signatureValid: false, txnId: null, replayed: false });
      sendError(res, 403, 'SIGNATURE_INVALID', 'Invalid provider signature');
      return;
    }
    if (!isRecord(body) || !CALLBACK_TYPES.includes(body.type as CallbackType)) {
      record({ type: 'malformed', status: 400, signatureValid: true, txnId: null, replayed: false });
      sendError(res, 400, 'CALLBACK_MALFORMED', 'Provider callback body is invalid');
      return;
    }

    const type = body.type as CallbackType;
    const sessionId = body.sessionId;
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
      record({ type, status: 400, signatureValid: true, txnId: null, replayed: false });
      sendError(res, 400, 'CALLBACK_MALFORMED', 'sessionId must be a UUID');
      return;
    }
    if (sessionId !== FAKE_BINGO_TOKEN) {
      record({ type, status: 404, signatureValid: true, txnId: null, replayed: false });
      sendError(res, 404, 'NOT_FOUND', 'Game session not found');
      return;
    }
    if (body.currency !== undefined) {
      if (typeof body.currency !== 'string' || body.currency.toUpperCase() !== currency) {
        record({ type, status: 400, signatureValid: true, txnId: null, replayed: false });
        sendError(res, 400, 'CURRENCY_MISMATCH', `Session settles in ${currency}`);
        return;
      }
    }

    if (type === 'balance') {
      if (body.nonce !== undefined && (typeof body.nonce !== 'string' || body.nonce.length > 64)) {
        record({ type, status: 400, signatureValid: true, txnId: null, replayed: false });
        sendError(res, 400, 'CALLBACK_MALFORMED', 'nonce must be a string of at most 64 characters');
        return;
      }
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = typeof body.nonce === 'string' ? body.nonce : randomUUID();
      const balanceRaw = balance.toString();
      const signature = createHmac('sha256', secret)
        .update(balanceSignatureInput({ sessionId, currency, balance: balanceRaw, timestamp, nonce }))
        .digest('hex');
      record({ type, status: 200, signatureValid: true, txnId: null, replayed: false });
      sendData(res, 200, {
        currency,
        balance: balanceRaw,
        timestamp,
        nonce,
        signature,
        minStake: limits.minStake.toString(),
        maxStake: limits.maxStake.toString(),
        maxWin: limits.maxWin.toString(),
      });
      return;
    }

    const txnId = body.txnId;
    const amount = parseAmount(body.amount);
    const roundId = body.roundId;
    if (
      typeof txnId !== 'string' ||
      txnId.length === 0 ||
      txnId.length > 128 ||
      amount === null ||
      (roundId !== undefined && (typeof roundId !== 'string' || roundId.length > 128))
    ) {
      record({ type, status: 400, signatureValid: true, txnId: typeof txnId === 'string' ? txnId : null, replayed: false });
      sendError(res, 400, 'CALLBACK_MALFORMED', 'Provider callback body is invalid');
      return;
    }

    const movementReply = (replayed: boolean): Json => ({
      accepted: true,
      replayed,
      balance: balance.toString(),
    });

    if (type === 'rollback') {
      const rollbackKey = `rollback:${txnId}`;
      if (applied.has(rollbackKey)) {
        record({ type, status: 200, signatureValid: true, txnId, replayed: true });
        sendData(res, 200, movementReply(true));
        return;
      }
      const originalKey = applied.has(`bet:${txnId}`)
        ? `bet:${txnId}`
        : applied.has(`win:${txnId}`)
          ? `win:${txnId}`
          : null;
      const original = originalKey ? movements.get(originalKey) : undefined;
      if (!original) {
        // Bingo answers 404 NOT_FOUND when the referenced movement was never applied;
        // ROLLBACK_INVALID is reserved for a non-reversible original (409).
        record({ type, status: 404, signatureValid: true, txnId, replayed: false });
        sendError(res, 404, 'NOT_FOUND', 'Original transaction not found');
        return;
      }
      if (original.amount !== amount) {
        record({ type, status: 409, signatureValid: true, txnId, replayed: false });
        sendError(res, 409, 'ROLLBACK_AMOUNT_MISMATCH', 'Rollback amount does not match the original transaction');
        return;
      }
      balance = original.type === 'bet' ? balance + amount : balance - amount;
      applied.add(rollbackKey);
      rolledBack.add(txnId);
      record({ type, status: 201, signatureValid: true, txnId, replayed: false });
      sendData(res, 201, movementReply(false));
      return;
    }

    // bet | win
    if (options.betDelayMs !== undefined && type === 'bet') {
      await wait(options.betDelayMs);
      // The client may have timed out while we slept: apply nothing.
      if (closed || res.writableEnded || res.destroyed) return;
    }

    const movementKey = `${type}:${txnId}`;
    const oppositeKey = type === 'bet' ? `win:${txnId}` : `bet:${txnId}`;
    if (applied.has(oppositeKey)) {
      record({ type, status: 409, signatureValid: true, txnId, replayed: false });
      sendError(res, 409, 'TXN_TYPE_MISMATCH', 'Transaction id was already used for a different movement');
      return;
    }
    if (rolledBack.has(txnId)) {
      record({ type, status: 409, signatureValid: true, txnId, replayed: false });
      sendError(res, 409, 'TRANSACTION_ROLLED_BACK', 'Transaction was rolled back');
      return;
    }
    if (applied.has(movementKey)) {
      record({ type, status: 200, signatureValid: true, txnId, replayed: true });
      sendData(res, 200, movementReply(true));
      return;
    }
    if (type === 'win' && amount > limits.maxWin) {
      record({ type, status: 409, signatureValid: true, txnId, replayed: false });
      sendError(res, 409, 'WIN_LIMIT_EXCEEDED', `Win exceeds the ${limits.maxWin.toString()} minor-unit ceiling`);
      return;
    }
    if (type === 'bet' && balance < amount) {
      record({ type, status: 409, signatureValid: true, txnId, replayed: false });
      sendError(res, 409, 'INSUFFICIENT_FUNDS', 'Insufficient available balance');
      return;
    }

    balance = type === 'bet' ? balance - amount : balance + amount;
    applied.add(movementKey);
    movements.set(movementKey, { type, amount });
    record({ type, status: 201, signatureValid: true, txnId, replayed: false });
    sendData(res, 201, movementReply(false));
  }

  const server = createServer((req, res) => {
    if (closed) {
      res.destroy();
      return;
    }
    handler(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'INTERNAL_ERROR', 'Provider callback failed');
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  let closing: Promise<void> | null = null;

  return {
    url: `http://127.0.0.1:${port}`,
    token: FAKE_BINGO_TOKEN,
    state: () => ({
      balance,
      currency,
      applied: [...applied],
      limits: { ...limits },
      calls: calls.map((call) => ({ ...call })),
    }),
    setLimits: (next) => {
      if (next.minStake !== undefined) limits.minStake = next.minStake;
      if (next.maxStake !== undefined) limits.maxStake = next.maxStake;
      if (next.maxWin !== undefined) limits.maxWin = next.maxWin;
    },
    close: () => {
      if (closing) return closing;
      closed = true;
      // Drop delayed bets instead of leaving them half applied.
      for (const finish of [...pendingWaits]) finish();
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
