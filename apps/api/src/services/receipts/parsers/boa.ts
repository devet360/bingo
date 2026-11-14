/**
 * Bank of Abyssinia.
 *
 * Endpoint: https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id={ref}{account}
 * Requires the last 5 digits of an account on the receipt. Not always the
 * receiver's: a fee receipt with no receiver uses the source account.
 *
 * BOA answers an unknown reference with HTTP 200 and a row whose "Payer's
 * Name" is the literal "Invalid reference number". That is a not-found; any
 * other unexpected shape is simply not a receipt.
 */
import { BankParser, NotFoundError } from './base';
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';
import { parseMoney } from '../text';

function text(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function money(v: unknown): number | undefined {
  const s = text(v);
  return s === undefined ? undefined : parseMoney(s);
}

export class BoaParser extends BankParser {
  readonly key = 'boa';

  buildUrl(input: NormalizedInput): string {
    return `https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id=${encodeURIComponent(
      input.reference,
    )}${input.accountNumber ?? ''}`;
  }

  protected parseBody(body: Buffer): ParsedReceipt {
    let row: Record<string, unknown> | undefined;
    try {
      const payload = JSON.parse(body.toString('utf8')) as { body?: unknown };
      const first = Array.isArray(payload?.body) ? payload.body[0] : undefined;
      if (first && typeof first === 'object' && !Array.isArray(first)) row = first as Record<string, unknown>;
    } catch {
      return { verified: false };
    }

    if (!row) return { verified: false };
    if (row["Payer's Name"] === 'Invalid reference number') {
      throw new NotFoundError('Bank of Abyssinia has no receipt for this reference and account.');
    }

    return {
      verified: true,
      senderName: text(row['Source Account Name']) ?? text(row["Payer's Name"]),
      senderAccount: text(row['Source Account']),
      receiverName: text(row["Receiver's Name"]),
      receiverAccount: text(row["Receiver's Account"]),
      amount: money(row['Transferred Amount']),
      currency: text(row.currency) ?? 'ETB',
      date: text(row['Transaction Date']),
      reference: text(row['Transaction Reference']),
      transactionType: text(row['Transaction Type']),
      amountInWords: text(row['Transferred Amount in word']),
      serviceFee: money(row['Service Charge']),
      totalPaid: money(row['Total Amount including VAT']),
      reason: text(row['Payment Reference']) ?? text(row.Narrative),
    };
  }
}
