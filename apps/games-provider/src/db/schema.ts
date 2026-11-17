import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const roundStatus = pgEnum('round_status', ['BETTING', 'FLYING', 'CRASHED', 'ABANDONED']);
export const betStatus = pgEnum('bet_status', ['PLACING', 'ACTIVE', 'CASHED', 'LOST', 'CANCELLED', 'REJECTED', 'UNRESOLVED']);
export const outboxType = pgEnum('outbox_type', ['WIN', 'ROLLBACK']);
export const outboxStatus = pgEnum('outbox_status', ['PENDING', 'SENT', 'CAP_REJECTED', 'DEAD']);

export const operators = pgTable('operators', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  callbackUrl: text('callback_url').notNull(),
  hmacSecret: text('hmac_secret').notNull(),
  currency: text('currency').notNull(),
  enabled: boolean('enabled').notNull().default(true),
});

export const sessions = pgTable('sessions', {
  token: uuid('token').primaryKey(),
  operatorCode: text('operator_code').notNull(),
  currency: text('currency').notNull(),
  minStake: bigint('min_stake', { mode: 'bigint' }).notNull(),
  maxStake: bigint('max_stake', { mode: 'bigint' }).notNull(),
  maxWin: bigint('max_win', { mode: 'bigint' }).notNull(),
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

