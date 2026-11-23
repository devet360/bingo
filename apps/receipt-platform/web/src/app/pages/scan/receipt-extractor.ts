export interface ReceiptFields {
  provider: string;
  reference: string;
  amount: string;
  currency: string;
  date: string;
}

const providerPatterns: Array<[string, RegExp]> = [
  ['cbebirr', /cbe ?birr/i],
  ['cbe', /commercial bank of ethiopia|\\bcbe\\b/i],
  ['telebirr', /tele ?birr/i],
  ['mpesa', /m[\s-]?pesa/i],
  ['boa', /bank of abyssinia|\bboa\b/i],
  ['dashen', /dashen/i],
  ['awash', /awash/i],
  ['cbebirr', /cbe ?birr/i],
  ['ebirr', /e ?birr/i],
  ['bunna', /bunna/i],
  ['zamzam', /zam ?zam/i],
  ['zemen', /zemen/i],
];

export function extractReceiptFields(text: string): ReceiptFields {
  const normalized = text.replace(/[\u00a0\u2007\u202f]/g, ' ');
  const reference = normalized.match(
    /(?:transaction(?:\\s+(?:reference|id|number|no\\.?))?|trans\\.?|reference|ref\\.?|rrn|trace|receipt(?:\\s+(?:number|no\\.?|id))?)\\s*[:#=\\-]?\\s*([A-Z0-9][A-Z0-9-]{5,31})/i,
  )?.[1] ?? normalized.match(/\bFT[A-Z0-9]{8,24}\b/i)?.[0] ?? '';
  const amountMatch = normalized.match(
    /(?:amount|total|paid|credit(?:ed)?|debit(?:ed)?|birr|ETB)\s*(?:is|:|=|\-)?\s*(?:ETB\s*)?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
  );
  const date = normalized.match(
    /\b(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-](?:20)?\d{2})\b/,
  )?.[0] ?? '';
  const provider = providerPatterns.find(([, pattern]) => pattern.test(normalized))?.[0] ?? '';
  const currency = /\bUSD\b|\$/.test(normalized) ? 'USD' : /\bETB\b|\bbirr\b/i.test(normalized) ? 'ETB' : '';

  return {
    provider,
    reference: reference.trim(),
    amount: amountMatch?.[1]?.replaceAll(',', '') ?? '',
    currency,
    date,
  };
}
