/**
 * Awash Bank.
 *
 * Endpoint: https://awashpay.awashbank.com:8225/-{shareToken}
 * The link carries a share token from the Awash app. The numeric Transaction
 * ID printed on the mobile receipt is not the same token, so users must paste
 * the full share link. The token is opaque: the gate does not compare the
 * returned Transaction ID with it.
 */
import { BankParser, NotFoundError } from './base';
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';
import { htmlToLines, parseMoney } from '../text';

function findValue(lines: string[], label: string, startIndex = 0): string | undefined {
  const lowerLabel = label.toLowerCase();

  // Exact label line ("Amount", "Amount:", "Amount="): the value is below it.
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]!.trim().toLowerCase();
    if (line === lowerLabel || line === `${lowerLabel}:` || line === `${lowerLabel}=`) {
      if (i + 1 < lines.length) {
        let j = i + 1;
        if (lines[j] === ':' && j + 1 < lines.length) j++;
        return lines[j];
      }
    }
  }

  // "Label: value" on one line.
  for (let i = startIndex; i < lines.length; i++) {
    if (lines[i]!.toLowerCase().includes(lowerLabel)) {
      const sameLine = lines[i]!.match(new RegExp(`${label}\\s*[:=]\\s*(.+)$`, 'i'));
      if (sameLine) return sameLine[1]!.trim();
    }
  }

  // Label alone, value on the next line. Reject compound labels ("Merchant
  // Payment" when looking for "Merchant").
  for (let i = startIndex; i < lines.length; i++) {
    if (lines[i]!.toLowerCase().includes(lowerLabel)) {
      const remainder = lines[i]!.replace(new RegExp(`^.*?${label}`, 'i'), '').trim().toLowerCase();
      if (remainder && !remainder.startsWith(':')) continue;
      if (i + 1 < lines.length) {
        let j = i + 1;
        if (lines[j] === ':' && j + 1 < lines.length) j++;
        return lines[j];
      }
    }
  }

  return undefined;
}

export class AwashParser extends BankParser {
  readonly key = 'awash';

  buildUrl(input: NormalizedInput): string {
    return `https://awashpay.awashbank.com:8225/-${encodeURIComponent(input.reference)}`;
  }

  protected parseBody(body: Buffer): ParsedReceipt {
    const raw = body.toString('utf8');
    if (/invalid receipt/i.test(raw)) {
      throw new NotFoundError('Awash has no receipt for this link.');
    }

    const lines = htmlToLines(raw);

    const senderName = findValue(lines, 'Sender Name') || findValue(lines, 'Customer Name');
    const senderAccount =
      findValue(lines, 'Sender Account') || findValue(lines, 'Source Account') || findValue(lines, 'Account No');
    const receiverName =
      findValue(lines, 'Receiver Name') ||
      findValue(lines, 'Beneficiary name') ||
      findValue(lines, 'Merchant') ||
      findValue(lines, 'Recipient');
    const receiverAccount =
      findValue(lines, 'Receiver Account') ||
      findValue(lines, 'Beneficiary Account') ||
      findValue(lines, 'Till Number') ||
      findValue(lines, 'Recipient') ||
      findValue(lines, 'Phone Number');

    const reason = findValue(lines, 'Reason');
    const transactionType = findValue(lines, 'Transaction Type') || findValue(lines, 'Transaction type');
    const branch = findValue(lines, 'Branch');
    const transactionId = findValue(lines, 'Transaction ID');
    const date = findValue(lines, 'Transaction Date') || findValue(lines, 'Transaction Time');

    let amount: number | undefined;
    const amountStr = findValue(lines, 'Amount');
    if (amountStr) amount = parseMoney(amountStr);

    return {
      verified:
        !!senderName &&
        !!senderAccount &&
        (!!receiverName || !!receiverAccount) &&
        amount !== undefined &&
        !!date,
      reference: transactionId,
      senderName,
      senderAccount,
      receiverName,
      receiverAccount,
      amount,
      currency: 'ETB',
      date,
      branch,
      reason,
      transactionType,
    };
  }
}
