import 'package:flutter_test/flutter_test.dart';
import 'package:verity_mobile/receipt_fields.dart';

void main() {
  test('extracts receipt candidates without verifying payment', () {
    final fields = extractReceiptFields('Commercial Bank of Ethiopia\nTransaction reference: FT123456789012\nAmount: 1,250.00 ETB\nDate: 2026-11-23');

    expect(fields.provider, 'cbe');
    expect(fields.reference, 'FT123456789012');
    expect(fields.amount, '1250.00');
    expect(fields.currency, 'ETB');
    expect(fields.date, '2026-11-23');
  });
}
