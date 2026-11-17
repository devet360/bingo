import test from 'node:test';
import assert from 'node:assert/strict';
import { PaymentMethod } from '@prisma/client';
import {
  deriveReceiptAccount,
  mergeReceiptSubmission,
  normalizeInput,
  normalizeOptionalReceipt,
  referenceFromUrl,
} from '../src/services/receipts/reference';
import { verificationGate, gateFailureMessage } from '../src/services/receipts/gate';
import { classifyStatus } from '../src/services/receipts/status';
import { parseMoney, birrAmountIn, htmlToLines } from '../src/services/receipts/text';
import { ReferenceError, type ParsedReceipt, type ReceiptProvider } from '../src/services/receipts/types';
import { TelebirrParser } from '../src/services/receipts/parsers/telebirr';
import { MpesaParser } from '../src/services/receipts/parsers/mpesa';
import { NotFoundError } from '../src/services/receipts/parsers/base';

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

test('a screenshot-only submission keeps a blank reference instead of failing', () => {
  // The web sends receiptReference: '' when the player attaches only a
  // screenshot; that must not throw before the proof can be stored.
  assert.deepEqual(mergeReceiptSubmission(provider('telebirr'), {}, { reference: '' }), {
    reference: null,
    accountNumber: null,
    phoneNumber: null,
  });
});

test('submitted receipt fields merge with what the deposit already stores', () => {
  // Blank submitted fields never overwrite stored ones.
  const kept = mergeReceiptSubmission(
    provider('telebirr'),
    { reference: 'det0123456', accountNumber: null, phoneNumber: null },
    { reference: '   ', accountNumber: '', phoneNumber: '' },
  );
  assert.equal(kept.reference, 'DET0123456');

  // A real submitted reference still replaces and canonicalises the stored one.
  const replaced = mergeReceiptSubmission(
    provider('cbe'),
    { reference: 'FT25ABCDEFGH' },
    { reference: 'ft25 zzzzzz zz' },
  );
  assert.equal(replaced.reference, 'FT25ZZZZZZZZ');

  // Manual-only rails trim without parsing.
  assert.deepEqual(mergeReceiptSubmission(provider('boa', { supported: false }), {}, { reference: ' x ' }), {
    reference: 'x',
    accountNumber: null,
    phoneNumber: null,
  });
});

