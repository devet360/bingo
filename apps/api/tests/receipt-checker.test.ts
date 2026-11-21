import test from 'node:test';
import assert from 'node:assert/strict';
import { PaymentMethod, type DepositProvider } from '@prisma/client';
import type {
  ReceiptProvider,
  ReceiptSource,
  VerifyInput,
  VerifyOutcome,
} from '../src/services/receipts/types';

// The checker module pulls in env/prisma at import time; provide dummy values
// so the tests never need a database. Everything below runs through injected
// dependencies, not Prisma.
process.env.DATABASE_URL = 'postgresql://bingo:bingo@127.0.0.1:5432/bingo';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
process.env.OTP_HASH_PEPPER = 'c'.repeat(32);
process.env.BOT_TOKEN = '123456:test-checker-token';

type VerifyFn = (
  provider: ReceiptProvider,
  input: VerifyInput,
  source?: ReceiptSource,
) => Promise<VerifyOutcome>;
type VerifyPayloadFn = (
  provider: ReceiptProvider,
  input: VerifyInput,
  payload: { contentType?: string; bodyBase64: string },
  source?: ReceiptSource,
) => Promise<VerifyOutcome>;

function providerRow(code: string, patch: Partial<DepositProvider> = {}): DepositProvider {
  return {
    code,
    name: code.toUpperCase(),
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
    sortOrder: 0,
    instructions: null,
    minAmount: null,
    maxAmount: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...patch,
  };
}

function verifiedOutcome(patch: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return {
    status: 'VERIFIED',
    message: 'Receipt verified by the bank.',
    source: 'SERVER',
    reference: 'FT25ABCDEFGH',
    url: 'https://apps.cbe.com.et:100/BranchReceipt/FT25ABCDEFGH&12345678',
    parsed: {
      verified: true,
      amount: 250,
      currency: 'ETB',
      reference: 'FT25ABCDEFGH',
      senderName: 'ABEBE KEBEDE',
      receiverName: 'BINGO PLC',
      date: '01-02-2026 10:11:12',
      transactionStatus: 'Completed',
      settledAmount: 248.5,
      serviceFee: 1.5,
    },
    ...patch,
  };
}

interface Usage {
  depositId: string | null;
  depositCode: string | null;
  depositStatus: string | null;
  verificationStatus: string;
}

function fakeDeps(
  row: DepositProvider | null,
  options: {
    outcome?: VerifyOutcome;
    payloadOutcome?: VerifyOutcome;
    relayOutcome?: VerifyOutcome;
    usage?: Usage | null;
  } = {},
) {
  const calls = { verify: 0, verifyPayload: 0, relay: 0, usage: [] as string[], loads: [] as string[] };
  const verify = (async () => {
    calls.verify += 1;
    return options.outcome ?? verifiedOutcome();
  }) as VerifyFn;
  const verifyPayload = (async () => {
    calls.verifyPayload += 1;
    return options.payloadOutcome ?? verifiedOutcome({ source: 'CLIENT' });
  }) as VerifyPayloadFn;
  const verifyRelay = (async () => {
    calls.relay += 1;
    return options.relayOutcome ?? verifiedOutcome({ source: 'RELAY' });
  }) as VerifyFn;
  return {
    calls,
    deps: {
      loadProvider: async (code: string) => {
        calls.loads.push(code);
        return row && row.code === code ? row : null;
      },
      verify,
      verifyPayload,
      verifyRelay,
      findUsage: async (providerCode: string, reference: string) => {
        calls.usage.push(`${providerCode}:${reference}`);
        return options.usage ?? null;
      },
    },
  };
}

test('a reachable rail returns the bank receipt detail', async () => {
  const { checkReceipt } = await import('../src/services/receipts/checker');
  const { calls, deps } = fakeDeps(providerRow('cbe'));

  const result = await checkReceipt(
    { providerCode: 'cbe', reference: 'ft25 abcdef gh' },
    deps,
  );

  assert.deepEqual(result.provider, { code: 'cbe', name: 'CBE', method: 'BANK_TRANSFER' });
  assert.equal(result.reference, 'FT25ABCDEFGH');
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.source, 'SERVER');
  assert.equal(result.parsed?.amount, 250);
  assert.equal(result.parsed?.senderName, 'ABEBE KEBEDE');
  assert.equal(result.usedBy, null);
  assert.doesNotThrow(() => new Date(result.checkedAt).toISOString());
  assert.equal(calls.verify, 1);
  assert.equal(calls.verifyPayload, 0);
  // The only database reads are the provider row and the usage lookup.
  assert.deepEqual(calls.usage, ['cbe:FT25ABCDEFGH']);
});

