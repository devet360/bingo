CREATE TYPE "public"."bet_status" AS ENUM('PLACING', 'ACTIVE', 'CASHED', 'LOST', 'CANCELLED', 'REJECTED', 'UNRESOLVED');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'SENT', 'CAP_REJECTED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."outbox_type" AS ENUM('WIN', 'ROLLBACK');--> statement-breakpoint
CREATE TYPE "public"."round_status" AS ENUM('BETTING', 'FLYING', 'CRASHED', 'ABANDONED');--> statement-breakpoint
CREATE TABLE "bets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"round_id" bigint NOT NULL,
	"operator_code" text NOT NULL,
	"session_token" uuid NOT NULL,
	"panel" integer NOT NULL,
	"stake" bigint NOT NULL,
	"auto_cashout" numeric(12, 2),
	"status" "bet_status" NOT NULL,
	"cashout_multiplier" numeric(12, 2),
	"payout" bigint,
	"bet_txn_id" uuid NOT NULL,
	"win_txn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "bets_round_session_panel" UNIQUE("round_id","session_token","panel")
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"callback_url" text NOT NULL,
	"hmac_secret" text NOT NULL,
	"currency" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_seed" text NOT NULL,
	"server_seed_hash" text NOT NULL,
	"client_seed_composite" text,
	"crash_point" numeric(12, 2),
	"status" "round_status" DEFAULT 'BETTING' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"flew_at" timestamp with time zone,
	"crashed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" uuid PRIMARY KEY NOT NULL,
	"operator_code" text NOT NULL,
	"currency" text NOT NULL,
	"min_stake" bigint NOT NULL,
	"max_stake" bigint NOT NULL,
	"max_win" bigint NOT NULL,
	"display_balance" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_handshake_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"session_token" uuid,
	"txn_id" text,
	"http_status" integer,
	"latency_ms" integer,
	"request_hash" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_code" text NOT NULL,
	"type" "outbox_type" NOT NULL,
	"txn_id" uuid NOT NULL,
	"session_token" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_dedupe" UNIQUE("operator_code","type","txn_id")
);
--> statement-breakpoint
CREATE INDEX "bets_status_idx" ON "bets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "wallet_outbox" USING btree ("status","next_attempt_at");