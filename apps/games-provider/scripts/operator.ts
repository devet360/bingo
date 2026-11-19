import 'dotenv/config';

const baseUrl = (process.env.GAMES_PROVIDER_ADMIN_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const adminToken = process.env.PROVIDER_ADMIN_TOKEN;
const [command, ...args] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function bigintFlag(name: string): bigint | undefined {
  const value = flag(name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`--${name} must be an integer minor-unit value`);
  return BigInt(value);
}

function listFlag(name: string): string[] | undefined {
  const value = flag(name);
  if (value === undefined) return undefined;
  const parts = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`--${name} must not be empty`);
  return parts;
}

async function call(path: string, method = 'GET', body?: unknown) {
  if (!adminToken) throw new Error('PROVIDER_ADMIN_TOKEN is required');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-provider-admin-token': adminToken,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload?.error;
    throw new Error(error?.code ? `${error.code}: ${error.message ?? ''}`.trim() : `HTTP ${response.status}`);
  }
  return payload?.data ?? payload;
}

function limits() {
  const minStake = bigintFlag('min-stake');
  const maxStake = bigintFlag('max-stake');
  const maxWin = bigintFlag('max-win');
  const maxBetsText = flag('max-bets');
  const maxBets = maxBetsText === undefined ? undefined : Number(maxBetsText);
  if (maxBets !== undefined && (!Number.isInteger(maxBets) || maxBets < 1)) {
    throw new Error('--max-bets must be a positive integer');
  }
  if (minStake === undefined && maxStake === undefined && maxWin === undefined && maxBets === undefined) {
    return undefined;
  }
  return { minStake, maxStake, maxWin, maxBetsPerRound: maxBets };
}

async function main() {
  switch (command) {
    case 'list':
      console.table(await call('/api/admin/operators'));
      return;
    case 'create': {
      const code = flag('code');
      const name = flag('name');
      const callbackUrl = flag('callback-url');
      const origins = listFlag('origins');
      if (!code || !name || !callbackUrl || !origins) {
        throw new Error('create requires --code --name --callback-url --origins');
      }
      const patchLimits = limits();
      const data = await call('/api/admin/operators', 'POST', {
        code,
        name,
        callbackUrl,
        allowedOrigins: origins,
        currency: flag('currency'),
        localeDefault: flag('locale'),
        limits: patchLimits && patchLimits.minStake !== undefined && patchLimits.maxStake !== undefined &&
          patchLimits.maxWin !== undefined && patchLimits.maxBetsPerRound !== undefined
          ? {
              minStake: patchLimits.minStake.toString(),
              maxStake: patchLimits.maxStake.toString(),
              maxWin: patchLimits.maxWin.toString(),
              maxBetsPerRound: patchLimits.maxBetsPerRound,
            }
          : undefined,
        enabledGames: listFlag('games'),
        theme: flag('theme') ? JSON.parse(flag('theme')!) : undefined,
      });
      console.log(`operator ${data.operator.code} created (PENDING, secret v${data.secretVersion})`);
      console.log(`secret (shown once): ${data.secret}`);
      return;
    }
    case 'update': {
      const code = flag('code');
      if (!code) throw new Error('update requires --code');
      const patchLimits = limits();
      const data = await call(`/api/admin/operators/${encodeURIComponent(code)}`, 'PATCH', {
        name: flag('name'),
        callbackUrl: flag('callback-url'),
        allowedOrigins: listFlag('origins'),
        localeDefault: flag('locale'),
        limits: patchLimits && patchLimits.minStake !== undefined && patchLimits.maxStake !== undefined &&
          patchLimits.maxWin !== undefined && patchLimits.maxBetsPerRound !== undefined
          ? {
              minStake: patchLimits.minStake.toString(),
              maxStake: patchLimits.maxStake.toString(),
              maxWin: patchLimits.maxWin.toString(),
              maxBetsPerRound: patchLimits.maxBetsPerRound,
            }
          : undefined,
        enabledGames: listFlag('games'),
        maintenance: flag('maintenance') === undefined ? undefined : flag('maintenance') === 'true',
        theme: flag('theme') ? JSON.parse(flag('theme')!) : undefined,
      });
      console.log(`operator ${data.code} updated`);
      return;
    }
    case 'rotate-secret': {
      const code = flag('code');
      if (!code) throw new Error('rotate-secret requires --code');
      const data = await call(`/api/admin/operators/${encodeURIComponent(code)}/secrets`, 'POST');
      console.log(`secret v${data.secretVersion} (shown once): ${data.secret}`);
      return;
    }
    case 'probe': {
      const code = flag('code');
      if (!code) throw new Error('probe requires --code');
      console.log(await call(`/api/admin/operators/${encodeURIComponent(code)}/probe`, 'POST'));
      return;
    }
    case 'activate':
    case 'suspend': {
      const code = flag('code');
      if (!code) throw new Error(`${command} requires --code`);
      const data = await call(`/api/admin/operators/${encodeURIComponent(code)}/status`, 'POST', {
        status: command === 'activate' ? 'ACTIVE' : 'SUSPENDED',
      });
      console.log(`operator ${data.code} status ${data.status}`);
      return;
    }
    default:
      throw new Error('usage: operator <list|create|update|rotate-secret|probe|activate|suspend> [--code ...]');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
