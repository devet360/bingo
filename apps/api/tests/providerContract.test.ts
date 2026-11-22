import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildBalanceReply, buildDefaultLaunchUrlTemplate, buildLaunchUrl, isPlayableLaunchUrl, movementRequiresOpenSession, publicProviderConfig, resolveProviderApiUrl, withBalance } from '../src/lib/providerContract';
import { ProviderProbeSchema } from '../src/lib/providerCallback';

// The provider services pull in env/prisma at import time; provide dummy values
// before the dynamic import so these tests never need a database.
process.env.DATABASE_URL = 'postgresql://bingo:bingo@127.0.0.1:5432/bingo';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(64);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
process.env.OTP_HASH_PEPPER = 'c'.repeat(32);
process.env.BOT_TOKEN = '123456:test-provider-token';

test('launch url substitutes the real currency, not the legacy CREDIT literal', () => {
  const url = buildLaunchUrl('https://crash.example/play?token={token}&lang={lang}&currency={currency}', {
    token: 'f1f1f1f1-1111-4111-8111-111111111111',
    lang: 'am',
    currency: 'ETB',
  });
  assert.equal(
    url,
    'https://crash.example/play?token=f1f1f1f1-1111-4111-8111-111111111111&lang=am&currency=ETB',
  );
});

test('launch url substitutes operator and external game identifiers', () => {
  const ctx = { token: 't', lang: 'en', currency: 'ETB', operator: 'op-a', game: 'crash' };
  assert.equal(
    buildLaunchUrl('https://crash.example/play?token={token}&operator={operator}&game={game}', ctx),
    'https://crash.example/play?token=t&operator=op-a&game=crash',
  );
  assert.equal(
    buildLaunchUrl('https://crash.example/play?token={token}', ctx),
    'https://crash.example/play?token=t',
  );
});

test('default launch url is built from the provider URL and external game config', () => {
  const template = buildDefaultLaunchUrlTemplate(
    'https://games.example.com/api',
    'partner01',
    'coin flip',
  );
  assert.equal(
    template,
    'https://games.example.com/play?operator=partner01&game=coin+flip&token={token}&lang={lang}&currency={currency}',
  );
  assert.equal(
    buildLaunchUrl(template, { token: 'session token', lang: 'am', currency: 'ETB' }),
    'https://games.example.com/play?operator=partner01&game=coin+flip&token=session%20token&lang=am&currency=ETB',
  );
  assert.equal(buildDefaultLaunchUrlTemplate(null, 'partner01', 'crash'), null);
  assert.equal(buildDefaultLaunchUrlTemplate('ftp://games.example.com', 'partner01', 'crash'), null);
});

test('provider API endpoints resolve from the host root even when the configured URL has a path', () => {
  assert.equal(
    resolveProviderApiUrl('https://games.example.com/api/v2/', '/api/admin/operators').toString(),
    'https://games.example.com/api/admin/operators',
  );
  assert.throws(() => resolveProviderApiUrl('https://games.example.com', 'api/admin/operators'));
});

test('launch url is null without a template and encodes the token', () => {
  assert.equal(buildLaunchUrl(null, { token: 'a b', lang: 'en', currency: 'ETB' }), null);
  assert.equal(
    buildLaunchUrl('https://x/play?t={sessionId}', { token: 'a b', lang: 'en', currency: 'ETB' }),
    'https://x/play?t=a%20b',
  );
});

test('launch templates must be absolute http(s) URLs to be playable', () => {
  assert.equal(isPlayableLaunchUrl('https://crash.example/play?token={token}&lang={lang}'), true);
  assert.equal(isPlayableLaunchUrl('http://crash.example/play?token={token}'), true);
  assert.equal(isPlayableLaunchUrl('crash.example/play?token={token}'), false);
  assert.equal(isPlayableLaunchUrl('https://<crash-host>/play?token={token}'), false);
  assert.equal(isPlayableLaunchUrl('javascript:alert(1)'), false);
  assert.equal(isPlayableLaunchUrl(null), false);
});

