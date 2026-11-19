import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const roundStatus = pgEnum('round_status', ['BETTING', 'FLYING', 'CRASHED', 'ABANDONED']);
export const betStatus = pgEnum('bet_status', ['PLACING', 'ACTIVE', 'CASHED', 'LOST', 'CANCELLED', 'REJECTED', 'UNRESOLVED']);
export const outboxType = pgEnum('outbox_type', ['WIN', 'ROLLBACK']);
export const outboxStatus = pgEnum('outbox_status', ['PENDING', 'SENT', 'CAP_REJECTED', 'DEAD']);
export const operatorStatus = pgEnum('operator_status', ['PENDING', 'ACTIVE', 'SUSPENDED']);

export const operators = pgTable('operators', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  callbackUrl: text('callback_url').notNull(),
  currency: text('currency').notNull(),
  status: operatorStatus('status').notNull().default('PENDING'),
  allowedOrigins: text('allowed_origins').array().notNull().default(sql`'{}'::text[]`),
  localeDefault: text('locale_default').notNull().default('en'),
  minStake: bigint('min_stake', { mode: 'bigint' }).notNull().default(sql`100`),
  maxStake: bigint('max_stake', { mode: 'bigint' }).notNull().default(sql`100000`),
  maxWin: bigint('max_win', { mode: 'bigint' }).notNull().default(sql`3000000`),
  maxBetsPerRound: integer('max_bets_per_round').notNull().default(200),
  enabledGames: text('enabled_games').array().notNull().default(sql`'{crash}'::text[]`),
  theme: jsonb('theme').$type<Record<string, unknown> | null>(),
  maintenance: boolean('maintenance').notNull().default(false),
  probeOkAt: timestamp('probe_ok_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const operatorSecrets = pgTable('operator_secrets', {
  operatorCode: text('operator_code').notNull().references(() => operators.code, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  secret: text('secret').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.operatorCode, table.version] })]);

export const sessions = pgTable('sessions', {
  token: uuid('token').primaryKey(),
  operatorCode: text('operator_code').notNull(),
  gameId: text('game_id').notNull().default('crash'),
  currency: text('currency').notNull(),
  minStake: bigint('min_stake', { mode: 'bigint' }).notNull(),
  maxStake: bigint('max_stake', { mode: 'bigint' }).notNull(),
  maxWin: bigint('max_win', { mode: 'bigint' }).notNull(),
  maxBetsPerRound: integer('max_bets_per_round').notNull().default(200),
  displayBalance: bigint('display_balance', { mode: 'bigint' }).notNull().default(sql`0`),
  status: text('status').notNull().default('OPEN'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastHandshakeAt: timestamp('last_handshake_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rounds = pgTable('rounds', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  serverSeed: text('server_seed').notNull(),
  serverSeedHash: text('server_seed_hash').notNull(),
  clientSeedComposite: text('client_seed_composite'),
  crashPoint: numeric('crash_point', { precision: 12, scale: 2 }),
  status: roundStatus('status').notNull().default('BETTING'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  flewAt: timestamp('flew_at', { withTimezone: true }),
  crashedAt: timestamp('crashed_at', { withTimezone: true }),
});

export const bets = pgTable('bets', {
  id: uuid('id').primaryKey(),
  roundId: bigint('round_id', { mode: 'number' }).notNull(),
  operatorCode: text('operator_code').notNull(),
  sessionToken: uuid('session_token').notNull(),
  panel: integer('panel').notNull(),
  stake: bigint('stake', { mode: 'bigint' }).notNull(),
  autoCashout: numeric('auto_cashout', { precision: 12, scale: 2 }),
  status: betStatus('status').notNull(),
  cashoutMultiplier: numeric('cashout_multiplier', { precision: 12, scale: 2 }),
  payout: bigint('payout', { mode: 'bigint' }),
  betTxnId: uuid('bet_txn_id').notNull(),
  winTxnId: uuid('win_txn_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, (table) => [
  unique('bets_round_session_panel').on(table.roundId, table.sessionToken, table.panel),
  index('bets_status_idx').on(table.status),
]);

export const walletOutbox = pgTable('wallet_outbox', {
  id: uuid('id').primaryKey(),
  operatorCode: text('operator_code').notNull(),
  type: outboxType('type').notNull(),
  txnId: uuid('txn_id').notNull(),
  sessionToken: uuid('session_token').notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  status: outboxStatus('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('outbox_dedupe').on(table.operatorCode, table.type, table.txnId),
  index('outbox_due_idx').on(table.status, table.nextAttemptAt),
]);

