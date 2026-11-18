/**
 * Standalone receipt lookup for staff and agents.
 *
 * Read-only by design. A ReceiptVerification row is unique per
 * (providerCode, reference) and per deposit, so a lookup that stored its
 * result would consume the reference's one-deposit slot and block the real
 * deposit. This module reads the provider catalogue, runs the same parser and
 * gate as verification, and reports whether the reference is already in use;
 * it never creates or updates a row.
 */
import type { DepositProvider } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { toReceiptProvider } from './deposits';
import { createParser } from './parsers';
import type { BankParser } from './parsers/base';
import { normalizeInput, type NormalizedInput } from './reference';
import {
  ReferenceError,
  type ParsedReceipt,
  type ReceiptProvider,
  type ReceiptSource,
  type VerifyInput,
  type VerifyOutcome,
} from './types';
import { verifyClientPayload, verifyReceipt } from './verify';

export interface ReceiptCheckInput {
  providerCode: string;
  reference: string;
  accountNumber?: string;
  phoneNumber?: string;
  /** The bank's own response (HTML page, JSON envelope or PDF), base64. */
  payload?: { contentType?: string; bodyBase64: string };
}

export interface ReceiptCheckUsage {
  depositId: string | null;
  depositCode: string | null;
  depositStatus: string | null;
  verificationStatus: string;
}

export interface ReceiptCheckResult {
  provider: { code: string; name: string; method: string };
  reference: string;
  status: VerifyOutcome['status'];
  message: string;
  /** The bank receipt page, when one can be built. */
  url?: string;
  source: ReceiptSource;
  parsed?: ParsedReceipt;
  /** Non-null when this reference already verified or funded a deposit. */
  usedBy: ReceiptCheckUsage | null;
  checkedAt: string;
}

type VerifyFn = (
  provider: ReceiptProvider,
  input: VerifyInput,
  source?: ReceiptSource,
) => Promise<VerifyOutcome>;

type VerifyPayloadFn = (
  provider: ReceiptProvider,
  input: VerifyInput,
  payload: { contentType?: string; bodyBase64: string },
  source?: ReceiptSource,
) => Promise<VerifyOutcome>;

export interface ReceiptCheckDeps {
  loadProvider(code: string): Promise<DepositProvider | null>;
  verify: VerifyFn;
  verifyPayload: VerifyPayloadFn;
  findUsage(providerCode: string, reference: string): Promise<ReceiptCheckUsage | null>;
}

const defaultDeps: ReceiptCheckDeps = {
  loadProvider: (code) => prisma.depositProvider.findUnique({ where: { code } }),
  verify: verifyReceipt,
  verifyPayload: verifyClientPayload,
  findUsage: async (providerCode, reference) => {
    const row = await prisma.receiptVerification.findUnique({
      where: { providerCode_reference: { providerCode, reference } },
      include: { deposit: { select: { id: true, code: true, status: true } } },
    });
    if (!row) return null;
    return {
      depositId: row.depositId,
      depositCode: row.deposit?.code ?? null,
      depositStatus: row.deposit?.status ?? null,
      verificationStatus: row.status,
    };
  },
};

function safeBuildUrl(
  parser: BankParser | undefined,
  input: NormalizedInput,
): string | undefined {
  if (!parser) return undefined;
  try {
    return parser.buildUrl(input);
  } catch {
    return undefined;
  }
}

/**
 * Look a receipt up by reference. No deposit is needed and nothing is stored:
 * staff and agents use it to read what the bank says before processing a
 * payment.
 */
export async function checkReceipt(
  params: ReceiptCheckInput,
  overrides: Partial<ReceiptCheckDeps> = {},
): Promise<ReceiptCheckResult> {
  const deps: ReceiptCheckDeps = { ...defaultDeps, ...overrides };
  const providerCode = params.providerCode.trim();
  const row = await deps.loadProvider(providerCode);
  if (!row) throw Errors.notFound('Deposit provider');

  const provider = toReceiptProvider(row);
  const base = {
    provider: { code: row.code, name: row.name, method: row.method },
    checkedAt: new Date().toISOString(),
  };

  // A rail confirmed by hand has no bank page to look up.
  if (!provider.supported) {
    return {
      ...base,
      reference: params.reference.trim(),
      status: 'UNSUPPORTED',
      message: 'This method is confirmed by the agent; there is no bank receipt to check.',
      source: 'SERVER',
      usedBy: null,
    };
  }

  let input: NormalizedInput;
  try {
    input = normalizeInput(
      provider,
      {
        reference: params.reference,
        accountNumber: params.accountNumber,
        phoneNumber: params.phoneNumber,
      },
      // The checker looks a receipt up; it is not paying anyone, so the
      // receiving-account suffix is optional.
      { requireAccount: false },
    );
  } catch (error) {
    if (error instanceof ReferenceError) {
      throw Errors.badRequest(error.message, 'INVALID_RECEIPT_REFERENCE');
    }
    throw error;
  }

  const parser = createParser(provider);
  const url = safeBuildUrl(parser, input);
  const usedBy = await deps.findUsage(row.code, input.reference);

  let outcome: VerifyOutcome;
  if (params.payload) {
    // The person's device opened the bank page (M-Pesa and Telebirr answer
    // only Ethiopian IPs); parse the bytes it returned.
    outcome = await deps.verifyPayload(provider, input, params.payload, 'CLIENT');
  } else if (provider.geoBlocked) {
    outcome = {
      status: 'UNREACHABLE',
      message: `${provider.name} only answers Ethiopian IPs. Open the receipt link, or attach the saved page or PDF to read it here.`,
      source: 'SERVER',
      url,
      reference: input.reference,
    };
  } else {
    outcome = await deps.verify(provider, input, 'SERVER');
  }

  return {
    ...base,
    reference: outcome.reference ?? input.reference,
    status: outcome.status,
    message: outcome.message,
    url: outcome.url ?? url,
    source: outcome.source,
    parsed: outcome.parsed,
    usedBy,
  };
}