test('balance reply signs the exact sessionId.currency.balance.timestamp.nonce string', () => {
  const reply = buildBalanceReply({
    secret: 'test-secret',
    sessionId: 's-1',
    currency: 'ETB',
    balance: 12345n,
    minStake: 100n,
    maxStake: 100000n,
    maxWin: 3000000n,
    timestamp: 1763400000,
    nonce: 'n-1',
  });
  const expected = createHmac('sha256', 'test-secret')
    .update('s-1.ETB.12345.1763400000.n-1')
    .digest('hex');
  assert.equal(reply.signature, expected);
  assert.equal(reply.balance, '12345');
  assert.equal(reply.minStake, '100');
  assert.equal(reply.maxStake, '100000');
  assert.equal(reply.maxWin, '3000000');
});

test('balance reply omits limits that are not configured', () => {
  const reply = buildBalanceReply({
    secret: 's',
    sessionId: 's-1',
    currency: 'ETB',
    balance: 0n,
    minStake: null,
    maxStake: null,
    maxWin: null,
    timestamp: 1,
    nonce: 'n',
  });
  assert.equal('minStake' in reply, false);
  assert.equal('maxWin' in reply, false);
});

test('withBalance appends the post-movement balance as a string', () => {
  assert.deepEqual(withBalance({ accepted: true, replayed: false }, 900n), {
    accepted: true,
    replayed: false,
    balance: '900',
  });
});

test('settlements do not require an open session but reads and debits do', () => {
  assert.equal(movementRequiresOpenSession('win'), false);
  assert.equal(movementRequiresOpenSession('rollback'), false);
  assert.equal(movementRequiresOpenSession('bet'), true);
  assert.equal(movementRequiresOpenSession('balance'), true);
});

test('provider config serialization never exposes the previous webhook secret', () => {
  assert.deepEqual(publicProviderConfig({ previousWebhookSecret: 'old-secret', locale: 'en' }), { locale: 'en' });
  assert.deepEqual(publicProviderConfig({ locale: 'en' }), { locale: 'en' });
  assert.equal(publicProviderConfig(null), null);
  assert.deepEqual(publicProviderConfig({ nested: { a: 1 } }), { nested: { a: 1 } });
});

test('probe payloads are validated strictly', () => {
  assert.equal(ProviderProbeSchema.safeParse({ type: 'probe' }).success, true);
  assert.equal(ProviderProbeSchema.safeParse({ type: 'probe', timestamp: 1 }).success, true);
  assert.equal(ProviderProbeSchema.safeParse({ type: 'win' }).success, false);
  assert.equal(ProviderProbeSchema.safeParse({ type: 'probe', timestamp: 'now' }).success, false);
});

/* ------------------------------------------------------------------ *
 * Probe endpoint (POST /api/games/callback/:providerCode/probe)
 * ------------------------------------------------------------------ */

interface ProbeAuditRow {
  providerCode: string;
  type: unknown;
  externalTxnId: unknown;
  externalSessionId: unknown;
  signatureValid: boolean;
  amount: unknown;
  currency: unknown;
  payload: unknown;
  ip: string | null;
  httpStatus: number;
  error: string | null;
}

interface ProbePrismaStub {
  gameProvider: { findUnique: (args: unknown) => Promise<unknown> };
  providerCallbackLog: { create: (args: { data: ProbeAuditRow }) => Promise<unknown> };
}

const PROBE_PROVIDER = {
  id: 'prov-1',
  code: 'op-a',
  webhookSecret: 'probe-secret',
  config: null,
};

async function withProbeStubs<T>(
  provider: Record<string, unknown> | null,
  run: (audits: ProbeAuditRow[]) => Promise<T>,
): Promise<T> {
  const { prisma } = await import('../src/lib/prisma');
  const client = prisma as unknown as ProbePrismaStub;
  const originalFind = client.gameProvider.findUnique;
  const originalCreate = client.providerCallbackLog.create;
  const audits: ProbeAuditRow[] = [];
  client.gameProvider.findUnique = async () => provider;
  client.providerCallbackLog.create = async ({ data }) => {
    audits.push(data);
    return data;
  };
  try {
    return await run(audits);
  } finally {
    client.gameProvider.findUnique = originalFind;
    client.providerCallbackLog.create = originalCreate;
  }
}

