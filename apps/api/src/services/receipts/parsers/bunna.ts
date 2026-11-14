/**
 * Bunna International Bank.
 *
 * The shared receipt link is https://online.bunnabanksc.com/receipt/#/{token}
 * where the token is an opaque, URL-encoded base64 string in the fragment. An
 * Angular app reads it and asks:
 *
 *   https://online.bunnabanksc.com/st_backend/api/v1/advice?data={token}
 *
 * which answers {"status":"SUCCESS","receipt":{...}} or a FAILURE envelope.
 * FAILURE is "could not confirm", never proof that a receipt is fake: Bunna
 * gives the same answer for an unknown token and for its own errors.
 *
 * The record carries Bunna's transaction reference (tranId), not the token, so
 * the token is an opaque lookup key. Accounts are masked before leaving the
 * parser.
 */
import { BankParser, NotFoundError } from './base';
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';

const RAW_SAFE_KEYS = ['tranId', 'tranDate', 'amount', 'currency', 'tranType', 'typeOfService'] as const;

function text(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.toLowerCase() === 'null') return undefined;
  return s;
}

export function maskBunnaAccount(v: unknown): string | undefined {
  const s = text(v)?.replace(/\s+/g, '');
  if (!s) return undefined;
  if (/^[^*]{0,4}\*+[^*]{0,4}$/.test(s)) return s;
  if (s.length <= 5) return '*'.repeat(s.length);
  return `${s[0]}${'*'.repeat(s.length - 5)}${s.slice(-4)}`;
}

function dateOnly(v: unknown): string | undefined {
  const s = text(v);
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T]00:00(?::00(?:\.0+)?)?)?$/.exec(s);
  return m ? m[1] : s;
}

function amountOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function safeRaw(row: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const k of RAW_SAFE_KEYS) if (k in row) out[k] = row[k];
  if ('drAccount' in row) out.drAccount = maskBunnaAccount(row.drAccount) ?? null;
  if ('crAccount' in row) out.crAccount = maskBunnaAccount(row.crAccount) ?? null;
  return JSON.stringify(out).slice(0, 1000);
}

export class BunnaParser extends BankParser {
  readonly key = 'bunna';

  buildUrl(input: NormalizedInput): string {
    return `https://online.bunnabanksc.com/st_backend/api/v1/advice?data=${encodeURIComponent(input.reference)}`;
  }

  requestHeaders(): Record<string, string> {
    return { Accept: 'application/json' };
  }

  protected parseBody(body: Buffer): ParsedReceipt {
    const { parsed, notFound } = BunnaParser.parseAdvice(body);
    if (notFound) throw new NotFoundError('Bunna has no receipt for this link.');
    return parsed;
  }

  static parseAdvice(data: Buffer): { parsed: ParsedReceipt; notFound: boolean } {
    let doc: unknown;
    try {
      doc = JSON.parse(data.toString('utf8').trim());
    } catch {
      return { parsed: { verified: false }, notFound: false };
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { parsed: { verified: false }, notFound: false };
    const d = doc as Record<string, unknown>;
    const status = typeof d.status === 'string' ? d.status.trim().toUpperCase() : '';
    if (status === 'FAILURE') return { parsed: { verified: false }, notFound: true };
    if (status !== 'SUCCESS') return { parsed: { verified: false }, notFound: false };
    const row = d.receipt;
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { parsed: { verified: false }, notFound: false };
    const r = row as Record<string, unknown>;

    return {
      parsed: {
        verified: true,
        senderName: text(r.drAccountName),
        senderAccount: maskBunnaAccount(r.drAccount),
        receiverName: text(r.crAccountName),
        receiverAccount: maskBunnaAccount(r.crAccount),
        amount: amountOf(r.amount),
        currency: text(r.currency) ?? 'ETB',
        date: dateOnly(r.tranDate),
        reference: text(r.tranId),
        transactionType: text(r.typeOfService) ?? text(r.tranType),
      },
      notFound: false,
    };
  }
}
