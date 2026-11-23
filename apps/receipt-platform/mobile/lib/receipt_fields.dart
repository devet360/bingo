class ReceiptFields {
  const ReceiptFields({
    this.provider = '',
    this.reference = '',
    this.amount = '',
    this.currency = '',
    this.date = '',
  });

  final String provider;
  final String reference;
  final String amount;
  final String currency;
  final String date;
}

ReceiptFields extractReceiptFields(String text) {
  final reference = RegExp(
    r'(?:transaction(?:\\s+(?:reference|id|number|no\\.?))?|trans\\.?|reference|ref\\.?|rrn|trace|receipt(?:\\s+(?:number|no\\.?|id))?)\\s*[:#=\\-]?\\s*([A-Z0-9][A-Z0-9-]{5,31})',
    caseSensitive: false,
  ).firstMatch(text)?.group(1) ??
      RegExp(r'\bFT[A-Z0-9]{8,24}\b', caseSensitive: false).firstMatch(text)?.group(0) ??
      '';
  final amount = RegExp(
    r'(?:amount|total|paid|credit(?:ed)?|debit(?:ed)?|birr|ETB)\s*(?:is|:|=|\-)?\s*(?:ETB\s*)?([0-9][0-9,]*(?:\.[0-9]{1,2})?)',
    caseSensitive: false,
  ).firstMatch(text)?.group(1)?.replaceAll(',', '') ?? '';
  final date = RegExp(r'\b(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-](?:20)?\d{2})\b')
      .firstMatch(text)?.group(0) ?? '';
  var provider = '';
  if (RegExp(r'cbe ?birr', caseSensitive: false).hasMatch(text)) {
    provider = 'cbebirr';
  } else if (RegExp(r'commercial bank of ethiopia|\\bcbe\\b', caseSensitive: false).hasMatch(text)) {
    provider = 'cbe';
  } else if (RegExp(r'tele ?birr', caseSensitive: false).hasMatch(text)) {
    provider = 'telebirr';
  } else if (RegExp(r'm[\\s-]?pesa', caseSensitive: false).hasMatch(text)) {
    provider = 'mpesa';
  } else if (RegExp(r'bank of abyssinia|\\bboa\\b', caseSensitive: false).hasMatch(text)) {
    provider = 'boa';
  } else if (RegExp(r'dashen', caseSensitive: false).hasMatch(text)) {
    provider = 'dashen';
  } else if (RegExp(r'awash', caseSensitive: false).hasMatch(text)) {
    provider = 'awash';
  } else if (RegExp(r'e ?birr', caseSensitive: false).hasMatch(text)) {
    provider = 'ebirr';
  }
  final currency = RegExp(r'\bUSD\b|\$', caseSensitive: false).hasMatch(text)
      ? 'USD'
      : RegExp(r'\bETB\b|\bbirr\b', caseSensitive: false).hasMatch(text)
          ? 'ETB'
          : '';

  return ReceiptFields(provider: provider, reference: reference, amount: amount, currency: currency, date: date);
}
