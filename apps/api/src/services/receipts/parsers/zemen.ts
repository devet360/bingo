/**
 * Zemen Bank.
 *
 * Endpoint: https://share.zemenbank.com/rt/{ref}/pdf
 * Only the transaction reference is needed. The receipt is a PDF whose text
 * carries "Label: value" pairs; each value runs to the next known label.
 */
import { BankParser } from './base';
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';
import { extractPdfText, isPdf, parseMoney } from '../text';

export class ZemenParser extends BankParser {
  readonly key = 'zemen';
  readonly pdfResponse = true;

  buildUrl(input: NormalizedInput): string {
    return `https://share.zemenbank.com/rt/${encodeURIComponent(input.reference)}/pdf`;
  }

  protected async parseBody(body: Buffer): Promise<ParsedReceipt> {
    if (!isPdf(body)) return { verified: false };
    return ZemenParser.parseText(await extractPdfText(body));
  }

  static parseText(text: string): ParsedReceipt {
    if (!text || (!text.includes('Zemen') && !text.includes('ETTB'))) {
      return { verified: false };
    }

    const labels = [
      'Transaction Reference:',
      'Transaction Date:',
      'Transaction Amount:',
      'Service Charge',
      'VAT',
      'Total Amount',
      'Sender Name:',
      'Sender Account:',
      'Receiver Name:',
      'Receiver Account:',
      'Receiver Bank:',
      'Narrative:',
      'Payment Reason:',
      'Status:',
      'Currency:',
    ];

    const values: Record<string, string> = {};
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i]!;
      const startIdx = text.indexOf(label);
      if (startIdx === -1) continue;
      const valueStart = startIdx + label.length;
      let valueEnd = text.length;
      for (let j = i + 1; j < labels.length; j++) {
        const nextIdx = text.indexOf(labels[j]!, valueStart);
        if (nextIdx !== -1) {
          valueEnd = nextIdx;
          break;
        }
      }
      values[label] = text.slice(valueStart, valueEnd).trim();
    }

    const amountRaw = values['Transaction Amount:'] || values['Total Amount'];
    const amount = amountRaw ? parseMoney(amountRaw) : undefined;

    return {
      verified: !!(
        (values['Sender Name:'] || values['Receiver Name:']) &&
        amount &&
        (values['Transaction Reference:'] || text.includes('ETTB'))
      ),
      senderName: values['Sender Name:'],
      senderAccount: values['Sender Account:'],
      receiverName: values['Receiver Name:'],
      receiverAccount: values['Receiver Account:'],
      amount,
      currency: values['Currency:'] || 'ETB',
      date: values['Transaction Date:'],
      reference: values['Transaction Reference:'],
      reason: values['Narrative:'] || values['Payment Reason:'],
      transactionStatus: values['Status:'],
    };
  }
}
