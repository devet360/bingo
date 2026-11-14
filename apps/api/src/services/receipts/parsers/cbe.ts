/**
 * Commercial Bank of Ethiopia, current receipt format.
 *
 * The CBE app shares a receipt as https://mbreciept.cbe.com.et/{receiptId} or
 * a QR code. The page itself carries no data; the JSON API answers with the
 * record:
 *
 *   https://mb.cbe.com.et/api/v1/transactions/public/transaction-detail/{id}
 *
 * The API needs the CBE web app's X-App-ID / X-App-Version headers, and
 * answers an unknown or tampered token with HTTP 500 problem+json
 * "Invalid or tampered legacy token", which is a not-found, not an outage.
 *
 * The older FT reference + receiving-account PDF endpoint (apps.cbe.com.et)
 * has been unreachable since July 2026 and is not offered as a deposit rail.
 */
import { BankParser, NotFoundError } from './base';
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';
import type { SafeResponse } from '../http';
import { parseMoney } from '../text';

/** The CBE web app's public headers, needed by the JSON API. */
const CBE_HEADERS: Record<string, string> = {
  'X-App-ID': 'd1292e42-7400-49de-a2d3-9731caa4c819',
  'X-App-Version': '0a01980b-9859-1369-8198-59f403820000',
  Origin: 'https://mbreciept.cbe.com.et',
  Referer: 'https://mbreciept.cbe.com.et/',
  Accept: 'application/json',
};

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export class CbeParser extends BankParser {
  readonly key = 'cbe';

  requestHeaders(): Record<string, string> {
    return { ...CBE_HEADERS };
  }

  buildUrl(input: NormalizedInput): string {
    return `https://mb.cbe.com.et/api/v1/transactions/public/transaction-detail/${encodeURIComponent(input.reference)}`;
  }

  isNotFoundResponse(resp: SafeResponse): boolean {
    return /invalid or tampered legacy token/i.test(resp.body.toString('utf8'));
  }

  protected parseBody(body: Buffer): ParsedReceipt {
    let json: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { verified: false };
      json = parsed as Record<string, unknown>;
    } catch {
      return { verified: false };
    }

    const id = str(json.id);
    if (!id) throw new NotFoundError('CBE has no receipt for this Receipt ID.');

    const debitHolder = str(json.debitAccountHolder);
    const creditHolder = str(json.creditAccountHolder);
    const debitAccount = str(json.debitAccountNo);
    const creditAccount = str(json.creditAccountNo);
    // "1,250.00" must not parse as 1.
    const amount = parseMoney(json.amountCredited) ?? parseMoney(json.amountDebited);
    const currency = str(json.creditCurrency) || 'ETB';
    const date = Array.isArray(json.dateTimes) ? str(json.dateTimes[0]) : undefined;
    const reason = Array.isArray(json.paymentDetails) ? str(json.paymentDetails[0]) : undefined;

    return {
      verified: !!(amount !== undefined && amount > 0 && (debitHolder || creditHolder || debitAccount || creditAccount)),
      senderName: debitHolder,
      senderAccount: debitAccount,
      receiverName: creditHolder,
      receiverAccount: creditAccount,
      amount,
      currency,
      date,
      reference: id,
      reason,
    };
  }
}
