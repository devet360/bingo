import type { Card, Round, RoundStatus, WinPattern } from './types';

export const PATTERN_PRIORITY: WinPattern[] = [
  'FULL_HOUSE',
  'FOUR_CORNERS',
  'DIAGONAL',
  'VERTICAL',
  'HORIZONTAL',
];

export const ROUND_STATUS_LABEL: Record<RoundStatus, string> = {
  WAITING: 'Selling cards',
  LOCKED: 'Starting',
  PLAYING: 'Live',
  CLAIM_VERIFICATION: 'Claim window',
  COMPLETED: 'Finished',
  CANCELLED: 'Cancelled',
};

export const CARD_STATUS_LABEL: Record<Card['status'], string> = {
  ACTIVE: 'In play',
  WON: 'Winner',
  LOST: 'No win',
  REFUNDED: 'Refunded',
};

/** Mirrors the server's daub rule: null is free centre (US) or a blank (UK). */
export function isCellMarked(
  card: Card,
  row: number,
  col: number,
  marked: ReadonlySet<number>,
): boolean {
  const value = card.cells.grid[row]?.[col] ?? null;
  if (value === null) return card.cells.freeCenter && row === 2 && col === 2;
  return marked.has(value);
}

export function completedPatterns(card: Card, drawnBalls: readonly number[]): WinPattern[] {
  const drawn = new Set(drawnBalls);
  const { rows, cols } = card.cells;
  const marked = (r: number, c: number) => isCellMarked(card, r, c, drawn);
  const patterns: WinPattern[] = [];

  const all = (cells: Array<[number, number]>) => cells.every(([r, c]) => marked(r, c));

  if (Array.from({ length: rows }, (_, r) => all(Array.from({ length: cols }, (_, c) => [r, c] as [number, number]))).some(Boolean)) {
    patterns.push('HORIZONTAL');
  }
  if (Array.from({ length: cols }, (_, c) => all(Array.from({ length: rows }, (_, r) => [r, c] as [number, number]))).some(Boolean)) {
    patterns.push('VERTICAL');
  }
  if (rows === cols) {
    const main = Array.from({ length: rows }, (_, i) => [i, i] as [number, number]);
    const anti = Array.from({ length: rows }, (_, i) => [i, cols - 1 - i] as [number, number]);
    if (all(main) || all(anti)) patterns.push('DIAGONAL');
  }
  if (rows > 1 && cols > 1) {
    const corners: Array<[number, number]> = [
      [0, 0],
      [0, cols - 1],
      [rows - 1, 0],
      [rows - 1, cols - 1],
    ];
    if (all(corners)) patterns.push('FOUR_CORNERS');
  }
  let everyCell = true;
  for (let r = 0; r < rows && everyCell; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const value = card.cells.grid[r]?.[c] ?? null;
      if (value === null && !(card.cells.freeCenter && r === 2 && c === 2)) continue;
      if (!marked(r, c)) {
        everyCell = false;
        break;
      }
    }
  }
  if (everyCell) patterns.push('FULL_HOUSE');

  return patterns.sort((a, b) => PATTERN_PRIORITY.indexOf(a) - PATTERN_PRIORITY.indexOf(b));
}

export function claimablePatterns(card: Card, round: Round): WinPattern[] {
  const completed = completedPatterns(card, round.drawnBalls);
  return completed.filter((pattern) => round.allowedPatterns.includes(pattern));
}

/**
 * The countdown that matters for the current phase, if any. While balls are
 * drawing there is deliberately no countdown: the server draws on
 * `lastDrawAt + interval`, and a client-side clock drifts away from the live
 * draw, so the room shows the ball itself instead.
 */
export function phaseDeadline(
  round: Round | null,
  options: { lockWindowSecs?: number } = {},
): { label: string; at: string } | null {
  if (!round) return null;
  switch (round.status) {
    case 'WAITING':
      return round.purchaseClosesAt ? { label: 'Sales close', at: round.purchaseClosesAt } : null;
    case 'LOCKED':
      return round.startedAt
        ? {
            label: 'First ball',
            at: new Date(
              new Date(round.startedAt).getTime() + (options.lockWindowSecs ?? 5) * 1_000,
            ).toISOString(),
          }
        : null;
    case 'CLAIM_VERIFICATION':
      return round.claimsCloseAt ? { label: 'Claims close', at: round.claimsCloseAt } : null;
    case 'PLAYING':
      return null;
    default:
      return null;
  }
}

export function ballTone(ball: number): string {
  if (ball <= 15) return 'bg-[#2b6cb0]';
  if (ball <= 30) return 'bg-[#2f855a]';
  if (ball <= 45) return 'bg-[#b7791f]';
  if (ball <= 60) return 'bg-[#9b2c2c]';
  return 'bg-[#553c9a]';
}
