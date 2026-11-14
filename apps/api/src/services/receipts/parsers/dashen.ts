/**
 * Dashen Bank.
 *
 * Endpoint: https://receipts.dashenbanksc.com/receipt/{ref}
 * The server returns HTML; the "Download Receipt" button renders a PDF in the
 * browser, so a PDF body is only seen when someone pastes one.
 *
 * An unknown reference is HTTP 400 with a JSON "Transaction not found" body.
 * There is no account input: the FT Ref is the lookup key (e.g.
 * B22WDTI00SAMPLE1), not the longer Transaction Ref.
 */
import { BankParser, NotFoundError } from './base';
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';
import { decodeEntities, parseMoney, removeScriptsAndStyles, TAG_RE } from '../text';

export const DASHEN_NOT_FOUND =
  'Dashen has no receipt for this reference. Use the FT Ref (e.g. B22WDTI00SAMPLE1), not the longer Transaction Ref.';

export class DashenParser extends BankParser {
  readonly key = 'dashen';
  readonly notFoundStatuses = [400, 404];
  readonly notFoundMessage = DASHEN_NOT_FOUND;

  buildUrl(input: NormalizedInput): string {
    return `https://receipts.dashenbanksc.com/receipt/${encodeURIComponent(input.reference)}`;
  }

  protected parseBody(body: Buffer): ParsedReceipt {
    const raw = body.toString('utf8');
    if (raw.startsWith('%PDF')) {
      return { verified: false };
    }
    if (/transaction not found/i.test(raw)) throw new NotFoundError(DASHEN_NOT_FOUND);
    return DashenParser.parseText(DashenParser.htmlToText(raw));
  }

  /**
   * Flatten the receipt HTML into the same single-line text the PDF yields.
   * Linear time: no lazy `<script>` or `<[^>]+>` regexes.
   */
  static htmlToText(html: string): string {
    return decodeEntities(removeScriptsAndStyles(html).replace(TAG_RE, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  static parseText(source: string): ParsedReceipt {
    if (!source || !source.includes('Dashen Bank')) {
      return { verified: false };
    }

    // Each value runs from the end of its label to the nearest following label,
    // whatever order the receipt uses.
    const labels = [
      'Sender Name:',
      'Sender Account Number:',
      'Transaction Channel:',
      'Service Type:',
      'Narrative:',
      'Receiver Name:',
      'Beneficiary Bank Name:',
      'Institution Name:',
      'Instituton Name:',
      'Receiver Account Number:',
      'Transaction Reference:',
      'Transfer Reference:',
      'Transaction Date:',
      'Transaction Amount',
      'Service Charge',
      'Excise Tax (15%):',
      'DRRF Fee',
      'VAT (15%):',
      'Penalty Fee',
      'Income Tax Fee',
      'Tax',
      'Interest Fee',
      'Stamp Duty',
      'Discount Amount',
      'Total',
    ];

    const found = labels
      .map((label) => ({ label, idx: source.indexOf(label) }))
      .filter((f) => f.idx !== -1)
      .sort((a, b) => a.idx - b.idx);
    const values: Record<string, string> = {};
    for (let i = 0; i < found.length; i++) {
      const { label, idx } = found[i]!;
      const valueStart = idx + label.length;
      let valueEnd = source.length;
      for (let j = i + 1; j < found.length; j++) {
        if (found[j]!.idx >= valueStart) {
          valueEnd = found[j]!.idx;
          break;
        }
      }
      values[label] = source.slice(valueStart, valueEnd).trim();
    }

    let amount: number | undefined;
    const amountRaw = values['Transaction Amount'];
    if (amountRaw) {
      const etb = amountRaw.indexOf('ETB');
      amount = etb === -1 ? parseMoney(amountRaw) : parseMoney(amountRaw.slice(etb + 3));
    }

    return {
      verified: !!(
        values['Sender Name:'] &&
        values['Receiver Name:'] &&
        amount &&
        values['Transaction Reference:']
      ),
      senderName: values['Sender Name:'],
      senderAccount: values['Sender Account Number:'],
      receiverName: values['Receiver Name:'],
      receiverAccount: values['Receiver Account Number:'],
      amount,
      currency: 'ETB',
      date: (() => {
        const raw = values['Transaction Date:'];
        if (!raw) return undefined;
        const m = raw.match(/[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4},?\s+\d{1,2}:\d{2}:\d{2}\s*(?:am|pm)/i);
        return m ? m[0] : raw;
      })(),
      reference: values['Transaction Reference:'],
      reason: values['Narrative:'],
    };
  }
}
