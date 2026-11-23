import assert from 'node:assert/strict';
import test from 'node:test';
import { extractReceiptFields } from './receipt-extractor.ts';

test('extracts reviewable fields from a CBE receipt', () => {
  assert.deepEqual(
    extractReceiptFields('Commercial Bank of Ethiopia\nTransaction reference: FT123456789012\nAmount: 1,250.00 ETB\nDate: 2026-11-23'),
    { provider: 'cbe', reference: 'FT123456789012', amount: '1250.00', currency: 'ETB', date: '2026-11-23' },
  );
});

test('recognizes CBE Birr before the broader CBE label', () => {
  assert.equal(extractReceiptFields('CBE Birr transfer amount 32 ETB').provider, 'cbebirr');
});

test('does not infer references or amounts from success text alone', () => {
  const fields = extractReceiptFields('SUCCESS payment 100.00 ETB');
  assert.equal(fields.reference, '');
  assert.equal(fields.amount, '');
});
