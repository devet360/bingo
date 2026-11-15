-- Enum values are added in their own migration: PostgreSQL cannot use a new
-- enum value in the same transaction that created it.

CREATE TYPE "RoomMode" AS ENUM ('MAIN', 'FAST');
CREATE TYPE "ClaimPhase" AS ENUM ('MAIN', 'RUNNER_UP');

ALTER TYPE "RoundStatus" ADD VALUE IF NOT EXISTS 'RUNNER_UP';
ALTER TYPE "CardStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "CardStatus" ADD VALUE IF NOT EXISTS 'BLOCKED';
