/**
 * Telebirr (Ethio Telecom) receipt parser.
 *
 * Endpoint: https://transactioninfo.ethiotelecom.et/receipt/{ref}
 * The endpoint only answers Ethiopian IPs, so the verifier tries once with a
 * short timeout and never retries.
 *
 * The page has three tables: payer info, invoice details and payment
 * metadata. A mobile "Select All" copy concatenates every label and value onto
 * one line, and some layouts render labels and values in two columns; both are
 * normalized into "label then value" lines before reading.
 */
import { BankParser, NotFoundError } from './base';
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';
import { birrAmountIn, htmlToLines } from '../text';

/** Drop a trailing Amharic label ("<amharic text> /") from a value. */
function stripTrailingAmharicLabel(value: string): string {
  if (!/\/\s*$/.test(value)) return value;
  const first = value.search(/[\u1200-\u137F]/);
  if (first === -1) return value;
  const lastSlash = value.lastIndexOf('/');
  return first < lastSlash ? value.slice(0, first) : value;
}

/** Insert a line break before every known label in a one-line copy. */
function normalizeReceiptText(text: string): string {
  const labels = [
    'Service fee VAT',
    'Service fee',
    'Total Paid Amount',
    'Total Amount in words',
    'Settled Amount',
    'Discount Amount',
    'Stamp Duty',
    'Payer telebirr no',
    'Payer account type',
    'Payer TIN No',
    'Payer Name',
    'VAT Reg. Date',
    'VAT Reg. No',
    'Credited party account no',
    'Credited Party name',
    'transaction status',
    'Bank account number',
    'Invoice details',
    'Invoice No.',
    'Payment date',
    'Payment Mode',
    'Payment Reason',
    'Payment channel',
    'Customer Note',
  ];
  // Longest first, so "Service fee VAT" is not split into "Service fee" + " VAT".
  const sorted = labels
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  const regex = new RegExp(`(${sorted.join('|')})`, 'g');
  const labeled = text.replace(regex, (match, _p1: string, offset: number, str: string) => {
    if (offset === 0 || str[offset - 1] === '\n') return match;
    return `\n${match}`;
  });
  return restructureInvoiceSection(labeled);
}

/**
 * Mobile "Select All" keeps every invoice label on its own line and joins the
 * three values in one tab-separated row after them; other layouts interleave a
 * label and its value, or glue the values together. Normalize all three into
 * "label then value" lines so the readers below see one shape.
 */
function restructureInvoiceSection(text: string): string {
  const lines = text.split('\n');
  const invoiceNoIdx = lines.findIndex((l) => /Invoice\s*No\.?/i.test(l));
  const settledIdx = lines.findIndex((l) => l.includes('Settled Amount'));
  const stampIdx = lines.findIndex((l) => l.includes('Stamp Duty'));

  if (invoiceNoIdx === -1 || settledIdx === -1 || stampIdx === -1) return text;
  if (settledIdx >= stampIdx) return text;

  const knownLabels = [
    'Invoice No.',
    'Payment date',
    'Settled Amount',
    'Stamp Duty',
    'Excise Tax',
    'Discount Amount',
    'Service fee',
    'Service fee VAT',
    'Total Paid Amount',
    'Total Amount in words',
  ];
  const dateRe = /^\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2}$/;
  const amountRe = /^\d[\d,]{0,30}(?:\.\d{1,2})?\s*Birr$/i;
  const refRe = /^[A-Z0-9]{6,20}$/;

  // Splitting bilingual labels leaves the Amharic half ("የክፍያ ቁጥር/") on its own
  // line, so values are picked by shape rather than by position.
  const parts: string[] = [];
  let lastValueIdx = invoiceNoIdx;
  for (let i = invoiceNoIdx; i < stampIdx; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (knownLabels.some((label) => line.includes(label))) continue;
    for (const part of line.split('\t').map((v) => v.trim()).filter(Boolean)) {
      if (/[\u1200-\u137F]/.test(part)) continue;
      parts.push(part);
      lastValueIdx = i;
    }
  }
  if (!parts.length) return text;

  const spliceSection = (ref: string, date: string, amount: string): string => {
    const section = ['Invoice No.', ref, 'Payment date', date, 'Settled Amount', amount];
    const newLines = [...lines];
    newLines.splice(
      invoiceNoIdx,
      Math.max(lastValueIdx, settledIdx) + 1 - invoiceNoIdx,
      ...section,
    );
    return newLines.join('\n');
  };

  const date = parts.find((p) => dateRe.test(p));
  const amount = parts.find((p) => amountRe.test(p));
  const ref = parts.find((p) => p !== date && p !== amount && refRe.test(p));
  if (ref && date && amount) return spliceSection(ref, date, amount);

  // Settled Amount{REF}{DD-MM-YYYY HH:MM:SS}{AMOUNT} Birr, glued together.
  const glued = parts.join(' ').match(
    /^([A-Z]{2,3}[A-Z0-9]{6,8})(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})(\d[\d,]{0,30}(?:\.\d{1,2})?)\s*Birr/,
  );
  if (!glued) return text;
  return spliceSection(glued[1]!, glued[2]!, `${glued[3]} Birr`);
}

