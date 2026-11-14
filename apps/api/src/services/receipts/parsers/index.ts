/**
 * Parser registry: provider row -> parser instance.
 *
 * The DB stores a `parser` key so several providers can share one parser
 * (nib, wegagen, ahadu and kaafimf are all eBirr tenants). The key is also the
 * HTTP allowlist key, so a provider can never point the fetcher at a host its
 * parser was not written for.
 */
import type { ReceiptProvider } from '../types';
import type { BankParser } from './base';
import { TelebirrParser } from './telebirr';
import { CbeParser } from './cbe';
import { BoaParser } from './boa';
import { DashenParser } from './dashen';
import { AwashParser } from './awash';
import { CbeBirrParser } from './cbebirr';
import { MpesaParser } from './mpesa';
import { EbirrParser } from './ebirr';
import { BunnaParser } from './bunna';
import { ZamzamParser } from './zamzam';
import { ZemenParser } from './zemen';

const SINGLETONS: Record<string, BankParser> = {
  telebirr: new TelebirrParser(),
  mpesa: new MpesaParser(),
  cbe: new CbeParser(),
  boa: new BoaParser(),
  dashen: new DashenParser(),
  awash: new AwashParser(),
  cbebirr: new CbeBirrParser(),
  bunna: new BunnaParser(),
  zamzam: new ZamzamParser(),
  zemen: new ZemenParser(),
  ebirr: new EbirrParser('ebirr'),
  siinqee: new EbirrParser('siinqee', 'siinqee'),
};

/**
 * The parser for a provider, or undefined when the provider is manual-only.
 * An eBirr tenant (nib, wegagen, ...) uses its own code as the tenant segment.
 */
export function createParser(provider: Pick<ReceiptProvider, 'code' | 'parser' | 'supported'>): BankParser | undefined {
  if (!provider.supported) return undefined;
  const key = provider.parser ?? '';
  if (key === 'ebirr' && provider.code !== 'ebirr') {
    // nib / wegagen / ahadu / kaafimf: the link carries only the token.
    return new EbirrParser(key, provider.code);
  }
  return SINGLETONS[key];
}

/** The allowlist key used for a provider's fetches. */
export function parserKey(provider: Pick<ReceiptProvider, 'code' | 'parser'>): string {
  return provider.parser ?? provider.code;
}
