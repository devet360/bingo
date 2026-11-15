import { Prisma, WinPattern, type BingoVariant, type RoomMode } from '@prisma/client';
import { prisma } from '../src/lib/prisma';

const CREDITS = 100n; // one credit is 1 ETB = 100 minor units

interface RoomSeed {
  code: string;
  name: string;
  variant: BingoVariant;
  mode: RoomMode;
  stakeCredits: number;
  patterns: WinPattern[];
  maxCardsPerPlayer: number;
  minPlayersToStart: number;
  rakeBps: number;
  purchaseWindowSecs: number;
  lockWindowSecs: number;
  drawIntervalMs: number;
  claimWindowSecs: number;
  pressWindowSecs: number;
  autoDaubEnabled: boolean;
  allowAutoBingoPress: boolean;
  fixedPrizeCredits?: number;
  runnerUpEnabled: boolean;
  runnerUpPrizeCredits?: number;
  runnerUpWindowSecs: number;
  bonusTiers: Array<{ minCards: number; bonusCards: number }>;
}

// MAIN rooms mirror the long 75-ball game players know from bingo1020: a big
// advertised prize, ~16s between balls, manual marking and a runner-up race for
// the last drawn number. FAST rooms keep the quick auto-daub cycle.
const ROOMS: RoomSeed[] = [
  {
    code: 'main-5line',
    name: 'Bingo 5 Line · 10 ETB',
    variant: 'US_75',
    mode: 'MAIN',
    stakeCredits: 10,
    patterns: ['HORIZONTAL', 'VERTICAL', 'DIAGONAL'],
    maxCardsPerPlayer: 30,
    minPlayersToStart: 2,
    rakeBps: 0,
    purchaseWindowSecs: 60,
    lockWindowSecs: 10,
    drawIntervalMs: 16_000,
    claimWindowSecs: 60,
    pressWindowSecs: 60,
    autoDaubEnabled: true,
    allowAutoBingoPress: false,
    fixedPrizeCredits: 25_000,
    runnerUpEnabled: true,
    runnerUpPrizeCredits: 5_000,
    runnerUpWindowSecs: 60,
    bonusTiers: [
      { minCards: 5, bonusCards: 1 },
      { minCards: 10, bonusCards: 3 },
    ],
  },
  {
    code: 'main-fullhouse',
    name: 'Bingo Full House · 30 ETB',
    variant: 'US_75',
    mode: 'MAIN',
    stakeCredits: 30,
    patterns: ['FULL_HOUSE'],
    maxCardsPerPlayer: 30,
    minPlayersToStart: 2,
    rakeBps: 0,
    purchaseWindowSecs: 60,
    lockWindowSecs: 10,
    drawIntervalMs: 16_000,
    claimWindowSecs: 60,
    pressWindowSecs: 60,
    autoDaubEnabled: true,
    allowAutoBingoPress: false,
    fixedPrizeCredits: 110_000,
    runnerUpEnabled: true,
    runnerUpPrizeCredits: 15_000,
    runnerUpWindowSecs: 60,
    bonusTiers: [
      { minCards: 5, bonusCards: 1 },
      { minCards: 10, bonusCards: 3 },
    ],
  },
  {
    code: 'fast-10',
    name: 'Fast Bingo · 10 ETB',
    variant: 'US_75',
    mode: 'FAST',
    stakeCredits: 10,
    patterns: ['HORIZONTAL', 'VERTICAL', 'DIAGONAL', 'FOUR_CORNERS', 'FULL_HOUSE'],
    maxCardsPerPlayer: 1,
    minPlayersToStart: 1,
    rakeBps: 2_000,
    purchaseWindowSecs: 40,
    lockWindowSecs: 5,
    drawIntervalMs: 4_000,
    claimWindowSecs: 10,
    pressWindowSecs: 10,
    autoDaubEnabled: true,
    allowAutoBingoPress: false,
    runnerUpEnabled: false,
    runnerUpWindowSecs: 60,
    bonusTiers: [],
  },
  {
    code: 'fast-50',
    name: 'Fast Bingo · 50 ETB',
    variant: 'US_75',
    mode: 'FAST',
    stakeCredits: 50,
    patterns: ['HORIZONTAL', 'VERTICAL', 'DIAGONAL', 'FOUR_CORNERS', 'FULL_HOUSE'],
    maxCardsPerPlayer: 1,
    minPlayersToStart: 1,
    rakeBps: 2_000,
    purchaseWindowSecs: 40,
    lockWindowSecs: 5,
    drawIntervalMs: 4_000,
    claimWindowSecs: 10,
    pressWindowSecs: 10,
    autoDaubEnabled: true,
    allowAutoBingoPress: false,
    runnerUpEnabled: false,
    runnerUpWindowSecs: 60,
    bonusTiers: [],
  },
];

/** Retired credit-denominated rooms; closed so the lobby stops listing them. */
const LEGACY_CODES = [
  'us75-10',
  'us75-50',
  'us75-100',
  'us75-500',
  'uk90-10',
  'uk90-50',
  'uk90-100',
  'uk90-500',
];

async function main(): Promise<void> {
  for (const seed of ROOMS) {
    const shared = {
      name: seed.name,
      variant: seed.variant,
      mode: seed.mode,
      stakePerCard: BigInt(seed.stakeCredits) * CREDITS,
      allowedPatterns: seed.patterns,
      maxCardsPerPlayer: seed.maxCardsPerPlayer,
      minPlayersToStart: seed.minPlayersToStart,
      rakeBps: seed.rakeBps,
      purchaseWindowSecs: seed.purchaseWindowSecs,
      lockWindowSecs: seed.lockWindowSecs,
      drawIntervalMs: seed.drawIntervalMs,
      claimWindowSecs: seed.claimWindowSecs,
      pressWindowSecs: seed.pressWindowSecs,
      autoDaubEnabled: seed.autoDaubEnabled,
      allowAutoBingoPress: seed.allowAutoBingoPress,
      fixedPrize:
        seed.fixedPrizeCredits === undefined ? null : BigInt(seed.fixedPrizeCredits) * CREDITS,
      runnerUpEnabled: seed.runnerUpEnabled,
      runnerUpPrize:
        seed.runnerUpPrizeCredits === undefined
          ? null
          : BigInt(seed.runnerUpPrizeCredits) * CREDITS,
      runnerUpWindowSecs: seed.runnerUpWindowSecs,
      bonusTiers: seed.bonusTiers as Prisma.InputJsonValue,
    };
    await prisma.bingoRoom.upsert({
      where: { code: seed.code },
      create: { code: seed.code, ...shared },
      update: shared,
    });
  }

  const retired = await prisma.bingoRoom.updateMany({
    where: { code: { in: LEGACY_CODES } },
    data: { status: 'CLOSED' },
  });

  // eslint-disable-next-line no-console
  console.log(
    `Seeded ${ROOMS.length} bingo rooms (${retired.count} legacy room(s) closed).`,
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
