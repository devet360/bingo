/**
 * M-Pesa Ethiopia (Safaricom).
 *
 * Endpoint: https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo={ref}
 * Geo-blocked from non-Ethiopian IPs.
 *
 * The endpoint answers a JSON envelope {responseCode, responseDescription,
 * base64Data}; base64Data is the receipt PDF. A non-"0" responseCode or a
 * missing PDF is an upstream "no receipt". The parser reads the PDF text by
 * splitting each line at known labels, so it works on row-ordered and flowed
 * text alike.
 */
import { BankParser, NotFoundError } from './base';
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';
import { extractPdfText, isPdf, parseMoney } from '../text';
import { MAX_PDF_BYTES, MAX_ENVELOPE_BYTES } from '../http';

const MAX_BASE64_CHARS = Math.ceil(MAX_PDF_BYTES / 3) * 4;
const MAX_TEXT_CHARS = 50_000;
const MAX_LINE_CHARS = 2_000;
const MAX_VALUE_CHARS = 200;
const MAX_LABEL_HITS = 500;

type Field =
  | 'payerName'
  | 'payerAccount'
  | 'receiverName'
  | 'receiverBusinessName'
  | 'receiverAccount'
  | 'transactionId'
  | 'serviceFee'
  | 'vat'
  | 'discount'
  | 'total'
  | 'amountInWords'
  | 'paymentMethod'
  | 'transactionType'
  | 'paymentChannel'
  | 'reason'
  | 'status'
  | 'receiptHeader'
  | 'stop';

const FIELD_LABELS: ReadonlyArray<readonly [string, Field]> = [
  ['PAYER NAME', 'payerName'],
  ['SENDER NAME', 'payerName'],
  ['BUYER NAME', 'payerName'],
  ['PAYER PHONE NUMBER', 'payerAccount'],
  ['SENDER NUMBER', 'payerAccount'],
  ['BUYER PHONE NUMBER', 'payerAccount'],
  ['RECEIVER NAME', 'receiverName'],
  ['RECEIVER BUSINESS NAME', 'receiverBusinessName'],
  ['RECEIVER NUMBER', 'receiverAccount'],
  ['RECEIVER ACCOUNT NUMBER', 'receiverAccount'],
  ['RECEIVER BUSINESS NUMBER', 'receiverAccount'],
  ['TRANSACTION ID', 'transactionId'],
  ['SERVICE FEE', 'serviceFee'],
  ['+ 15% VAT', 'vat'],
  ['DISCOUNT', 'discount'],
  ['TOTAL', 'total'],
  ['TOTAL AMOUNT IN WORDS', 'amountInWords'],
  ['PAYMENT METHOD', 'paymentMethod'],
  ['TRANSACTION TYPE', 'transactionType'],
  ['PAYMENT CHANNEL', 'paymentChannel'],
  ['PAYMENT REASON', 'reason'],
  ['TRANSACTION STATUS', 'status'],
  ['SETTLED AMOUNT', 'receiptHeader'],
  ['RECEIPT NO', 'stop'],
  ['PAYMENT DATE', 'stop'],
  ['BANK NAME', 'stop'],
  ['PACKAGE DETAILS', 'stop'],
  ['VALIDITY PERIOD', 'stop'],
  ['TRANSACTION INFORMATION', 'stop'],
  ['TRANSACTION DETAIL', 'stop'],
  ['SCAN TO VERIFY', 'stop'],
  ['THANK YOU', 'stop'],
];

const LABELS_BY_LENGTH = [...FIELD_LABELS].sort((a, b) => b[0].length - a[0].length);
const ETHIOPIC_RE = /[\u1200-\u139F\u2D80-\u2DDF\uAB00-\uAB2F]+/g;
const DATE_TIME_RE = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)/;
const ID_RE = /^[A-Z0-9]{6,20}$/;

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Z0-9]/.test(c);
}

