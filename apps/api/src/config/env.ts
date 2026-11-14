import { resolve } from 'node:path';
import { config } from 'dotenv';
import { z } from 'zod';

// The API usually runs from apps/api (workspace script) while .env lives at the repo root.
config({
  path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')],
});

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Dokku injects PORT; API_PORT remains for local runs.
  PORT: z.coerce.number().int().positive().optional(),
  API_PORT: z.coerce.number().int().positive().optional(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).optional(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_REFRESH_TTL: z.string().default('30d'),
  OTP_HASH_PEPPER: z.string().min(16),

  BOT_TOKEN: z.string().min(10),
  TELEGRAM_LOGIN_MAX_AGE_SECS: z.coerce.number().int().positive().default(300),
  TELEGRAM_WEBAPP_URL: z.string().url().optional(),
  // Shown to players who must open the bot to verify their number.
  TELEGRAM_BOT_USERNAME: z.string().min(2).optional(),

  DEFAULT_DEPOSIT_COMMISSION_BPS: z.coerce.number().int().min(0).max(10_000).default(300),
  DEFAULT_WITHDRAWAL_COMMISSION_BPS: z.coerce.number().int().min(0).max(10_000).default(200),
  WITHDRAWAL_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(0),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.string().default('info'),

  BINGO_ENGINE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  port: parsed.data.API_PORT ?? parsed.data.PORT ?? 4000,
  isProd: parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};
