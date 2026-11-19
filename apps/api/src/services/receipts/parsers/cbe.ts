/**
 * Commercial Bank of Ethiopia, legacy branch receipt.
 *
 * The CBE app receipt API (mb.cbe.com.et) has been down since late 2026. The
 * legacy branch receipt endpoint still answers, keyed by the FT reference and
 * the last eight digits of the receiving account:
 *
 *   https://apps.cbe.com.et:100/BranchReceipt/{reference}&{accountSuffix}
 *
 * It answers a PDF. A reference the bank does not know, or an account suffix
 * that does not belong to the receiving account, comes back as a JSON
 * `{"status":"failed",...}` body (HTTP 500 for an unknown reference, HTTP 200
 * "Please Check Your Link" for a bad suffix) — a not-found, not an outage.
 *
 * The PDF prints the reference as "Reference No. (VAT Invoice No)", the
 * credited amount as "Transferred Amount", and masks both accounts to their
 * last digits ("1****5909").
 */
import { BankParser, NotFoundError } from './base';
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';
import { ReferenceError } from '../types';
import type { SafeResponse } from '../http';
import { extractPdfText, isPdf, parseMoney } from '../text';

const LEGACY_BASE = 'https://apps.cbe.com.et:100/BranchReceipt/';

const FAILED_BODY_RE = /"status"\s*:\s*"failed"|please check your link|receipt data is not correct/i;

/** Strip a label from the front of a line, or return undefined. */
function after(label: string, line: string): string | undefined {
  if (!line.startsWith(label)) return undefined;
  const v = line.slice(label.length).trim();
  return v || undefined;
}

export class CbeParser extends BankParser {
  readonly key = 'cbe';
  readonly pdfResponse = true;

  buildUrl(input: NormalizedInput): string {
    if (!input.accountNumber) {
      throw new ReferenceError('Enter at least the last 8 digits of the receiving account.');
    }
    return `${LEGACY_BASE}${encodeURIComponent(input.reference)}&${encodeURIComponent(input.accountNumber)}`;
  }

  isNotFoundResponse(resp: SafeResponse): boolean {
    return FAILED_BODY_RE.test(resp.body.toString('utf8').slice(0, 2000));
  }

  protected async parseBody(body: Buffer): Promise<ParsedReceipt> {
    if (!isPdf(body)) {
      if (FAILED_BODY_RE.test(body.toString('utf8').slice(0, 2000))) {
        throw new NotFoundError('CBE has no receipt for this reference and receiving account.');
      }
      return { verified: false };
    }
    return CbeParser.parseText(await extractPdfText(body));
  }

  /** Read the legacy receipt from the PDF's text. */
  static parseText(text: string): ParsedReceipt {
    const lines = text
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    let senderName: string | undefined;
    let senderAccount: string | undefined;
    let receiverName: string | undefined;
    let receiverAccount: string | undefined;
    let date: string | undefined;
    let reference: string | undefined;
    let amount: number | undefined;
    let totalDebited: number | undefined;
    let party: 'sender' | 'receiver' | undefined;

    for (const line of lines) {
      const payer = after('Payer', line);
      if (payer) {
        senderName = payer;
        party = 'sender';
        continue;
      }
      const receiver = after('Receiver', line);
      if (receiver) {
        receiverName = receiver;
        party = 'receiver';
        continue;
      }
      const account = after('Account', line);
      if (account) {
        if (party === 'sender' && !senderAccount) senderAccount = account;
        else if (party === 'receiver' && !receiverAccount) receiverAccount = account;
        continue;
      }
      if (/^(?:\d+\s+)?Payment Date & Time/i.test(line)) {
        date = line.replace(/^(?:\d+\s+)?Payment Date & Time/i, '').trim() || undefined;
        continue;
      }
      if (/^Reference No\./i.test(line)) {
        // The reference is printed on the same line, glued to the label.
        const v = line.replace(/^Reference No\.\s*\(VAT Invoice No\)\s*/i, '').trim();
        if (v && v !== line) reference = v;
        continue;
      }
      if (/^VAT Receipt No:/i.test(line) && !reference) {
        reference = line.replace(/^VAT Receipt No:\s*/i, '').trim() || undefined;
        continue;
      }
      if (/^Transferred Amount/i.test(line) && amount === undefined) {
        amount = parseMoney(line.replace(/^Transferred Amount\s*/i, ''));
        continue;
      }
      if (/^Total amount debited/i.test(line) && totalDebited === undefined) {
        totalDebited = parseMoney(line.replace(/^Total amount debited[^\d]*/i, ''));
      }
    }

    // What the receiver got is the credited amount; the debited total only
    // moves when CBE charges a commission on top.
    const credited = amount ?? totalDebited;

    return {
      verified: !!(credited !== undefined && credited > 0 && (senderName || receiverName || senderAccount || receiverAccount)),
      amount: credited,
      currency: 'ETB',
      senderName,
      senderAccount,
      receiverName,
      receiverAccount,
      date,
      reference,
      reason: 'Branch receipt',
    };
  }
}