function trimSeparators(s: string): string {
  const sep = (c: string) => c === ' ' || c === '/' || c === ':' || c === '|' || c === '-' || c === '\t';
  let a = 0;
  let b = s.length;
  while (a < b && sep(s[a]!)) a++;
  while (b > a && sep(s[b - 1]!)) b--;
  return s.slice(a, b);
}

function normalizeLine(line: string): string {
  return line.slice(0, MAX_LINE_CHARS).replace(ETHIOPIC_RE, ' ').replace(/\s+/g, ' ').trim();
}

function blank(v: string | undefined): boolean {
  if (!v) return true;
  const t = v.trim();
  return t === '' || t === '-' || t === '- - -' || t === '---' || t.toLowerCase() === 'null' || t.toLowerCase() === 'n/a';
}

function splitAtLabels(line: string): Array<[Field, string]> {
  const upper = line.toUpperCase();
  const hits: Array<{ at: number; end: number; field: Field }> = [];
  for (const [label, field] of LABELS_BY_LENGTH) {
    let from = 0;
    while (hits.length < MAX_LABEL_HITS) {
      const at = upper.indexOf(label, from);
      if (at === -1) break;
      const end = at + label.length;
      from = at + 1;
      if (isWordChar(upper[at - 1]) && isWordChar(label[0])) continue;
      if (isWordChar(upper[end])) continue;
      hits.push({ at, end, field });
    }
  }
  hits.sort((a, b) => a.at - b.at || b.end - a.end);
  const chosen: typeof hits = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.at < lastEnd) continue;
    chosen.push(h);
    lastEnd = h.end;
  }
  return chosen.map((h, i) => {
    const next = chosen[i + 1]?.at ?? line.length;
    return [h.field, trimSeparators(line.slice(h.end, next)).slice(0, MAX_VALUE_CHARS)];
  });
}

