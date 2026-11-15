import { resolve } from 'node:path';
import { config } from 'dotenv';
import { z } from 'zod';

// The API usually runs from apps/api (workspace script) while .env lives at the repo root.
config({
  path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')],
});

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Dokku injects PORT; API_PORT remains for local runs. Dokku sets PORT=0 for
  // non-web Procfile processes (worker/bot), which must boot without listening.
  PORT: z.coerce.number().int().min(0).optional(),
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

  // Dedicated customer-support bot. Optional for the API itself; the
  // `support-bot` process refuses to start without it.
  SUPPORT_BOT_TOKEN: z.string().min(10).optional(),
  SUPPORT_HOURS_START: z.coerce.number().int().min(0).max(23).default(8),
  SUPPORT_HOURS_END: z.coerce.number().int().min(0).max(24).default(22),
  SUPPORT_TIMEZONE: z.string().min(1).default('Africa/Addis_Ababa'),

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
  // How long an agent has to finish a routed deposit/withdrawal before the
  // task shows as overdue (and, while still pre-money, is released).
  AGENT_TASK_SLA_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(30),
  // Payment screenshots live on the mounted media volume, never in Postgres.
  MEDIA_DIR: z.string().default('.data/media'),
  MEDIA_MAX_BYTES: z.coerce.number().int().min(64_000).max(20_000_000).default(5_000_000),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  port: parsed.data.API_PORT ?? (parsed.data.PORT ? parsed.data.PORT : undefined) ?? 4000,
  isProd: parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  mediaDir: resolve(process.cwd(), parsed.data.MEDIA_DIR),
};
