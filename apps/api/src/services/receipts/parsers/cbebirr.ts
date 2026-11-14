/**
 * CBE Birr, the Commercial Bank of Ethiopia mobile wallet.
 *
 * Endpoint: https://cbepay1.cbe.com.et/aureceipt?TID={ref}&PH={phone}
 * Requires the transaction reference (TID) and the payer's phone number.
 *
 * A matching pair returns a one-page PDF receipt; a wrong pair or unknown TID
 * returns HTTP 200 with an empty Telerik ReportViewer shell. That shell is
 * reported as "could not confirm", never as fake: a typo in the phone produces
 * the same page.
 *
 * Phone numbers printed in full on the receipt are masked before anything
 * leaves the parser.
 */
import { BankParser } from './base';
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';
import { decodeEntities, extractPdfText, isPdf, parseMoney, removeScriptsAndStyles, TAG_RE } from '../text';

const MAX_TEXT = 50_000;

export const CBEBIRR_LABELS = [
  'Debit Account',
  'Credit Account',
  'Receiver Name',
  'Order ID',
  'Transaction Status',
  'Reference',
  'Receipt Number',
  'Transaction Date',
  'Paid amount',
  'Service charge',
  'VAT',
  'Total Paid Amount',
  'Total Amount in word',
  'Payment Reason',
  'Payment Channel',
] as const;

const MONEY_VALUE_RE = /^(?:ETB\s?)?\d[\d,]{0,20}(?:\.\d{1,2})?(?:\s?(?:ETB|Birr))?$/i;
const MONEY_LABELS = new Set(['paid amount', 'service charge', 'vat', 'total paid amount']);
const ID_LABELS = new Set(['order id', 'receipt number']);
const WRAPPING_LABELS = new Set(['debit account', 'credit account', 'receiver name']);
const LABELS_BY_LENGTH = [...CBEBIRR_LABELS].map((l) => l.toLowerCase()).sort((a, b) => b.length - a.length);

/** Mask a phone or account number printed in full (0911223344 -> 09****3344). */
export function maskCbeBirrNumber(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.replace(/\s+/g, '');
  if (!s) return undefined;
  if (s.includes('*')) return s;
  if (!/^\+?\d+$/.test(s)) return s;
  const d = s.replace(/^\+/, '');
  if (/^0[79]\d{8}$/.test(d)) return `${d.slice(0, 2)}****${d.slice(-4)}`;
  if (/^251[79]\d{8}$/.test(d)) return `${d.slice(0, 4)}****${d.slice(-4)}`;
  if (d.length <= 5) return '*'.repeat(d.length);
  return `${d[0]}${'*'.repeat(d.length - 5)}${d.slice(-4)}`;
}

/** "0911223344 - TIGIST ALEMU" -> number and name. */
function splitParty(v: string | undefined): { number?: string; name?: string } {
  if (!v) return {};
  const m = v.match(/^\s*(\+?[\d*Xx]{6,20})\s*-\s*(.*)$/);
  if (m) return { number: m[1], name: clean(m[2]) };
  if (/^[\s\d*+Xx]+$/.test(v)) return { number: clean(v) };
  return { name: clean(v) };
}

function clean(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const isTrim = (c: string) => c === ':' || /\s/.test(c);
  let a = 0;
  let b = v.length;
  while (a < b && isTrim(v[a]!)) a++;
  while (b > a && isTrim(v[b - 1]!)) b--;
  const out = v.slice(a, b).replace(/\s+/g, ' ');
  return out || undefined;
}

/** Text between the first `start` label and the nearest following `end` label. */
function between(text: string, lower: string, start: string, ends: string[], maxLen = 200): string | undefined {
  const i = lower.indexOf(start.toLowerCase());
  if (i === -1) return undefined;
  const from = i + start.length;
  let to = -1;
  for (const e of ends) {
    const j = lower.indexOf(e.toLowerCase(), from);
    if (j !== -1 && (to === -1 || j < to)) to = j;
  }
  if (to === -1 || to - from > maxLen) return undefined;
  return text.slice(from, to);
}

