import test from 'node:test';
import assert from 'node:assert/strict';
import { PaymentMethod } from '@prisma/client';
import type { ReceiptProvider } from '../src/services/receipts/types';
import { relayEnabled, relayFetchPayload, verifyViaRelay, type RelayFetch } from '../src/services/receipts/relay';

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
  <tr><td></td><td>የማህተም ክፍያ/Stamp Duty</td><td>0.00 Birr</td></tr>
  <tr><td></td><td>የአገልግሎት ክፍያ/Service fee</td><td>1.74 Birr</td></tr>
  <tr><td></td><td>ጠቅላላ የተከፈለው መጠን/Total Paid Amount</td><td>106 Birr</td></tr>
</table>
</body></html>`;

function provider(code: string, patch: Partial<ReceiptProvider> = {}): ReceiptProvider {
  return {
    code,
    name: code.toUpperCase(),
    method: PaymentMethod.MOBILE_MONEY,
    parser: code,
    endpoint: null,
    refPattern: null,
    refHint: null,
    accountDigits: null,
    requiresPhone: false,
    opaqueReference: false,
    clientSide: true,
    geoBlocked: true,
    supported: true,
    enabled: true,
    ...patch,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('relay fetches the raw body and hands it to the parser', async () => {
  const calls: string[] = [];
  const fake: RelayFetch = async (input) => {
    calls.push(String(input));
    return jsonResponse({
      ok: true,
      provider: 'telebirr',
      reference: 'ABC1234567',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      bodyBase64: Buffer.from(TELEBIRR_HTML, 'utf8').toString('base64'),
    });
  };

  const outcome = await verifyViaRelay(
    provider('telebirr'),
    { reference: 'ABC1234567' },
    'RELAY',
    fake,
    'https://relay.example.test',
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://relay.example.test/receipts/telebirr/ABC1234567');
  assert.equal(outcome.status, 'VERIFIED');
  assert.equal(outcome.source, 'RELAY');
  assert.equal(outcome.parsed?.amount, 106);
  assert.equal(outcome.parsed?.senderName, 'ABEBE KEBEDE');
  assert.equal(outcome.url, 'https://transactioninfo.ethiotelecom.et/receipt/ABC1234567');
});

test('relay payload is still gate-checked against the requested reference', async () => {
  const fake: RelayFetch = async () =>
    jsonResponse({
      ok: true,
      contentType: 'text/html',
      bodyBase64: Buffer.from(TELEBIRR_HTML, 'utf8').toString('base64'),
    });

  const outcome = await verifyViaRelay(
    provider('telebirr'),
    { reference: 'ZZZZZZZZZZ' },
    'RELAY',
    fake,
    'https://relay.example.test',
  );

  assert.equal(outcome.status, 'NOT_MATCHED');
  assert.equal(outcome.source, 'RELAY');
});

test('relay failures are UNREACHABLE so the caller can fall back', async () => {
  const cases: Array<[string, RelayFetch]> = [
    ['timeout', async () => Promise.reject(new Error('timeout'))],
    ['service error', async () => jsonResponse({ ok: false, code: 'TIMEOUT', message: 'slow' }, 504)],
    ['bad envelope', async () => jsonResponse({ ok: false, code: 'UPSTREAM_ERROR', message: 'down' })],
    ['unreadable body', async () => new Response('not json', { status: 200 })],
    ['empty payload', async () => jsonResponse({ ok: true, bodyBase64: '' })],
  ];

  for (const [name, fake] of cases) {
    const outcome = await verifyViaRelay(
      provider('mpesa'),
      { reference: 'SFJ8K2LM9P' },
      'RELAY',
      fake,
      'https://relay.example.test',
    );
    assert.equal(outcome.status, 'UNREACHABLE', name);
    assert.equal(outcome.source, 'RELAY', name);
    assert.equal(outcome.reference, 'SFJ8K2LM9P', name);
  }
});

test('relay refuses a payload larger than the provider allows', async () => {
  const fake: RelayFetch = async () =>
    jsonResponse({ ok: true, bodyBase64: 'A'.repeat(7_200_000) });

  const result = await relayFetchPayload(
    provider('telebirr'),
    { reference: 'ABC1234567' },
    fake,
    'https://relay.example.test',
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /larger than expected/);
});

test('relay covers only the geo-blocked rails', () => {
  process.env.RECEIPT_RELAY_URL = 'https://relay.example.test/';
  try {
    assert.equal(relayEnabled(provider('telebirr')), true);
    assert.equal(relayEnabled(provider('mpesa')), true);
    assert.equal(relayEnabled(provider('cbe', { method: PaymentMethod.BANK_TRANSFER, geoBlocked: false })), false);
  } finally {
    delete process.env.RECEIPT_RELAY_URL;
  }
  assert.equal(relayEnabled(provider('telebirr')), false);
});

test('relay requests never leave the configured base URL unencoded', async () => {
  const calls: string[] = [];
  const fake: RelayFetch = async (input) => {
    calls.push(String(input));
    return jsonResponse({ ok: false, code: 'INVALID_REFERENCE', message: 'bad' }, 400);
  };

  await relayFetchPayload(provider('telebirr'), { reference: 'AB/12 34?#' }, fake, 'https://relay.example.test');

  assert.equal(calls[0], 'https://relay.example.test/receipts/telebirr/AB%2F12%2034%3F%23');
});