function cleanName(v: string | undefined): string | undefined {
  if (blank(v)) return undefined;
  const cut = v!.search(/\d/);
  const name = trimSeparators(
    (cut === -1 ? v! : v!.slice(0, cut)).replace(/[^A-Za-z .'-]/g, ' ').replace(/ {2,}/g, ' '),
  );
  return /[A-Za-z]/.test(name) ? name.slice(0, 100) : undefined;
}

function cleanAccount(v: string | undefined): string | undefined {
  if (blank(v)) return undefined;
  const m = v!.slice(0, 40).match(/^\+?[0-9*][0-9* ]{2,24}/);
  return m ? m[0].replace(/ /g, '') : undefined;
}

function cleanId(v: string | undefined): string | undefined {
  if (blank(v)) return undefined;
  const token = v!.trim().split(' ')[0]!.toUpperCase();
  return ID_RE.test(token) ? token : undefined;
}

function cleanText(v: string | undefined, max = 120): string | undefined {
  return blank(v) ? undefined : v!.trim().slice(0, max);
}

function money(v: string | undefined): number | undefined {
  if (blank(v)) return undefined;
  const n = parseMoney(v);
  return n !== undefined && n >= 0 ? n : undefined;
}

function parseReceiptRow(row: string): { receiptNo?: string; date?: string; settled?: number } {
  const s = row.slice(0, 200);
  const m = s.match(DATE_TIME_RE);
  if (!m || m.index === undefined) return {};
  const before = s.slice(0, m.index).replace(/ /g, '').toUpperCase();
  const after = s.slice(m.index + m[0].length);
  return {
    receiptNo: ID_RE.test(before) ? before : undefined,
    date: `${m[1]} ${m[2]}`,
    settled: money(after),
  };
}

export class MpesaParser extends BankParser {
  readonly key = 'mpesa';
  readonly geoBlocked = true;
  /** The envelope carries a base64 PDF, so it may exceed the 2 MB text cap. */
  get maxBytes(): number {
    return MAX_ENVELOPE_BYTES;
  }

  requestHeaders(): Record<string, string> {
    return { Accept: 'application/json, text/plain, */*', Referer: 'https://m-pesabusiness.safaricom.et/' };
  }

  buildUrl(input: NormalizedInput): string {
    return `https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo=${encodeURIComponent(input.reference)}`;
  }

  protected async parseBody(body: Buffer): Promise<ParsedReceipt> {
    const envelope = MpesaParser.decodeEnvelope(body);
    if (!envelope.ok) throw new NotFoundError(`M-Pesa has no receipt for this reference (${envelope.reason}).`);
    return MpesaParser.parseLines((await extractPdfText(envelope.pdf)).split('\n'));
  }

  /** Fail closed on a non-"0" code, bad base64 or a body that is not a PDF. */
  static decodeEnvelope(data: Buffer): { ok: true; pdf: Buffer } | { ok: false; reason: string } {
    if (data.length > MAX_ENVELOPE_BYTES) return { ok: false, reason: 'too-large' };
    let payload: unknown;
    try {
      payload = JSON.parse(data.toString('utf8'));
    } catch {
      return { ok: false, reason: 'not-json' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'not-object' };
    const p = payload as Record<string, unknown>;
    if (String(p.responseCode ?? '') !== '0') return { ok: false, reason: 'upstream-error' };
    if (typeof p.base64Data !== 'string' || p.base64Data.length === 0) return { ok: false, reason: 'missing-pdf' };

    const b64 = p.base64Data.replace(/[\r\n]/g, '');
    if (b64.length > MAX_BASE64_CHARS) return { ok: false, reason: 'too-large' };
    if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, reason: 'bad-base64' };
    const pdf = Buffer.from(b64, 'base64');
    if (pdf.length > MAX_PDF_BYTES) return { ok: false, reason: 'too-large' };
    if (!isPdf(pdf)) return { ok: false, reason: 'not-pdf' };
    return { ok: true, pdf };
  }

  static parseLines(input: string[]): ParsedReceipt {
    const lines: string[] = [];
    let chars = 0;
    for (const raw of input) {
      if (chars > MAX_TEXT_CHARS) break;
      const l = normalizeLine(String(raw));
      if (!l) continue;
      chars += l.length;
      lines.push(l);
    }

    const values: Partial<Record<Field, string>> = {};
    let header: ReturnType<typeof parseReceiptRow> = {};
    lines.forEach((line, i) => {
      for (const [field, value] of splitAtLabels(line)) {
        if (field === 'stop') continue;
        if (field === 'receiptHeader') {
          if (!header.date) header = parseReceiptRow(value || lines[i + 1] || '');
          continue;
        }
        if (values[field] === undefined && !blank(value)) values[field] = value;
      }
    });

    const reference = cleanId(values.transactionId) ?? header.receiptNo;
    const total = money(values.total);
    const amount = header.settled !== undefined && header.settled > 0 ? header.settled : total;
    const senderName = cleanName(values.payerName);
    const receiverName = cleanName(values.receiverName) ?? cleanName(values.receiverBusinessName);
    const senderAccount = cleanAccount(values.payerAccount);
    const receiverAccount = cleanAccount(values.receiverAccount);
    const date =
      header.date ?? lines.join(' ').slice(0, MAX_TEXT_CHARS).match(DATE_TIME_RE)?.slice(1, 3).join(' ');

    return {
      verified: !!(
        reference &&
        amount !== undefined &&
        amount > 0 &&
        (senderName || receiverName || senderAccount || receiverAccount)
      ),
      senderName,
      senderAccount,
      receiverName,
      receiverAccount,
      amount,
      currency: 'ETB',
      date,
      reference,
      invoiceNumber: header.receiptNo,
      serviceFee: money(values.serviceFee),
      totalPaid: total,
      amountInWords: cleanText(values.amountInWords),
      transactionType: cleanText(values.transactionType, 60),
      paymentChannel: cleanText(values.paymentChannel, 60),
      reason: cleanText(values.reason),
      transactionStatus: cleanText(values.status, 40),
    };
  }
}