function htmlToText(html: string): string {
  return decodeEntities(
    removeScriptsAndStyles(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/t[dh]>\s*<t[dh][^<>]*>/gi, '\t')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/(div|p|li|h\d)>/gi, '\n')
      .replace(TAG_RE, ' '),
  )
    .replace(/[ ]+/g, ' ')
    .replace(/\n[ \t]*\n+/g, '\n')
    .trim();
}

export class CbeBirrParser extends BankParser {
  readonly key = 'cbebirr';
  readonly binaryResponse = true;

  buildUrl(input: NormalizedInput): string {
    return `https://cbepay1.cbe.com.et/aureceipt?TID=${encodeURIComponent(input.reference)}&PH=${encodeURIComponent(
      input.phoneNumber ?? '',
    )}`;
  }

  protected async parseBody(body: Buffer): Promise<ParsedReceipt> {
    if (isPdf(body)) return CbeBirrParser.parseText(await extractPdfText(body));
    return CbeBirrParser.parseText(htmlToText(body.toString('utf8')));
  }

  /**
   * Label/value rows, keyed by lowercased label. A value that does not fit
   * its label (a word where a number belongs, the table header where a receipt
   * number belongs) is skipped so a later row can fill it. A wrapped name row
   * is joined to the row before it.
   */
  static lineFields(text: string): Record<string, string> {
    const fields: Record<string, string> = {};
    const known = CBEBIRR_LABELS.map((l) => l.toLowerCase());
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      if (raw.length > 300) continue;
      const line = raw.trim();
      let key: string | undefined;
      let value: string | undefined;
      const m = line.match(/^([^:\t]+?)\s*(?::|\t)\s*(.+)$/);
      if (m && known.includes(m[1]!.trim().toLowerCase())) {
        key = m[1]!.trim().toLowerCase();
        value = m[2]!.trim();
      } else {
        const lower = line.toLowerCase();
        const label = LABELS_BY_LENGTH.find((l) => lower.startsWith(l) && /[\s:]/.test(line.charAt(l.length)));
        if (label) {
          key = label;
          value = clean(line.slice(label.length));
        }
      }
      if (!key || !value || fields[key]) continue;
      if (MONEY_LABELS.has(key) && !MONEY_VALUE_RE.test(value)) continue;
      if (ID_LABELS.has(key) && !/^[A-Za-z0-9]{4,32}$/.test(value)) continue;
      if (WRAPPING_LABELS.has(key)) {
        const next = lines[i + 1]?.trim() ?? '';
        const nextLower = next.toLowerCase();
        if (
          next &&
          next.length <= 80 &&
          /^[A-Z][A-Z .'-]*$/.test(next) &&
          !LABELS_BY_LENGTH.some((l) => nextLower.startsWith(l))
        ) {
          value = `${value} ${next}`;
        }
      }
      fields[key] = value;
    }
    return fields;
  }

