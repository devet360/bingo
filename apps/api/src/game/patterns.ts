import {
  isPatternSupported,
  VARIANT_RULES,
  type BingoVariantName,
  type CardGrid,
  type WinPatternName,
} from './types';

export const PATTERN_PRIORITY: WinPatternName[] = [
  'FULL_HOUSE',
  'FOUR_CORNERS',
  'DIAGONAL',
  'VERTICAL',
  'HORIZONTAL',
];

function complete(cells: Array<number | null>, drawn: ReadonlySet<number>): boolean {
  let counted = 0;
  for (const cell of cells) {
    if (cell === null) continue;
    if (!drawn.has(cell)) return false;
    counted += 1;
  }
  return counted > 0;
}

export function isPatternComplete(
  card: CardGrid,
  drawn: Iterable<number>,
  pattern: WinPatternName,
): boolean {
  const drawnSet = drawn instanceof Set ? (drawn as ReadonlySet<number>) : new Set(drawn);
  const { grid, rows, cols, freeCenter } = card;

  switch (pattern) {
    case 'HORIZONTAL':
      return grid.some((row) => complete(row, drawnSet));

    case 'VERTICAL':
      for (let col = 0; col < cols; col += 1) {
        if (complete(grid.map((row) => row[col] ?? null), drawnSet)) return true;
      }
      return false;

    case 'DIAGONAL':
      if (rows !== cols) return false;
      return (
        complete(
          grid.map((row, index) => row[index] ?? null),
          drawnSet,
        ) ||
        complete(
          grid.map((row, index) => row[cols - 1 - index] ?? null),
          drawnSet,
        )
      );

    case 'FOUR_CORNERS': {
      if (rows < 2 || cols < 2) return false;
      const corners = [
        grid[0]![0],
        grid[0]![cols - 1],
        grid[rows - 1]![0],
        grid[rows - 1]![cols - 1],
      ];
      if (corners.some((cell) => cell === null)) return false;
      return complete(corners, drawnSet);
    }

    case 'FULL_HOUSE':
      return complete(grid.flat(), drawnSet);

    default:
      return false;
  }
}

/** Allowed, variant-supported patterns currently complete on this card. */
export function completedPatterns(
  card: CardGrid,
  drawn: Iterable<number>,
  allowed: readonly WinPatternName[],
): WinPatternName[] {
  const drawnSet = drawn instanceof Set ? (drawn as ReadonlySet<number>) : new Set(drawn);
  return allowed
    .filter((pattern) => isPatternSupported(card.variant, pattern))
    .filter((pattern) => isPatternComplete(card, drawnSet, pattern))
    .sort((a, b) => PATTERN_PRIORITY.indexOf(a) - PATTERN_PRIORITY.indexOf(b));
}

export type ClaimRejection =
  | 'PATTERN_NOT_SUPPORTED'
  | 'PATTERN_NOT_ALLOWED'
  | 'PATTERN_INCOMPLETE';

export interface ClaimVerdict {
  valid: boolean;
  reason?: ClaimRejection;
}

export function validateClaim(
  card: CardGrid,
  drawn: Iterable<number>,
  pattern: WinPatternName,
  allowed: readonly WinPatternName[],
): ClaimVerdict {
  if (!isPatternSupported(card.variant, pattern)) {
    return { valid: false, reason: 'PATTERN_NOT_SUPPORTED' };
  }
  if (!allowed.includes(pattern)) {
    return { valid: false, reason: 'PATTERN_NOT_ALLOWED' };
  }
  const drawnSet = drawn instanceof Set ? (drawn as ReadonlySet<number>) : new Set(drawn);
  if (!isPatternComplete(card, drawnSet, pattern)) {
    return { valid: false, reason: 'PATTERN_INCOMPLETE' };
  }
  return { valid: true };
}

export function allowedPatternsFor(variant: BingoVariantName): WinPatternName[] {
  return [...VARIANT_RULES[variant].patterns];
}
