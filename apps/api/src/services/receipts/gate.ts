/**
 * Post-parse verification gate, shared by every provider.
 *
 * A parser decides whether the response "looks like" that bank's receipt.
 * That is not enough: an empty JSON object, a page with only the bank name or
 * a reversed transfer all used to pass. The gate runs after every parser and
 * fails closed. `verified: true` is only allowed when all of these hold:
 *
 *   1. A finite amount greater than zero.
 *   2. When the lookup key is the receipt reference, the returned reference
 *      matches the one requested (case and whitespace ignored). Providers
 *      whose public link carries an opaque share token are exempt; the token is
 *      not printed on the receipt, so it can never match.
 *   3. At least one party: a payer or receiver name or account.
 *   4. The transaction status, when the bank gives one, is not a known failure
 *      or non-final state (Failed, Reversed, Pending, Cancelled, ...).
 */
import type { ParsedReceipt, ReceiptProvider } from './types';
import { classifyStatus } from './status';

export type GateFailure = 'amount' | 'reference' | 'party' | 'status';

export type GateResult =
  | { ok: true }
  | { ok: false; reason: GateFailure; detail?: string };

function normalizeReference(ref: string | undefined | null): string {
  return String(ref ?? '').replace(/\s+/g, '').toUpperCase();
}

function present(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

export function verificationGate(
  parsed: ParsedReceipt,
  ctx: { provider: Pick<ReceiptProvider, 'code' | 'opaqueReference'>; requestedReference: string },
): GateResult {
  if (!parsed || parsed.verified !== true) {
    return { ok: false, reason: 'party', detail: 'the bank response is not a receipt' };
  }

  const amount = parsed.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'amount' };
  }

  if (!ctx.provider.opaqueReference) {
    const returned = normalizeReference(parsed.reference);
    const requested = normalizeReference(ctx.requestedReference);
    if (returned && requested && returned !== requested) {
      return { ok: false, reason: 'reference', detail: String(parsed.reference).slice(0, 64) };
    }
  }

  const hasParty =
    present(parsed.senderName) ||
    present(parsed.receiverName) ||
    present(parsed.senderAccount) ||
    present(parsed.receiverAccount);
  if (!hasParty) return { ok: false, reason: 'party' };

  if (classifyStatus(parsed.transactionStatus) === 'failure') {
    return { ok: false, reason: 'status', detail: String(parsed.transactionStatus).slice(0, 40) };
  }

  return { ok: true };
}

/** User-facing message for a gate failure. */
export function gateFailureMessage(result: Extract<GateResult, { ok: false }>): string {
  switch (result.reason) {
    case 'status':
      return `The bank lists this transaction as "${result.detail}". It is not a completed payment.`;
    case 'reference':
      return 'The bank returned a receipt with a different reference than the one entered.';
    case 'amount':
      return "The bank's response has no valid amount, so it cannot be confirmed as a receipt.";
    case 'party':
    default:
      return "The bank's response is missing the payer and receiver, so it cannot be confirmed as a receipt.";
  }
}
