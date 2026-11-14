-- A round should start with a single seated player. The previous default of 2
-- left solo players waiting (or refunded) while no balls were ever drawn.
ALTER TABLE "BingoRoom" ALTER COLUMN "minPlayersToStart" SET DEFAULT 1;
UPDATE "BingoRoom" SET "minPlayersToStart" = 1 WHERE "minPlayersToStart" > 1;
