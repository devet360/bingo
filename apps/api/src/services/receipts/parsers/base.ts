/**
 * Base class for the bank receipt parsers.
 *
 * A parser only knows how to build its own endpoint URL and how to read the
 * bank's answer. Fetching, redirect checks, deadlines, byte caps, retries and
 * the verification gate all live outside, in http.ts and verify.ts, so every
 * bank gets the same protections.
 */
import type { NormalizedInput } from '../reference';
import type { ParsedReceipt } from '../types';
import { MAX_PDF_BYTES, MAX_TEXT_BYTES, type SafeResponse } from '../http';

/** The bank explicitly says it has no receipt for this reference. */
export class NotFoundError extends Error {
  constructor(message?: string) {
    super(message ?? '');
    this.name = 'NotFoundError';
  }
}

/** The bank answered, but the body is not a receipt we can read. */
export class UnreadableError extends Error {
  constructor(message?: string) {
    super(message ?? '');
    this.name = 'UnreadableError';
  }
}

export abstract class BankParser {
  abstract readonly key: string;

  /** The bank only answers Ethiopian IPs: one short attempt, no retries. */
  readonly geoBlocked: boolean = false;
  /** Read the body as bytes even when the normal answer is text (PDF or HTML). */
  readonly binaryResponse: boolean = false;
  /** The normal answer is a PDF. */
  readonly pdfResponse: boolean = false;

  /** HTTP statuses that mean "no receipt for that reference". */
  readonly notFoundStatuses: readonly number[] = [404];
  readonly notFoundMessage: string = 'The bank has no receipt for this reference.';

  /** Bank-specific headers (CBE app id, M-Pesa Accept/Referer, ZamZam auth). */
  requestHeaders(): Record<string, string> {
    return {};
  }

  get timeoutMs(): number {
    return this.geoBlocked ? 8_000 : 15_000;
  }

  get maxBytes(): number {
    return this.binaryResponse || this.pdfResponse ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
  }

  abstract buildUrl(input: NormalizedInput): string;

  /**
   * Some banks say "no such receipt" with a status that is not 404 or in
   * `notFoundStatuses` (CBE: 500 "Invalid or tampered legacy token").
   */
  isNotFoundResponse(_resp: SafeResponse): boolean {
    return false;
  }

  /** Read the bank's body. Throw NotFoundError for an explicit "no record". */
  parse(resp: SafeResponse, input: NormalizedInput): ParsedReceipt | Promise<ParsedReceipt> {
    return this.parseBody(resp.body, resp.contentType, input);
  }

  protected abstract parseBody(
    body: Buffer,
    contentType: string,
    input: NormalizedInput,
  ): ParsedReceipt | Promise<ParsedReceipt>;
}
