import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  OPERATOR_CODE: z.string().min(1).default('bingo251'),
  OPERATOR_NAME: z.string().min(1).default('Bingo 251'),
  OPERATOR_CALLBACK_URL: z.string().url().optional(),
  OPERATOR_HMAC_SECRET: z.string().min(16).optional(),
  OPERATOR_CURRENCY: z.string().length(3).default('ETB'),
  ALLOWED_PARENT_ORIGINS: z.string().default(''),
  GAME_MIN_STAKE: z.coerce.bigint().min(1n).default(100n),
  GAME_MAX_STAKE: z.coerce.bigint().min(1n).default(100_000n),
  GAME_MAX_WIN: z.coerce.bigint().min(1n).default(3_000_000n),
  GAME_MAX_BETS_PER_ROUND: z.coerce.number().int().positive().default(200),
  PROVIDER_ADMIN_TOKEN: z.string().min(16).optional(),
  DEFAULT_OPERATOR_CODE: z.string().min(1).optional(),
  CLIENT_SEEDS: z.string().default(
    'stratos_slot_1_00000001,stratos_slot_2_00000002,stratos_slot_3_00000003',
  ),
  BOT_COUNT: z.coerce.number().int().min(0).max(100).default(0),
  BOT_STAKE_MIN: z.coerce.bigint().min(1n).default(100n),
  BOT_STAKE_MAX: z.coerce.bigint().min(1n).default(10_000n),
  BOT_ROUND_PAYOUT_CAP: z.coerce.bigint().min(0n).default(0n),
  BOT_DAY_PAYOUT_CAP: z.coerce.bigint().min(0n).default(0n),
  BOT_DISCLOSE: z.enum(['true', 'false']).default('true'),
  CHAT_ENABLED: z.enum(['true', 'false']).default('false'),
  CHAT_MAX_MESSAGE_LENGTH: z.coerce.number().int().positive().default(500),
  CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  CHAT_BLOCKED_PATTERNS: z.string().default(''),
  CHAT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  CONSOLE_TOKEN_SECRET: z.string().min(32).optional(),
}).superRefine((config, context) => {
  if (Boolean(config.OPERATOR_CALLBACK_URL) !== Boolean(config.OPERATOR_HMAC_SECRET)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPERATOR_CALLBACK_URL'],
      message: 'OPERATOR_CALLBACK_URL and OPERATOR_HMAC_SECRET must either both be set or both be omitted',
    });
  }
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.parse(env);
  if (parsed.BOT_STAKE_MIN > parsed.BOT_STAKE_MAX) {
    throw new Error('BOT_STAKE_MIN must not exceed BOT_STAKE_MAX');
  }
  const clientSeeds = parsed.CLIENT_SEEDS.split(',').map((seed) => seed.trim()).filter(Boolean);
  if (clientSeeds.length !== 3) throw new Error('CLIENT_SEEDS must list exactly 3 comma-separated seeds');
  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    operator: {
      code: parsed.OPERATOR_CODE,
      name: parsed.OPERATOR_NAME,
      callbackUrl: parsed.OPERATOR_CALLBACK_URL ?? null,
      hmacSecret: parsed.OPERATOR_HMAC_SECRET ?? null,
      currency: parsed.OPERATOR_CURRENCY.toUpperCase(),
    },
    allowedParentOrigins: parsed.ALLOWED_PARENT_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    limits: {
      minStake: parsed.GAME_MIN_STAKE,
      maxStake: parsed.GAME_MAX_STAKE,
      maxWin: parsed.GAME_MAX_WIN,
      maxBetsPerRound: parsed.GAME_MAX_BETS_PER_ROUND,
    },
    clientSeeds,
    botCount: parsed.BOT_COUNT,
    botConfig: {
      enabled: parsed.BOT_COUNT > 0,
      count: parsed.BOT_COUNT,
      stakeMin: parsed.BOT_STAKE_MIN,
      stakeMax: parsed.BOT_STAKE_MAX,
      roundPayoutCap: parsed.BOT_ROUND_PAYOUT_CAP,
      dayPayoutCap: parsed.BOT_DAY_PAYOUT_CAP,
      disclose: parsed.BOT_DISCLOSE === 'true',
    } as const,
    chat: {
      enabled: parsed.CHAT_ENABLED === 'true',
      maxMessageLength: parsed.CHAT_MAX_MESSAGE_LENGTH,
      rateLimitPerMinute: parsed.CHAT_RATE_LIMIT_PER_MINUTE,
      blockedPatterns: parsed.CHAT_BLOCKED_PATTERNS.split(',').map((item) => item.trim()).filter(Boolean),
      retentionDays: parsed.CHAT_RETENTION_DAYS,
    } as const,
    consoleTokenSecret: parsed.CONSOLE_TOKEN_SECRET ?? null,
    adminToken: parsed.PROVIDER_ADMIN_TOKEN ?? null,
    defaultOperatorCode: parsed.DEFAULT_OPERATOR_CODE ?? parsed.OPERATOR_CODE,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