export class TelebirrParser extends BankParser {
  readonly key = 'telebirr';
  readonly geoBlocked = true;

  buildUrl(input: NormalizedInput): string {
    return `https://transactioninfo.ethiotelecom.et/receipt/${encodeURIComponent(input.reference)}`;
  }

  protected parseBody(body: Buffer): ParsedReceipt {
    const raw = body.toString('utf8');
    if (raw.includes('This request is not correct')) {
      throw new NotFoundError('Telebirr has no receipt for this reference.');
    }
    if (!raw.toLowerCase().includes('telebirr receipt')) {
      return { verified: false };
    }
    return this.parsePlainText(htmlToLines(raw).join('\n'));
  }

  /** The receipt's text lines: the relay flattens the page, or parseBody does. */
  parsePlainText(text: string): ParsedReceipt {
    if (text.includes('This request is not correct')) {
      throw new NotFoundError('Telebirr has no receipt for this reference.');
    }

    const lines = normalizeReceiptText(text)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    function valAfter(en: string, am?: string): string | undefined {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.includes(en) || (am && line.includes(am))) {
          const afterLabel = line.split(en)[1] || (am ? line.split(am)[1] : '');
          if (afterLabel && afterLabel.trim()) {
            const cleaned = stripTrailingAmharicLabel(afterLabel.trim().replace(/^[.\-:]+/, '')).trim();
            if (cleaned) return cleaned;
          }
          if (am) {
            const afterAm = line.split(am)[1];
            if (afterAm && afterAm.trim()) {
              const cleaned = stripTrailingAmharicLabel(afterAm.trim().replace(/^[.\-:]+/, '')).trim();
              if (cleaned) return cleaned;
            }
          }
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            const next = lines[j]!;
            if (/[\u1200-\u137F]/.test(next) && next.includes('/')) continue;
            return next;
          }
        }
      }
      return undefined;
    }

    function birrAmount(label: string, am?: string): number | undefined {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.includes(label) || (am && line.includes(am))) {
          const m = birrAmountIn(line);
          if (m !== undefined) return m;
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            const m2 = birrAmountIn(lines[j]!);
            if (m2 !== undefined) return m2;
          }
        }
      }
      return undefined;
    }

    const senderName = valAfter('Payer Name', '\u12E8\u12A8\u12CD\u12FA\u12ED \u1235\u121B');
    const senderAccount = valAfter(
      'Payer telebirr no',
      '\u12E8\u12A8\u12CD\u12FA\u12ED \u124C\u12EC\u12A5\u1228\u1201 \u1230\u1201',
    );
    const receiverName = valAfter(
      'Credited Party name',
      '\u12E8\u1300\u12AD\u12F0\u12E5 \u1320\u1241\u124B\u12ED \u1235\u121B',
    );
    const receiverAccount = valAfter(
      'Credited party account no',
      '\u12E8\u1300\u12AD\u12F0\u12E5 \u1320\u1241\u124B\u12ED \u124C\u12EC\u12A5\u1228\u1201 \u1230\u1201',
    );
    const transactionStatus = valAfter('transaction status', '\u12E8\u12AD\u12CD\u12EB\u12F0 \u12D5\u12AD\u12D5\u12AD');
    const invoiceNumber = valAfter('Invoice No', '\u12E8\u12AD\u12CD\u12EB \u1230\u1201');
    const settledAmount = birrAmount('Settled Amount', '\u12E8\u1300\u12A8\u12CD\u12F0\u12E5 \u1218\u12D5\u12D5');
    const serviceFee = birrAmount('Service fee', '\u12E8\u12A0\u1300\u12CD\u12CD\u12A5\u12EB \u12AD\u12CD\u12EB');
    const totalPaid = birrAmount('Total Paid Amount', '\u1300\u12AD\u12AD\u12E8\u12E5 \u12E8\u1300\u12A8\u12CD\u12F0\u12E5');
    const amountInWords = valAfter('Total Amount in word', '\u12E8\u1300\u12D3\u12E5 \u12E8\u12AD\u12AD \u12A0\u12CD\u12F0\u12EB');
    const paymentChannel = valAfter('Payment channel', '\u12E8\u12AD\u12CD\u12EB \u1218\u12D5\u12CD');
    const reason = valAfter('Payment Reason', '\u12E8\u12AD\u12CD\u12EB \u121D\u12AD\u12D5\u12EB');

    let date: string | undefined;
    for (const line of lines) {
      const m = line.match(/(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/);
      if (m) {
        date = m[1];
        break;
      }
    }

    // What the payer sent is what the deposit is for; the settled amount is
    // net of the service fee and VAT (106 paid, 104 settled).
    let amount = totalPaid ?? settledAmount;
    if (amount === undefined) {
      for (const line of lines) {
        const m = birrAmountIn(line);
        if (m !== undefined) {
          amount = m;
          break;
        }
      }
    }

    return {
      verified: !!(invoiceNumber || amount !== undefined),
      senderName,
      senderAccount,
      receiverName,
      receiverAccount,
      amount,
      settledAmount,
      currency: 'ETB',
      date,
      reference: invoiceNumber,
      reason,
      invoiceNumber,
      transactionStatus,
      serviceFee,
      totalPaid,
      amountInWords,
      paymentChannel,
    };
  }
}