  static parseText(input: string): ParsedReceipt {
    if (!input) return { verified: false };
    const text = input.length > MAX_TEXT ? input.slice(0, MAX_TEXT) : input;
    const lower = text.toLowerCase();
    const f = CbeBirrParser.lineFields(text);
    const get = (label: string) => clean(f[label.toLowerCase()]);
    const near = (label: string, after: number) => {
      const i = lower.indexOf(label.toLowerCase());
      return i === -1 ? undefined : text.slice(i + label.length, i + label.length + after);
    };

    const subCity = clean(between(text, lower, 'Sub city:', ['Wereda/kebele:']));
    const customerName = clean(near('Customer Name:', 120)?.split('\n')[0]);
    const nameOk = (v: string | undefined) => (v && /^[A-Z][A-Za-z .'-]*$/.test(v) && /[A-Z]{2}/.test(v) ? v : undefined);
    const debit = splitParty(get('Debit Account') ?? clean(between(text, lower, 'Debit Account', ['Credit Account'])));
    const credit = splitParty(get('Credit Account') ?? clean(between(text, lower, 'Credit Account', ['Receiver Name'])));
    const receiver = splitParty(get('Receiver Name') ?? clean(between(text, lower, 'Receiver Name', ['Order ID'])));

    const senderName =
      debit.name ?? nameOk(customerName) ?? (subCity && /^[A-Z][A-Z ]+$/.test(subCity) ? subCity : undefined);
    const debitAccount = maskCbeBirrNumber(debit.number);
    const creditAccount = maskCbeBirrNumber(credit.number);
    const walletCredit = Boolean(credit.number && /^(?:0|\+?251)[79]/.test(credit.number));
    const receiverName = receiver.name ?? (walletCredit ? credit.name : undefined);

    const orderId = get('Order ID') ?? clean(near('Order ID', 80)?.match(/^\s*([A-Z0-9]+)/i)?.[1]);
    const transactionStatus =
      get('Transaction Status') ?? clean(near('Transaction Status', 80)?.match(/^\s*([A-Za-z]+)/)?.[1]);

    let reference = get('Reference');
    if (!reference) {
      const m = text.match(/(?:^|\n)[ \t]*Reference/i);
      if (m && m.index !== undefined) {
        const from = m.index + m[0].length;
        const tail = text.slice(from, from + 200);
        const tailLower = tail.toLowerCase();
        let to = tail.length;
        for (const e of ['transaction details', 'receipt number', 'የኢትዮጵያ', 'commercial bank']) {
          const j = tailLower.indexOf(e);
          if (j !== -1 && j < to) to = j;
        }
        reference = clean(tail.slice(0, to));
      }
    }

    // "CHK0000001" "2026-10-01 14:05" "1500.00" may arrive glued together.
    const row =
      text.match(
        /(?:^|[^A-Za-z0-9])([A-Z0-9]{10,12})[ \t]{0,4}(\d{4}-\d{2}-\d{2}[ \t]{1,4}\d{2}:\d{2}(?::\d{2})?)[ \t]{0,4}(\d[\d,]{0,20}(?:\.\d{1,2})?)/m,
      ) ?? text.match(/([A-Z0-9]{10})(\d{4}-\d{2}-\d{2}[ \t]{1,4}\d{2}:\d{2})([\d.,]{1,20})/);
    const receiptNumber = get('Receipt Number') ?? (row ? row[1] : undefined);
    const date = get('Transaction Date') ?? (row ? row[2] : undefined);
    const rowAmount = row ? parseMoney(row[3]) : undefined;

    // PDF financial block: four values, then the labels.
    const paidAt = lower.indexOf('paid amount');
    const finWindow = paidAt === -1 ? '' : text.slice(Math.max(0, paidAt - 200), paidAt + 'paid amount'.length);
    const fin = finWindow.match(/([\d.,]{1,20})\s+([\d.,]{1,20})\s+([\d.,]{1,20})\s+([\d.,]{1,20})\s+Paid amount$/i);
    const paidAmount = parseMoney(get('Paid amount')) ?? (fin ? parseMoney(fin[1]) : undefined);
    const serviceCharge = parseMoney(get('Service charge')) ?? (fin ? parseMoney(fin[2]) : undefined);
    const vat = parseMoney(get('VAT')) ?? (fin ? parseMoney(fin[3]) : undefined);
    const totalPaid = parseMoney(get('Total Paid Amount')) ?? (fin ? parseMoney(fin[4]) : undefined);

    let paymentReason = get('Payment Reason');
    let paymentChannel = get('Payment Channel');
    let amountInWords = clean(get('Total Amount in word')?.replace(/\s*\.$/, ''));
    if (!paymentReason || !paymentChannel) {
      const block = near('Payment Channel', 600);
      const lines = block
        ?.split('\n')
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean);
      if (block && /^[ \t]*\n/.test(block) && lines && lines.length >= 3) {
        amountInWords = clean(lines[0]);
        paymentReason = paymentReason ?? clean(lines[1]);
        paymentChannel = paymentChannel ?? clean(lines[2]);
      }
    }

    const amount = paidAmount ?? rowAmount ?? totalPaid;
    const hasId = Boolean(receiptNumber || orderId || reference);
    const hasParty = Boolean(receiverName || creditAccount || debitAccount || senderName);
    if (!hasId || amount === undefined || !hasParty) return { verified: false };

    return {
      verified: true,
      senderName,
      senderAccount: debitAccount,
      receiverName,
      receiverAccount: creditAccount,
      amount,
      currency: 'ETB',
      date,
      reference: receiptNumber ?? reference,
      orderId,
      transactionStatus,
      serviceFee: serviceCharge,
      totalPaid,
      reason: paymentReason,
      paymentChannel,
      amountInWords,
    };
  }
}
