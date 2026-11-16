import test from 'node:test';
import assert from 'node:assert/strict';
import { PaymentMethod } from '@prisma/client';
import { deriveReceiptAccount, normalizeInput, normalizeOptionalReceipt, referenceFromUrl } from '../src/services/receipts/reference';
import { verificationGate, gateFailureMessage } from '../src/services/receipts/gate';
import { classifyStatus } from '../src/services/receipts/status';
import { parseMoney, birrAmountIn, htmlToLines } from '../src/services/receipts/text';
import { ReferenceError, type ParsedReceipt, type ReceiptProvider } from '../src/services/receipts/types';

function provider(code: string, patch: Partial<ReceiptProvider> = {}): ReceiptProvider {
  return {
    code,
    name: code,
    method: PaymentMethod.BANK_TRANSFER,
    parser: code,
    endpoint: null,
    refPattern: null,
    refHint: null,
    accountDigits: null,
    requiresPhone: false,
    opaqueReference: false,
    clientSide: false,
    supported: true,
    enabled: true,
    ...patch,
  };
}

function receipt(patch: Partial<ParsedReceipt> = {}): ParsedReceipt {
  return {
    verified: true,
    amount: 250,
    reference: 'FT25ABCDEFGH',
    senderName: 'ABEBE KEBEDE',
    receiverName: 'BINGO PLC',
    transactionStatus: 'Completed',
    ...patch,
  };
}

test('references are canonicalised before lookup', () => {
  assert.equal(normalizeInput(provider('telebirr'), { reference: 'det0 123 456' }).reference, 'DET0123456');
  assert.equal(
    normalizeInput(provider('telebirr'), { reference: 'https://transactioninfo.ethiotelecom.et/receipt/det0123456' }).reference,
    'DET0123456',
  );
  assert.equal(
    normalizeInput(provider('cbe'), { reference: 'ft25 abcdef gh' }).reference,
    'FT25ABCDEFGH',
  );
  assert.equal(
    normalizeInput(provider('ebirr'), { reference: 'https://receipt.ebirr.com/nib/abc12345' }).reference,
    'nib/abc12345',
  );
});

test('reference validation rejects traversal and bad shapes', () => {
  assert.throws(() => normalizeInput(provider('cbe'), { reference: '../../etc/passwd' }), ReferenceError);
  const telebirr = provider('telebirr', { refPattern: '^[A-Z0-9]{10}$', refHint: '10 letters or digits' });
  assert.throws(() => normalizeInput(telebirr, { reference: 'short' }), /10 letters or digits/);
  assert.throws(() => normalizeInput(provider('bunna'), { reference: 'not-base64!' }), ReferenceError);
  assert.throws(() => normalizeInput(provider('zamzam'), { reference: '12ab' }), ReferenceError);
});

test('referencePattern from the catalogue is enforced', () => {
  const dashen = provider('dashen', { refPattern: '^[A-Z0-9]{16}$', refHint: '16-character FT reference' });
  assert.equal(normalizeInput(dashen, { reference: 'abcdefgh12345678' }).reference, 'ABCDEFGH12345678');
  assert.throws(() => normalizeInput(dashen, { reference: 'FT123' }), /16-character/);
});

test('account suffix and phone inputs are normalised', () => {
  const boa = provider('boa', { accountDigits: 5 });
  assert.equal(normalizeInput(boa, { reference: 'FT25ABCDE', accountNumber: '100012345678' }).accountNumber, '45678');
  assert.throws(() => normalizeInput(boa, { reference: 'FT25ABCDE', accountNumber: '12' }), ReferenceError);

  const cbebirr = provider('cbebirr', { requiresPhone: true });
  assert.equal(
    normalizeInput(cbebirr, { reference: 'ABC1234567', phoneNumber: '0912345678' }).phoneNumber,
    '251912345678',
  );
});

