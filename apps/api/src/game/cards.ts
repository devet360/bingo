import { randomInt } from 'node:crypto';
import { VARIANT_RULES, type BingoVariantName, type CardGrid } from './types';

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    const swap = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = swap;
  }
  return copy;
}

function pickDistinct(min: number, max: number, count: number): number[] {
  const pool = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  return shuffled(pool)
    .slice(0, count)
    .sort((a, b) => a - b);
}

export function generateCard(variant: BingoVariantName): CardGrid {
  return variant === 'US_75' ? generateUs75Card() : generateUk90Card();
}

/** 5x5, columns B/I/N/G/O, one number per cell, free centre. */
export function generateUs75Card(): CardGrid {
  const rules = VARIANT_RULES.US_75;
  const columns = Array.from({ length: rules.cols }, (_, col) => {
    const [min, max] = rules.columnRange(col);
    return pickDistinct(min, max, rules.rows);
  });

  const grid: Array<Array<number | null>> = Array.from({ length: rules.rows }, () =>
    Array.from({ length: rules.cols }, () => null),
  );
  for (let col = 0; col < rules.cols; col += 1) {
    for (let row = 0; row < rules.rows; row += 1) {
      grid[row]![col] = columns[col]![row]!;
    }
  }
  grid[2]![2] = null; // free space

  return {
    variant: 'US_75',
    rows: rules.rows,
    cols: rules.cols,
    freeCenter: true,
    grid,
  };
}

/**
 * 3x9 ticket: 15 numbers, five per row, one to three per column, ascending
 * within a column. Column ranges follow the 90-ball convention (1-9, 10-19,
 * ..., 80-90).
 */
export function generateUk90Card(): CardGrid {
  const rules = VARIANT_RULES.UK_90;
  const counts = ukColumnCounts();

  let rowAssignments: number[][] | null = null;
  for (let attempt = 0; attempt < 50 && !rowAssignments; attempt += 1) {
    rowAssignments = assignRows(counts, rules.rows, 5);
  }
  if (!rowAssignments) throw new Error('Failed to lay out the 90-ball ticket');

  const grid: Array<Array<number | null>> = Array.from({ length: rules.rows }, () =>
    Array.from({ length: rules.cols }, () => null),
  );

  for (let col = 0; col < rules.cols; col += 1) {
    const [min, max] = rules.columnRange(col);
    const numbers = pickDistinct(min, max, counts[col]!);
    const rows = [...rowAssignments[col]!].sort((a, b) => a - b);
    rows.forEach((row, index) => {
      grid[row]![col] = numbers[index]!;
    });
  }

  return {
    variant: 'UK_90',
    rows: rules.rows,
    cols: rules.cols,
    freeCenter: false,
    grid,
  };
}

/** Nine column counts in [1,3] summing to 15. */
function ukColumnCounts(): number[] {
  const counts = Array.from({ length: 9 }, () => 1);
  let remaining = 15 - counts.reduce((sum, count) => sum + count, 0);
  while (remaining > 0) {
    const col = randomInt(0, 9);
    if (counts[col]! < 3) {
      counts[col]! += 1;
      remaining -= 1;
    }
  }
  return counts;
}

/** Each column's slots must land in distinct rows and every row must total 5. */
function assignRows(counts: number[], rows: number, perRow: number): number[][] | null {
  const capacity = Array.from({ length: rows }, () => perRow);
  const assignments: number[][] = Array.from({ length: counts.length }, () => []);

  const order = counts
    .map((count, col) => ({ col, count }))
    .sort((a, b) => b.count - a.count);

  const place = (index: number): boolean => {
    if (index === order.length) return capacity.every((left) => left === 0);
    const { col, count } = order[index]!;
    const candidates = shuffled(Array.from({ length: rows }, (_, row) => row)).filter(
      (row) => capacity[row]! > 0,
    );

    const choose = (chosen: number[], from: number): boolean => {
      if (chosen.length === count) {
        for (const row of chosen) capacity[row]! -= 1;
        assignments[col] = chosen;
        if (place(index + 1)) return true;
        for (const row of chosen) capacity[row]! += 1;
        assignments[col] = [];
        return false;
      }
      for (let i = from; i < candidates.length; i += 1) {
        const row = candidates[i]!;
        if (chosen.includes(row)) continue;
        if (choose([...chosen, row], i + 1)) return true;
      }
      return false;
    };

    return choose([], 0);
  };

  return place(0) ? assignments : null;
}

export function isColumnAscending(card: CardGrid): boolean {
  for (let col = 0; col < card.cols; col += 1) {
    let previous = 0;
    for (let row = 0; row < card.rows; row += 1) {
      const value = card.grid[row]![col];
      if (value === null) continue;
      if (value <= previous) return false;
      previous = value;
    }
  }
  return true;
}