test('an unsupported rail answers without a lookup', async () => {
  const { checkReceipt } = await import('../src/services/receipts/checker');
  const { calls, deps } = fakeDeps(
    providerRow('manual', { parser: null, supported: false }),
  );

  const result = await checkReceipt({ providerCode: 'manual', reference: 'ABC123' }, deps);

  assert.equal(result.status, 'UNSUPPORTED');
  assert.match(result.message, /agent/i);
  assert.equal(calls.verify, 0);
  assert.equal(calls.verifyPayload, 0);
});

test('a geo-blocked rail returns the page to open instead of fetching', async () => {
  const { checkReceipt } = await import('../src/services/receipts/checker');
  const { calls, deps } = fakeDeps(
    providerRow('telebirr', { refPattern: '^[A-Z0-9]{10}$', name: 'Telebirr' }),
  );

  const result = await checkReceipt(
    { providerCode: 'telebirr', reference: 'ABC1234567' },
    deps,
  );

  assert.equal(result.status, 'UNREACHABLE');
  assert.match(result.message, /Ethiopian IP/);
  assert.equal(result.url, 'https://transactioninfo.ethiotelecom.et/receipt/ABC1234567');
  assert.equal(calls.verify, 0);
  assert.equal(calls.verifyPayload, 0);
});

test('attached bank bytes are parsed instead of fetched', async () => {
  const { checkReceipt } = await import('../src/services/receipts/checker');
  const { calls, deps } = fakeDeps(providerRow('telebirr'), {
    payloadOutcome: verifiedOutcome({ source: 'CLIENT', reference: 'ABC1234567' }),
  });

  const result = await checkReceipt(
    {
      providerCode: 'telebirr',
      reference: 'ABC1234567',
      payload: { contentType: 'text/html', bodyBase64: 'PGh0bWw+PC9odG1sPg==' },
    },
    deps,
  );

  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.source, 'CLIENT');
  assert.equal(calls.verifyPayload, 1);
  assert.equal(calls.verify, 0);
});

test('an invalid reference is rejected with the provider hint', async () => {
  const { checkReceipt } = await import('../src/services/receipts/checker');
  const { calls, deps } = fakeDeps(
    providerRow('telebirr', {
      refPattern: '^[A-Z0-9]{10}$',
      refHint: 'Enter the 10-character Telebirr invoice number.',
    }),
  );

  await assert.rejects(
    checkReceipt({ providerCode: 'telebirr', reference: 'short' }, deps),
    (error: { status?: number; code?: string; message?: string }) =>
      error.status === 400 &&
      error.code === 'INVALID_RECEIPT_REFERENCE' &&
      /10-character/.test(error.message ?? ''),
  );
  assert.equal(calls.verify, 0);
});

test('an unknown provider is a 404', async () => {
  const { checkReceipt } = await import('../src/services/receipts/checker');
  const { deps } = fakeDeps(null);

  await assert.rejects(
    checkReceipt({ providerCode: 'nope', reference: 'ABC123' }, deps),
    (error: { status?: number }) => error.status === 404,
  );
});

test('a reference already attached to a deposit is reported', async () => {
  const { checkReceipt } = await import('../src/services/receipts/checker');
  const { deps } = fakeDeps(providerRow('cbe'), {
    usage: {
      depositId: '00000000-0000-0000-0000-000000000001',
      depositCode: 'B-123456',
      depositStatus: 'CREDITED',
      verificationStatus: 'VERIFIED',
    },
  });

  const result = await checkReceipt(
    { providerCode: 'cbe', reference: 'FT25ABCDEFGH' },
    deps,
  );

  assert.deepEqual(result.usedBy, {
    depositId: '00000000-0000-0000-0000-000000000001',
    depositCode: 'B-123456',
    depositStatus: 'CREDITED',
    verificationStatus: 'VERIFIED',
  });
});

test('a relay-enabled rail is checked through the Ethio Telecom relay', async () => {
  const prior = {
    url: process.env.RECEIPT_RELAY_URL,
    key: process.env.RECEIPT_RELAY_API_KEY,
    secret: process.env.RECEIPT_RELAY_API_SECRET,
  };
  process.env.RECEIPT_RELAY_API_KEY = 'rk_test';
  process.env.RECEIPT_RELAY_API_SECRET = 'rs_test';
  process.env.RECEIPT_RELAY_URL = 'https://relay.example.test';
  try {
    const { checkReceipt } = await import('../src/services/receipts/checker');
    const { calls, deps } = fakeDeps(providerRow('telebirr', { refPattern: '^[A-Z0-9]{10}$' }), {
      relayOutcome: verifiedOutcome({
        source: 'RELAY',
        reference: 'ABC1234567',
        url: 'https://transactioninfo.ethiotelecom.et/receipt/ABC1234567',
      }),
    });

    const result = await checkReceipt({ providerCode: 'telebirr', reference: 'ABC1234567' }, deps);

    assert.equal(result.status, 'VERIFIED');
    assert.equal(result.source, 'RELAY');
    assert.equal(result.url, 'https://transactioninfo.ethiotelecom.et/receipt/ABC1234567');
    assert.equal(calls.relay, 1);
    assert.equal(calls.verify, 0);
    assert.equal(calls.verifyPayload, 0);
  } finally {
    if (prior.url === undefined) delete process.env.RECEIPT_RELAY_URL;
    else process.env.RECEIPT_RELAY_URL = prior.url;
    if (prior.key === undefined) delete process.env.RECEIPT_RELAY_API_KEY;
    else process.env.RECEIPT_RELAY_API_KEY = prior.key;
    if (prior.secret === undefined) delete process.env.RECEIPT_RELAY_API_SECRET;
    else process.env.RECEIPT_RELAY_API_SECRET = prior.secret;
  }
});

