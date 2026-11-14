/**
 * ZamZam Bank.
 *
 * Shared link: https://receipt.zamzambank.com.et/receipt/{id}
 * Data endpoint: https://receipt-backend.zamzambank.com.et/api/v1/invoice/{id}
 *
 * The endpoint expects HTTP Basic auth with the credential hardcoded in
 * ZamZam's own public receipt web app (every visitor's browser sends it, so it
 * identifies the app, not a person). It is sent as a header only, never in a
 * URL or a response. An unknown id is HTTP 200 with the body `null`.
 *
 * The record's `drcr` flag is from the account holder's point of view: "D"
 * means the holder paid, "C" means the holder received. `other_NAME` is the
 * counterparty. Account numbers are masked before leaving the parser.
 */
import { BankParser, NotFoundError } from './base';
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';
import { parseMoney } from '../text';

const BASIC_CREDENTIAL = Buffer.from('zzbmob:zzb@12#2024', 'utf8').toString('base64');
const RAW_SAFE_KEYS = ['id', 'reference', 'amount', 'vat', 'dt', 'drcr', 'currency', 'code', 'trn_DESCRIPTION'] as const;

function text(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.toUpperCase() === 'NULL') return undefined;
  return s;
}

function maskAccount(v: unknown): string | undefined {
  const s = text(v)?.replace(/\s+/g, '');
  if (!s) return undefined;
  if (s.length <= 5) return '*'.repeat(s.length);
  return `${s[0]}${'*'.repeat(s.length - 5)}${s.slice(-4)}`;
}

function dateOnly(v: unknown): string | undefined {
  const s = text(v);
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T]00:00(?::00(?:\.0+)?)?)?$/.exec(s);
  return m ? m[1] : s;
}

function safeRaw(row: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const k of RAW_SAFE_KEYS) if (k in row) out[k] = row[k];
  if ('acc_NUM' in row) out.acc_NUM = maskAccount(row.acc_NUM) ?? null;
  return JSON.stringify(out).slice(0, 1000);
}

export class ZamzamParser extends BankParser {
  readonly key = 'zamzam';

  requestHeaders(): Record<string, string> {
    return { Accept: 'application/json', Authorization: `Basic ${BASIC_CREDENTIAL}` };
  }

  buildUrl(input: NormalizedInput): string {
    return `https://receipt-backend.zamzambank.com.et/api/v1/invoice/${encodeURIComponent(input.reference)}`;
  }

  protected parseBody(body: Buffer, _contentType: string, input: NormalizedInput): ParsedReceipt {
    const { parsed, notFound } = ZamzamParser.parseRecord(body, input.reference);
    if (notFound) throw new NotFoundError('ZamZam has no receipt for this id.');
    return parsed;
  }

  /**
   * `requestedId` must equal the record's own `id`: the record is looked up by
   * that id, so a different id means the answer is not for this receipt.
   */
  static parseRecord(data: Buffer, requestedId?: string): { parsed: ParsedReceipt; notFound: boolean } {
    let row: unknown;
    try {
      row = JSON.parse(data.toString('utf8').trim());
    } catch {
      return { parsed: { verified: false }, notFound: false };
    }
    if (row === null) return { parsed: { verified: false }, notFound: true };
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { parsed: { verified: false }, notFound: false };
    const r = row as Record<string, unknown>;

    const recordId = text(r.id);
    if (!recordId || (requestedId !== undefined && recordId !== requestedId.trim())) {
      return { parsed: { verified: false }, notFound: true };
    }

    const holder = { name: text(r.name), account: maskAccount(r.acc_NUM) };
    const other = text(r.other_NAME);
    const side = text(r.drcr)?.toUpperCase();
    const sender = side === 'D' ? holder : side === 'C' ? { name: other, account: undefined } : undefined;
    const receiver = side === 'C' ? holder : side === 'D' ? { name: other, account: undefined } : undefined;

    return {
      parsed: {
        verified: true,
        senderName: sender?.name,
        senderAccount: sender?.account,
        receiverName: receiver?.name,
        receiverAccount: receiver?.account,
        amount: parseMoney(text(r.amount)),
        currency: text(r.currency) ?? 'ETB',
        date: dateOnly(r.dt),
        reference: text(r.reference),
        transactionType: text(r.trn_DESCRIPTION),
      },
      notFound: false,
    };
  }
}
