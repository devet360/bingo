/**
 * eBirr, the shared receipt platform used by several banks.
 *
 * Endpoint: https://receipt.ebirr.com/{tenant}/{token}
 * Tenants: nib, wegagen, ahadu, kaafimf and siinqee. The user pastes the full
 * receipt link; the token is never fetched as given.
 *
 * The receipt is HTML with label/value cells. Without a valid token the server
 * answers HTTP 200 with a "Not Found Page" (red H1).
 */
import { BankParser, NotFoundError } from './base';
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';
import { htmlToLines, parseMoney } from '../text';

/** Receipts the parser accepts: a party, a positive amount, and an id or date. */
function parseReceipt(html: string): ParsedReceipt {
  const text = htmlToLines(html).join('\n');
  if (text.length < 20) return { verified: false };

  const fields: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const colon = trimmed.match(/^([^:]+):\s*(.+)$/);
    if (colon) {
      const key = colon[1]!.trim().toLowerCase();
      if (!fields[key]) fields[key] = colon[2]!.trim();
      continue;
    }
    const tab = trimmed.match(/^([^\t]+)\t(.+)$/);
    if (tab) {
      const key = tab[1]!.trim().toLowerCase();
      if (!fields[key]) fields[key] = tab[2]!.trim();
    }
  }

  const senderName =
    fields['sender'] || fields['payer'] || fields['from'] || fields['sender name'] || fields['payer name'];
  const receiverName =
    fields['receiver'] || fields['payee'] || fields['to'] || fields['receiver name'] || fields['beneficiary'];
  const amountStr = fields['amount'] || fields['transferred amount'] || fields['transfer amount'];
  const date = fields['date'] || fields['transaction date'] || fields['time'];
  const reference =
    fields['reference'] || fields['transaction id'] || fields['ref'] || fields['transaction reference'];
  const status = fields['status'] || fields['transaction status'];
  const senderAccount = fields['sender account'] || fields['from account'] || fields['payer account'];
  const receiverAccount = fields['receiver account'] || fields['to account'] || fields['payee account'];
  const phone = fields['phone'] || fields['mobile'] || fields['phone number'];
  const amount = parseMoney(amountStr);

  const result: ParsedReceipt = {
    verified: !!((senderName || receiverName) && amount !== undefined && amount > 0 && (reference || date)),
    senderName,
    receiverName,
    senderAccount,
    receiverAccount,
    amount,
    currency: 'ETB',
    date,
    reference,
  };
  if (status) result.transactionStatus = status;
  if (phone) result.senderAccount = phone;
  return result;
}

export class EbirrParser extends BankParser {
  readonly key: string;

  /** Fixed tenant for banks whose link only carries the token. */
  private readonly tenant?: string;

  constructor(key: string, tenant?: string) {
    super();
    this.key = key;
    this.tenant = tenant;
  }

  buildUrl(input: NormalizedInput): string {
    if (this.tenant) {
      return `https://receipt.ebirr.com/${this.tenant}/${encodeURIComponent(input.reference)}`;
    }
    const [tenant, token] = input.reference.split('/');
    return `https://receipt.ebirr.com/${encodeURIComponent(tenant!)}/${encodeURIComponent(token!)}`;
  }

  protected parseBody(body: Buffer): ParsedReceipt {
    const html = body.toString('utf8');
    if (html.includes('Not Found Page') || html.includes('color: red')) {
      throw new NotFoundError(`${this.key.toUpperCase()} has no receipt for this link.`);
    }
    return parseReceipt(html);
  }
}