test('a submitted reference is still validated', () => {
  assert.throws(
    () => mergeReceiptSubmission(provider('cbe'), {}, { reference: '../../etc/passwd' }),
    ReferenceError,
  );
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

// The real Telebirr page puts the three invoice labels in one header row and
// the three values in the next row, with the disabled Excise Tax row inside an
// HTML comment. These fixtures mirror that markup with invented data.
const TELEBIRR_HTML = `<!doctype html><html><head><title>telebirr receipt</title></head><body>
<table>
  <tr><td>የከፋይ ስም/Payer Name</td><td>ABEBE KEBEDE</td></tr>
  <tr><td>የከፋይ ተሌፎን ቁጥር/Payer telebirr no</td><td>2519****1111</td></tr>
  <tr><td>የገንዘብ ተቀባይ ስም/Credited Party name</td><td>BINGO PLC</td></tr>
  <tr><td>የገንዘብ ተቀባይ ተሌፎን ቁጥር/Credited party account no</td><td>2519****2222</td></tr>
  <tr><td>የክፍያ ሁኔታ/transaction status</td><td>Completed</td></tr>
</table>
<table>
  <tr><td colspan="3">የክፍያ ዝርዝር/ Invoice details</td></tr>
  <tr>
    <td>የክፍያ ቁጥር/Invoice No.</td>
    <td>የክፍያ ቀን/Payment date</td>
    <td>የተከፈለው መጠን/Settled Amount</td>
  </tr>
  <tr><td>ABC1234567</td><td>01-02-2026 10:11:12</td><td>104 Birr</td></tr>
  <!-- <tr><td>የኤክሳይዝ ታክስ/Excise Tax (5%)</td><td>0.0 Birr</td></tr> -->
  <tr><td></td><td>የማህተም ክፍያ/Stamp Duty</td><td>0.00 Birr</td></tr>
  <tr><td></td><td>የአገልግሎት ክፍያ/Service fee</td><td>1.74 Birr</td></tr>
  <tr><td></td><td>የአገልግሎት ተጨማሪ እሴት ታክስ/Service fee VAT</td><td>0.26 Birr</td></tr>
  <tr><td></td><td>ጠቅላላ የተከፈለው መጠን/Total Paid Amount</td><td>106 Birr</td></tr>
</table>
</body></html>`;

function textResponse(text: string) {
  return { status: 200, contentType: 'text/html', body: Buffer.from(text, 'utf8'), url: '' };
}

test('telebirr reads the three-column invoice row', async () => {
  const parser = new TelebirrParser();
  const parsed = await parser.parse(textResponse(TELEBIRR_HTML), { reference: 'ABC1234567' });

  assert.equal(parsed.verified, true);
  assert.equal(parsed.reference, 'ABC1234567');
  assert.equal(parsed.invoiceNumber, 'ABC1234567');
  assert.equal(parsed.date, '01-02-2026 10:11:12');
  // The deposit is for what the payer sent; the receiver is credited net of fees.
  assert.equal(parsed.amount, 106);
  assert.equal(parsed.totalPaid, 106);
  assert.equal(parsed.settledAmount, 104);
  assert.equal(parsed.serviceFee, 1.74);
  assert.equal(parsed.senderName, 'ABEBE KEBEDE');
  assert.equal(parsed.receiverName, 'BINGO PLC');
  assert.equal(parsed.senderAccount, '2519****1111');
  assert.equal(parsed.transactionStatus, 'Completed');

  const gate = verificationGate(parsed, {
    provider: provider('telebirr', { refPattern: '^[A-Z0-9]{10}$' }),
    requestedReference: 'abc1234567',
  });
  assert.deepEqual(gate, { ok: true });

  const mismatch = verificationGate(parsed, {
    provider: provider('telebirr'),
    requestedReference: 'ZZZZZZZZZZ',
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.reason, 'reference');
});

test('telebirr reports "no such receipt" as not found', () => {
  const parser = new TelebirrParser();
  assert.throws(
    () => parser.parse(textResponse('<html><body>This request is not correct</body></html>'), { reference: 'ABC1234567' }),
    NotFoundError,
  );
});

test('mpesa joins labels and values that the PDF puts on separate lines', () => {
  // The PDF flattens two columns, so a label often sits above its value and
  // several labels can share a block before the values.
  const parsed = MpesaParser.parseLines([
    'PAYER NAME',
    'SERVICE FEE',
    '+ 15% VAT',
    'ABEBE KEBEDE',
    'RECEIVER NAME',
    'BINGO PLC',
    'PAYER PHONE NUMBER',
    '2519****1111',
    'TRANSACTION ID',
    'ABC1234567',
    'TOTAL',
    '600 Birr',
    'TRANSACTION STATUS',
    'Completed',
  ]);

  assert.equal(parsed.verified, true);
  assert.equal(parsed.reference, 'ABC1234567');
  assert.equal(parsed.amount, 600);
  assert.equal(parsed.totalPaid, 600);
  assert.equal(parsed.senderName, 'ABEBE KEBEDE');
  assert.equal(parsed.receiverName, 'BINGO PLC');
  assert.equal(parsed.senderAccount, '2519****1111');
  assert.equal(parsed.transactionStatus, 'Completed');

  const gate = verificationGate(parsed, {
    provider: provider('mpesa'),
    requestedReference: 'ABC1234567',
  });
  assert.deepEqual(gate, { ok: true });
});

test('mpesa reads the JSON envelope: code 0 carries the PDF, 2032 is not found', () => {
  const success = MpesaParser.decodeEnvelope(
    Buffer.from(JSON.stringify({ responseCode: '0', responseDescription: 'Success', base64Data: 'JVBERi0=' })),
  );
  assert.equal(success.ok, true);

  const missing = MpesaParser.decodeEnvelope(
    Buffer.from(
      JSON.stringify({
        responseCode: '2032',
        responseDescription: 'The transaction receipt number does not exist.',
      }),
    ),
  );
  assert.equal(missing.ok, false);
  if (missing.ok) throw new Error('unreachable');
  assert.equal(missing.reason, 'upstream-error');
  assert.equal(missing.description, 'The transaction receipt number does not exist.');
});