test('the account suffix is taken from the assigned payment account', () => {
  assert.equal(deriveReceiptAccount(undefined, '100012345678', 5), '45678');
  assert.equal(deriveReceiptAccount(undefined, '1000 1234 5678', 5), '45678');
  assert.equal(deriveReceiptAccount('99999', '100012345678', 5), '99999');
  assert.equal(deriveReceiptAccount(undefined, '123', 5), undefined);
  assert.equal(deriveReceiptAccount(undefined, null, 5), undefined);
  assert.equal(deriveReceiptAccount(undefined, '100012345678', null), undefined);

  // Creation runs before an account exists, so the suffix is deferred instead
  // of demanded from the player.
  const boa = provider('boa', { accountDigits: 5 });
  assert.equal(normalizeOptionalReceipt(boa, { reference: 'FT25ABCDE' }).accountNumber, undefined);
  assert.throws(() => normalizeInput(boa, { reference: 'FT25ABCDE' }), /last 5 digits/);
});

test('a deposit may be created before the player has paid', () => {
  // Step 1 only picks the rail and amount; the reference arrives with "I have paid".
  assert.deepEqual(normalizeOptionalReceipt(provider('cbe'), {}), {
    reference: '',
    accountNumber: undefined,
    phoneNumber: undefined,
  });
  assert.equal(
    normalizeOptionalReceipt(provider('cbe'), { reference: 'ft25 abcdef gh' }).reference,
    'FT25ABCDEFGH',
  );
  assert.throws(() => normalizeOptionalReceipt(provider('cbe'), { reference: '../../etc/passwd' }), ReferenceError);
  // Manual-only rails never parse a reference.
  assert.deepEqual(normalizeOptionalReceipt(provider('boa', { supported: false }), { reference: ' x ' }), {
    reference: 'x',
    accountNumber: undefined,
    phoneNumber: undefined,
  });
});

test('url reference extraction covers link pastes', () => {
  assert.equal(referenceFromUrl('telebirr', 'https://transactioninfo.ethiotelecom.et/receipt/ABC1234567'), 'ABC1234567');
  assert.equal(referenceFromUrl('awash', 'https://awashpay.awashbank.com:8225/-abcDEF123'), 'abcDEF123');
  assert.equal(referenceFromUrl('bunna', 'https://online.bunnabanksc.com/receipt/#/receipt/QUJDREVG'), 'QUJDREVG');
});

test('gate passes a complete, matching receipt', () => {
  const result = verificationGate(receipt(), { provider: provider('cbe'), requestedReference: 'FT25abcdefgh' });
  assert.deepEqual(result, { ok: true });
});

test('gate fails closed on amount, reference, parties and status', () => {
  const cbe = { provider: provider('cbe'), requestedReference: 'FT25ABCDEFGH' };
  assert.equal(verificationGate(receipt({ amount: 0 }), cbe).ok, false);
  assert.equal(verificationGate(receipt({ reference: 'FT25ZZZZZZZZ' }), cbe).ok, false);
  assert.equal(
    verificationGate(receipt({ senderName: undefined, receiverName: undefined }), cbe).ok,
    false,
  );
  const failed = verificationGate(receipt({ transactionStatus: 'Reversed' }), cbe);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(gateFailureMessage(failed), /Reversed/);
});

test('opaque share tokens skip the reference equality check only', () => {
  const awash = provider('awash', { opaqueReference: true });
  assert.equal(verificationGate(receipt({ reference: 'different-token' }), {
    provider: awash,
    requestedReference: 'share-token',
  }).ok, true);
  assert.equal(verificationGate(receipt({ amount: undefined }), {
    provider: awash,
    requestedReference: 'share-token',
  }).ok, false);
});

test('status classification only accepts clear completions', () => {
  assert.equal(classifyStatus('Completed'), 'success');
  assert.equal(classifyStatus('SUCCESSFUL'), 'success');
  assert.equal(classifyStatus('Pending'), 'failure');
  assert.equal(classifyStatus('failed'), 'failure');
  assert.equal(classifyStatus(undefined), 'unknown');
  assert.equal(classifyStatus('Transferred'), 'unknown');
});

test('money parsing handles separators and Amharic labels', () => {
  assert.equal(parseMoney('1,250.50'), 1250.5);
  assert.equal(parseMoney('ETB 300'), 300);
  assert.equal(parseMoney(undefined), undefined);
  assert.equal(birrAmountIn('Total Amount 1,000.00 ETB'), 1000);
  assert.equal(birrAmountIn('No money here'), undefined);
});

test('html conversion drops scripts and keeps line breaks', () => {
  const lines = htmlToLines('<div>Amount</div><script>alert(1)</script><div>250.00</div>');
  assert.deepEqual(lines, ['Amount', '250.00']);
});
