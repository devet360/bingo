import type { AppConfig } from '../config';
import type { Store } from './store';

export async function seedBootstrapOperator(store: Store, config: AppConfig): Promise<void> {
  if (!config.operator.callbackUrl || !config.operator.hmacSecret) return;
  if (await store.getOperator(config.operator.code)) return;

  const now = new Date();
  await store.upsertOperator({
    code: config.operator.code,
    name: config.operator.name,
    callbackUrl: config.operator.callbackUrl,
    currency: config.operator.currency,
    status: 'ACTIVE',
    allowedOrigins: config.allowedParentOrigins,
    localeDefault: 'en',
    limits: config.limits,
    enabledGames: ['crash'],
    theme: null,
    botConfig: config.botConfig,
    maintenance: false,
    probeOkAt: now,
    createdAt: now,
  });
  await store.addOperatorSecret(config.operator.code, config.operator.hmacSecret);
}
