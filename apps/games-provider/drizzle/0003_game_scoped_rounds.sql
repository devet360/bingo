ALTER TABLE "rounds" ADD COLUMN "operator_code" text;
--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "game_id" text DEFAULT 'crash' NOT NULL;
--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "coin_outcome" text;
