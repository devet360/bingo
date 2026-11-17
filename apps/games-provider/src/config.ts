import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  OPERATOR_CODE: z.string().min(1).default('bingo251'),
  OPERATOR_CALLBACK_URL: z.string().url(),
  OPERATOR_HMAC_SECRET: z.string().min(16),
  OPERATOR_CURRENCY: z.string().length(3).default('ETB'),
  ALLOWED_PARENT_ORIGINS: z.string().default(''),
  GAME_MIN_STAKE: z.coerce.bigint().default(100n),
  GAME_MAX_STAKE: z.coerce.bigint().default(100_000n),
  GAME_MAX_WIN: z.coerce.bigint().default(3_000_000n),
  BOT_COUNT: z.coerce.number().int().min(0).default(0),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.parse(env);
  if (parsed.BOT_COUNT !== 0) throw new Error('BOT_COUNT must be 0 in V1');
  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    operator: {
      code: parsed.OPERATOR_CODE,
      callbackUrl: parsed.OPERATOR_CALLBACK_URL,
      hmacSecret: parsed.OPERATOR_HMAC_SECRET,
      currency: parsed.OPERATOR_CURRENCY.toUpperCase(),
    },
    allowedParentOrigins: parsed.ALLOWED_PARENT_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    limits: {
      minStake: parsed.GAME_MIN_STAKE,
      maxStake: parsed.GAME_MAX_STAKE,
      maxWin: parsed.GAME_MAX_WIN,
    },
    botCount: 0 as const,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
