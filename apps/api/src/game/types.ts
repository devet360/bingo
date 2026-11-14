export type BingoVariantName = 'US_75' | 'UK_90';

export type WinPatternName =
  | 'HORIZONTAL'
  | 'VERTICAL'
  | 'DIAGONAL'
  | 'FOUR_CORNERS'
  | 'FULL_HOUSE';

/** Stored in BingoCard.cells. null is a blank (UK) or the free centre (US). */
export interface CardGrid {
  variant: BingoVariantName;
  rows: number;
  cols: number;
  freeCenter: boolean;
  grid: Array<Array<number | null>>;
}

export const VARIANT_RULES = {
  US_75: {
    rows: 5,
    cols: 5,
    ballMax: 75,
    freeCenter: true,
    patterns: ['HORIZONTAL', 'VERTICAL', 'DIAGONAL', 'FOUR_CORNERS', 'FULL_HOUSE'],
    // Column index -> inclusive [min, max]
    columnRange: (col: number): [number, number] => [col * 15 + 1, col * 15 + 15],
  },
  UK_90: {
    rows: 3,
    cols: 9,
    ballMax: 90,
    freeCenter: false,
    patterns: ['HORIZONTAL', 'FULL_HOUSE'],
    columnRange: (col: number): [number, number] =>
      col === 0 ? [1, 9] : col === 8 ? [80, 90] : [col * 10, col * 10 + 9],
  },
} as const satisfies Record<
  BingoVariantName,
  {
    rows: number;
    cols: number;
    ballMax: number;
    freeCenter: boolean;
    patterns: readonly WinPatternName[];
    columnRange: (col: number) => [number, number];
  }
>;

export function isPatternSupported(
  variant: BingoVariantName,
  pattern: WinPatternName,
): boolean {
  return (VARIANT_RULES[variant].patterns as readonly WinPatternName[]).includes(pattern);
}

export function cardNumbers(card: CardGrid): number[] {
  const numbers: number[] = [];
  for (const row of card.grid) {
    for (const cell of row) if (cell !== null) numbers.push(cell);
  }
  return numbers;
}

export function parseCardCells(value: unknown): CardGrid {
  const candidate = value as Partial<CardGrid> | null;
  if (
    !candidate ||
    (candidate.variant !== 'US_75' && candidate.variant !== 'UK_90') ||
    !Array.isArray(candidate.grid)
  ) {
    throw new Error('Malformed card cells');
  }
  const rules = VARIANT_RULES[candidate.variant];
  if (candidate.grid.length !== rules.rows) throw new Error('Malformed card rows');
  for (const row of candidate.grid) {
    if (!Array.isArray(row) || row.length !== rules.cols) throw new Error('Malformed card row');
  }
  return {
    variant: candidate.variant,
    rows: rules.rows,
    cols: rules.cols,
    freeCenter: rules.freeCenter,
    grid: candidate.grid as Array<Array<number | null>>,
  };
}
