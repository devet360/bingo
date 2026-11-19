CREATE TYPE "public"."operator_status" AS ENUM('PENDING', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TABLE "operator_secrets" (
	"operator_code" text NOT NULL,
	"version" integer NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "operator_secrets_operator_code_version_pk" PRIMARY KEY("operator_code","version")
);
--> statement-breakpoint
ALTER TABLE "operator_secrets" ADD CONSTRAINT "operator_secrets_operator_code_operators_code_fk" FOREIGN KEY ("operator_code") REFERENCES "public"."operators"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "operator_secrets" ("operator_code", "version", "secret")
	SELECT "code", 1, "hmac_secret" FROM "operators" WHERE "hmac_secret" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "status" "operator_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "locale_default" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "min_stake" bigint DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "max_stake" bigint DEFAULT 100000 NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "max_win" bigint DEFAULT 3000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "max_bets_per_round" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "enabled_games" text[] DEFAULT '{crash}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "theme" jsonb;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "maintenance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "probe_ok_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "operators" SET "status" = CASE WHEN "enabled" THEN 'ACTIVE'::"public"."operator_status" ELSE 'SUSPENDED'::"public"."operator_status" END, "probe_ok_at" = now();--> statement-breakpoint
ALTER TABLE "operators" DROP COLUMN "hmac_secret";--> statement-breakpoint
ALTER TABLE "operators" DROP COLUMN "enabled";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "game_id" text DEFAULT 'crash' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "max_bets_per_round" integer DEFAULT 200 NOT NULL;
