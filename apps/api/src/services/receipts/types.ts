import type { PaymentMethod } from '@prisma/client';

export type ReceiptSource = 'SERVER' | 'CLIENT' | 'RELAY';

export type VerifyStatus =
  | 'VERIFIED'
  | 'FAILED'
  | 'NOT_FOUND'
  | 'NOT_MATCHED'
  | 'NOT_VERIFIED'
  | 'UNREACHABLE'
  | 'UNSUPPORTED'
  | 'INVALID_REFERENCE';

/** What a parser says the bank's receipt contains. Not yet gate-checked. */
export interface ParsedReceipt {
  verified: boolean;
  amount?: number;
  currency?: string;
  senderName?: string;
  senderAccount?: string;
  receiverName?: string;
  receiverAccount?: string;
  reference?: string;
  date?: string;
  transactionStatus?: string;
  transactionType?: string;
  reason?: string;
  /** Extra detail kept for the audit record, never used by the gate. */
  invoiceNumber?: string;
  /** What the receiver got, when the bank deducts its fee from the payment. */
  settledAmount?: number;
  orderId?: string;
  branch?: string;
  paymentChannel?: string;
  amountInWords?: string;
  serviceFee?: number;
  totalPaid?: number;
}

/** A DepositProvider row, minus Prisma's timestamps/relations. */
export interface ReceiptProvider {
  code: string;
  name: string;
  method: PaymentMethod;
  parser: string | null;
  endpoint: string | null;
  refPattern: string | null;
  refHint: string | null;
  accountDigits: number | null;
  requiresPhone: boolean;
  opaqueReference: boolean;
  clientSide: boolean;
  /** The bank only answers Ethiopian IPs: the deployed API cannot check it. */
  geoBlocked?: boolean;
  supported: boolean;
  enabled: boolean;
}

export interface VerifyInput {
  reference: string;
  accountNumber?: string;
  phoneNumber?: string;
}

export interface VerifyOutcome {
  status: VerifyStatus;
  message: string;
  parsed?: ParsedReceipt;
  source: ReceiptSource;
  /** The receipt page a person can open; never fetched by the client automatically. */
  url?: string;
  /** The canonical reference that was looked up (after normalization). */
  reference?: string;
}

export class ReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceError';
  }
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly notFound: boolean,
    readonly unreachable: boolean,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}
