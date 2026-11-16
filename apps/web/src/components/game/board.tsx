'use client';

import { cn } from '@/components/ui';
import type { Card, WinPattern } from '@/lib/types';

const LETTERS = ['B', 'I', 'N', 'G', 'O'] as const;

/** One colour family per board column, with a themed solid fill when daubed. */
const COLUMN_ACCENTS = [
  { text: 'text-blue', tint: 'bg-blue/15', ring: 'ring-blue/60', border: 'border-blue/70', fill: 'cell-b' },
  { text: 'text-mint', tint: 'bg-mint/15', ring: 'ring-mint/60', border: 'border-mint/70', fill: 'cell-i' },
  { text: 'text-gold', tint: 'bg-gold/15', ring: 'ring-gold/60', border: 'border-gold/70', fill: 'cell-n' },
  { text: 'text-rose', tint: 'bg-rose/15', ring: 'ring-rose/60', border: 'border-rose/70', fill: 'cell-g' },
  { text: 'text-violet', tint: 'bg-violet/15', ring: 'ring-violet/60', border: 'border-violet/70', fill: 'cell-o' },
] as const;

function columnAccent(c: number) {
  return COLUMN_ACCENTS[c % COLUMN_ACCENTS.length]!;
}

function winningCells(
  card: Card,
  pattern: WinPattern | null,
  isMarked: (r: number, c: number) => boolean,
): Set<string> {
  const cells = new Set<string>();
  if (!pattern) return cells;
  const { rows, cols } = card.cells;
  const add = (r: number, c: number) => cells.add(`${r}:${c}`);

  if (pattern === 'FULL_HOUSE') {
    for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) add(r, c);
    return cells;
  }
  if (pattern === 'FOUR_CORNERS') {
    add(0, 0);
    add(0, cols - 1);
    add(rows - 1, 0);
    add(rows - 1, cols - 1);
    return cells;
  }
  if (pattern === 'HORIZONTAL') {
    for (let r = 0; r < rows; r += 1) {
      if (Array.from({ length: cols }, (_, c) => isMarked(r, c)).every(Boolean)) {
        for (let c = 0; c < cols; c += 1) add(r, c);
        return cells;
      }
    }
  }
  if (pattern === 'VERTICAL') {
    for (let c = 0; c < cols; c += 1) {
      if (Array.from({ length: rows }, (_, r) => isMarked(r, c)).every(Boolean)) {
        for (let r = 0; r < rows; r += 1) add(r, c);
        return cells;
      }
    }
  }
  if (pattern === 'DIAGONAL' && rows === cols) {
    const main = Array.from({ length: rows }, (_, i) => isMarked(i, i)).every(Boolean);
    if (main) {
      for (let i = 0; i < rows; i += 1) add(i, i);
      return cells;
    }
    for (let i = 0; i < rows; i += 1) add(i, cols - 1 - i);
  }
  return cells;
}

/**
 * US 75-ball cards are 5×5 with a free centre. UK 90-ball tickets are 3×9
 * with 12 numbers and four blanks per row.
 *
 * Pass `daubed` to switch the board to manual marking: cells only show as
 * marked once the player tapped them, even when the number was called.
 */
export function CardBoard({
  card,
  drawnBalls,
  currentBall,
  compact = false,
  className,
  daubed,
  onToggle,
}: {
  card: Card;
  drawnBalls: readonly number[];
  currentBall?: number | null;
  compact?: boolean;
  className?: string;
  daubed?: readonly number[];
  onToggle?: (value: number) => void;
}) {
  const called = new Set(drawnBalls);
  const markedSet = new Set(daubed ?? drawnBalls);
  const isMarked = (r: number, c: number) => {
    const value = card.cells.grid[r]?.[c] ?? null;
    if (value === null) return card.cells.freeCenter && r === 2 && c === 2;
    return markedSet.has(value);
  };
  const win = winningCells(card, card.wonPattern, isMarked);
  const isUs = card.variant === 'US_75';

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-line bg-ink/60',
        card.status === 'WON' && 'border-gold/60 shadow-glow',
        card.status === 'REFUNDED' && 'opacity-60',
        card.status === 'BLOCKED' && 'border-danger/50 opacity-70',
        className,
      )}
    >
      {isUs ? (
        <div className="grid grid-cols-5 border-b border-line/70 bg-raised/60">
          {LETTERS.map((letter, index) => (
            <span
              key={letter}
              className={cn(
                'border-b-2 py-1 text-center text-[10px] font-black tracking-widest',
                columnAccent(index).text,
                columnAccent(index).border,
              )}
            >
              {letter}
            </span>
          ))}
        </div>
      ) : null}
      <div
        className={cn('grid gap-[3px] p-[3px]', isUs ? 'grid-cols-5' : 'grid-cols-9')}
        style={{ gridTemplateRows: `repeat(${card.cells.rows}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: card.cells.rows }, (_, r) =>
          Array.from({ length: card.cells.cols }, (_, c) => {
            const value = card.cells.grid[r]?.[c] ?? null;
            const free = value === null && card.cells.freeCenter && r === 2 && c === 2;
            const marked = isMarked(r, c);
            const inWin = win.has(`${r}:${c}`) && marked;
            const isCurrent = value !== null && value === currentBall && marked;
            const waitingTap = value !== null && called.has(value) && !marked;
            const accent = columnAccent(c);
            return (
              <button
                key={`${r}:${c}`}
                type="button"
                disabled={!onToggle || value === null}
                onClick={() => value !== null && onToggle?.(value)}
                className={cn(
                  'flex min-w-0 items-center justify-center rounded-md font-display font-semibold tabular-nums transition',
                  compact
                    ? 'h-6 text-[11px]'
                    : card.cells.cols > 5
                      ? 'aspect-square text-[9px] sm:text-[10px]'
                      : 'aspect-square text-[13px] sm:text-sm',
                  value === null && !free && 'bg-transparent',
                  value === null && free && 'bg-gold/25 text-[8px] font-black text-gold',
                  value !== null && !marked && !waitingTap && cn('bg-raised/80', accent.text),
                  waitingTap && cn('font-bold ring-2 ring-inset', accent.tint, accent.text, accent.ring),
                  marked && cn(accent.fill, 'font-black shadow-sm'),
                  inWin && 'cell-win',
                  isCurrent && 'ring-2 ring-text',
                )}
              >
                {free ? 'FREE' : value ?? ''}
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