function scopedSignature(secret: string, code: string, body: string): string {
  return createHmac('sha256', secret).update(`${code}.${body}`).digest('hex');
}

test('probe accepts a scoped signature, echoes the provider code and audits the hit', async () => {
  const { handleProviderProbe } = await import('../src/services/gameProviders');
  const body = { type: 'probe', operator: 'someone-else', timestamp: 1763400000 };
  const rawBody = Buffer.from(JSON.stringify(body));

  await withProbeStubs(PROBE_PROVIDER, async (audits) => {
    const result = await handleProviderProbe({
      providerCode: 'op-a',
      rawBody,
      signature: scopedSignature('probe-secret', 'op-a', rawBody.toString('utf8')),
      body,
      ip: '203.0.113.9',
    });
    assert.deepEqual(result, { status: 200, data: { ok: true, operator: 'op-a' } });
    assert.equal(audits.length, 1);
    const [audit] = audits;
    assert.equal(audit!.providerCode, 'op-a');
    assert.equal(audit!.type, null);
    assert.equal(audit!.externalTxnId, null);
    assert.equal(audit!.externalSessionId, null);
    assert.equal(audit!.signatureValid, true);
    assert.equal(audit!.amount, null);
    assert.equal(audit!.currency, null);
    assert.deepEqual(audit!.payload, body);
    assert.equal(audit!.ip, '203.0.113.9');
    assert.equal(audit!.httpStatus, 200);
    assert.equal(audit!.error, null);
  });
});

test('probe rejects a bad signature with 403 and audits the failure', async () => {
  const { handleProviderProbe } = await import('../src/services/gameProviders');
  const body = { type: 'probe' };
  const rawBody = Buffer.from(JSON.stringify(body));

  await withProbeStubs(PROBE_PROVIDER, async (audits) => {
    await assert.rejects(
      handleProviderProbe({
        providerCode: 'op-a',
        rawBody,
        signature: 'deadbeef',
        body,
        ip: null,
      }),
      (error: unknown) => {
        const appError = error as { status?: number; code?: string };
        return appError.status === 403 && appError.code === 'SIGNATURE_INVALID';
      },
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.signatureValid, false);
    assert.equal(audits[0]!.httpStatus, 403);
    assert.equal(audits[0]!.error, 'SIGNATURE_INVALID');
  });
});

test('probe rejects malformed payloads with 400 after the signature check', async () => {
  const { handleProviderProbe } = await import('../src/services/gameProviders');
  const body = { type: 'probe', timestamp: 'now' };
  const rawBody = Buffer.from(JSON.stringify(body));

  await withProbeStubs(PROBE_PROVIDER, async (audits) => {
    await assert.rejects(
      handleProviderProbe({
        providerCode: 'op-a',
        rawBody,
        signature: scopedSignature('probe-secret', 'op-a', rawBody.toString('utf8')),
        body,
        ip: null,
      }),
      (error: unknown) => {
        const appError = error as { status?: number; code?: string };
        return appError.status === 400 && appError.code === 'PROBE_MALFORMED';
      },
    );
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.signatureValid, true);
    assert.equal(audits[0]!.httpStatus, 400);
    assert.equal(audits[0]!.error, 'PROBE_MALFORMED');
  });
});

test('probe for an unknown provider is a 404 and writes no audit row', async () => {
  const { handleProviderProbe } = await import('../src/services/gameProviders');
  const body = { type: 'probe' };

  await withProbeStubs(null, async (audits) => {
    await assert.rejects(
      handleProviderProbe({
        providerCode: 'missing',
        rawBody: Buffer.from(JSON.stringify(body)),
        signature: 'x',
        body,
        ip: null,
      }),
      (error: unknown) => {
        const appError = error as { status?: number; code?: string };
        return appError.status === 404 && appError.code === 'NOT_FOUND';
      },
    );
    assert.equal(audits.length, 0);
  });
});
