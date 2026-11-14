import { WinPattern, type BingoVariant } from '@prisma/client';
import { prisma } from '../src/lib/prisma';

const CREDITS = 100n;

interface RoomSeed {
  code: string;
  name: string;
  variant: BingoVariant;
  stakeCredits: number;
  patterns: WinPattern[];
}

const ROOMS: RoomSeed[] = [
  {
    code: 'us75-10',
    name: 'US 75 · 10 credits',
    variant: 'US_75',
    stakeCredits: 10,
    patterns: ['HORIZONTAL', 'VERTICAL', 'DIAGONAL', 'FOUR_CORNERS', 'FULL_HOUSE'],
  },
  {
    code: 'us75-50',
    name: 'US 75 · 50 credits',
    variant: 'US_75',
    stakeCredits: 50,
    patterns: ['HORIZONTAL', 'VERTICAL', 'DIAGONAL', 'FOUR_CORNERS', 'FULL_HOUSE'],
  },
  {
    code: 'us75-100',
    name: 'US 75 · 100 credits',
    variant: 'US_75',
    stakeCredits: 100,
    patterns: ['HORIZONTAL', 'VERTICAL', 'DIAGONAL', 'FOUR_CORNERS', 'FULL_HOUSE'],
  },
  {
    code: 'us75-500',
    name: 'US 75 · 500 credits',
    variant: 'US_75',
    stakeCredits: 500,
    patterns: ['HORIZONTAL', 'VERTICAL', 'DIAGONAL', 'FOUR_CORNERS', 'FULL_HOUSE'],
  },
  {
    code: 'uk90-10',
    name: 'UK 90 · 10 credits',
    variant: 'UK_90',
    stakeCredits: 10,
    patterns: ['HORIZONTAL', 'FULL_HOUSE'],
  },
  {
    code: 'uk90-50',
    name: 'UK 90 · 50 credits',
    variant: 'UK_90',
    stakeCredits: 50,
    patterns: ['HORIZONTAL', 'FULL_HOUSE'],
  },
  {
    code: 'uk90-100',
    name: 'UK 90 · 100 credits',
    variant: 'UK_90',
    stakeCredits: 100,
    patterns: ['HORIZONTAL', 'FULL_HOUSE'],
  },
  {
    code: 'uk90-500',
    name: 'UK 90 · 500 credits',
    variant: 'UK_90',
    stakeCredits: 500,
    patterns: ['HORIZONTAL', 'FULL_HOUSE'],
  },
];

async function main(): Promise<void> {
  for (const seed of ROOMS) {
    await prisma.bingoRoom.upsert({
      where: { code: seed.code },
      create: {
        code: seed.code,
        name: seed.name,
        variant: seed.variant,
        stakePerCard: BigInt(seed.stakeCredits) * CREDITS,
        allowedPatterns: seed.patterns,
        rakeBps: 1_000,
        minPlayersToStart: 1,
        maxCardsPerPlayer: 4,
        purchaseWindowSecs: 20,
        lockWindowSecs: 5,
        drawIntervalMs: 3_500,
        claimWindowSecs: 20,
      },
      update: {
        name: seed.name,
        variant: seed.variant,
        stakePerCard: BigInt(seed.stakeCredits) * CREDITS,
        allowedPatterns: seed.patterns,
        minPlayersToStart: 1,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`Seeded ${ROOMS.length} bingo rooms.`);
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
