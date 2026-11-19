ALTER TABLE "operators" ADD COLUMN IF NOT EXISTS "bot_config" jsonb;
--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN IF NOT EXISTS "operator_code" text;
--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN IF NOT EXISTS "game_id" text DEFAULT 'crash' NOT NULL;
--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN IF NOT EXISTS "coin_outcome" text;