test('a relay failure still returns the open-the-link message', async () => {
  const prior = {
    url: process.env.RECEIPT_RELAY_URL,
    key: process.env.RECEIPT_RELAY_API_KEY,
    secret: process.env.RECEIPT_RELAY_API_SECRET,
  };
  process.env.RECEIPT_RELAY_API_KEY = 'rk_test';
  process.env.RECEIPT_RELAY_API_SECRET = 'rs_test';
  process.env.RECEIPT_RELAY_URL = 'https://relay.example.test';
  try {
    const { checkReceipt } = await import('../src/services/receipts/checker');
    const { calls, deps } = fakeDeps(providerRow('telebirr', { refPattern: '^[A-Z0-9]{10}$' }), {
      relayOutcome: verifiedOutcome({
        status: 'UNREACHABLE',
        message: 'The receipt service did not answer.',
        source: 'RELAY',
        parsed: undefined,
        url: 'https://transactioninfo.ethiotelecom.et/receipt/ABC1234567',
      }),
    });

    const result = await checkReceipt({ providerCode: 'telebirr', reference: 'ABC1234567' }, deps);

    assert.equal(result.status, 'UNREACHABLE');
    assert.equal(result.source, 'SERVER');
    assert.match(result.message, /Ethiopian IP/);
    assert.equal(result.url, 'https://transactioninfo.ethiotelecom.et/receipt/ABC1234567');
    assert.equal(calls.relay, 1);
    assert.equal(calls.verify, 0);
  } finally {
    if (prior.url === undefined) delete process.env.RECEIPT_RELAY_URL;
    else process.env.RECEIPT_RELAY_URL = prior.url;
    if (prior.key === undefined) delete process.env.RECEIPT_RELAY_API_KEY;
    else process.env.RECEIPT_RELAY_API_KEY = prior.key;
    if (prior.secret === undefined) delete process.env.RECEIPT_RELAY_API_SECRET;
    else process.env.RECEIPT_RELAY_API_SECRET = prior.secret;
  }
});

test('an unreachable bank still returns the link to open', async () => {
  const { checkReceipt } = await import('../src/services/receipts/checker');
  const { deps } = fakeDeps(providerRow('cbe', { accountDigits: 8 }), {
    outcome: verifiedOutcome({
      status: 'UNREACHABLE',
      message: 'CBE did not answer.',
      parsed: undefined,
      url: undefined,
    }),
  });

  const result = await checkReceipt(
    { providerCode: 'cbe', reference: 'FT25ABCDEFGH', accountNumber: '100012345678' },
    deps,
  );

  assert.equal(result.status, 'UNREACHABLE');
  // The suffix is the last eight digits of the receiving account.
  assert.equal(result.url, 'https://apps.cbe.com.et:100/BranchReceipt/FT25ABCDEFGH&12345678');
});

test('the CBE checker needs the account suffix to build the legacy link', async () => {
  const { checkReceipt } = await import('../src/services/receipts/checker');
  const { deps } = fakeDeps(providerRow('cbe', { accountDigits: 8 }), {
    outcome: verifiedOutcome({ url: undefined }),
  });

  const result = await checkReceipt({ providerCode: 'cbe', reference: 'FT25ABCDEFGH' }, deps);

  // Without the suffix there is no page to open; the lookup itself still ran.
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.url, undefined);
});

test('masked receiver accounts match on their visible tail', async () => {
  const { receiverAccountMatches } = await import('../src/services/receipts/deposits');

  assert.equal(receiverAccountMatches('1****5909', '100023145909'), true);
  assert.equal(receiverAccountMatches('1****5909', '100023140000'), false);
  // Unmasked numbers compare the same way.
  assert.equal(receiverAccountMatches('100023145909', '100023145909'), true);
  // Too little overlap to tell: a soft pass, never a false claim.
  assert.equal(receiverAccountMatches('1****', '100023145909'), undefined);
  assert.equal(receiverAccountMatches(undefined, '100023145909'), undefined);
  assert.equal(receiverAccountMatches('1****5909', undefined), undefined);
});
