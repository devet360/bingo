import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  OPERATOR_CODE: z.string().min(1).default('bingo251'),
  OPERATOR_NAME: z.string().min(1).default('Bingo 251'),
  OPERATOR_CALLBACK_URL: z.string().url(),
  OPERATOR_HMAC_SECRET: z.string().min(16),
  OPERATOR_CURRENCY: z.string().length(3).default('ETB'),
  ALLOWED_PARENT_ORIGINS: z.string().default(''),
  GAME_MIN_STAKE: z.coerce.bigint().min(1n).default(100n),
  GAME_MAX_STAKE: z.coerce.bigint().min(1n).default(100_000n),
  GAME_MAX_WIN: z.coerce.bigint().min(1n).default(3_000_000n),
  GAME_MAX_BETS_PER_ROUND: z.coerce.number().int().positive().default(200),
  CLIENT_SEEDS: z.string().default(
    'stratos_slot_1_00000001,stratos_slot_2_00000002,stratos_slot_3_00000003',
  ),
  BOT_COUNT: z.coerce.number().int().min(0).default(0),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.parse(env);
  if (parsed.BOT_COUNT !== 0) throw new Error('BOT_COUNT must be 0 in V1');
  const clientSeeds = parsed.CLIENT_SEEDS.split(',').map((seed) => seed.trim()).filter(Boolean);
  if (clientSeeds.length !== 3) throw new Error('CLIENT_SEEDS must list exactly 3 comma-separated seeds');
  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    operator: {
      code: parsed.OPERATOR_CODE,
      name: parsed.OPERATOR_NAME,
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
      maxBetsPerRound: parsed.GAME_MAX_BETS_PER_ROUND,
    },
    clientSeeds,
    botCount: 0 as const,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
