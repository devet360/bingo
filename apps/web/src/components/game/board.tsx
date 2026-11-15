'use client';

import { cn } from '@/components/ui';
import type { Card, WinPattern } from '@/lib/types';

const LETTERS = ['B', 'I', 'N', 'G', 'O'] as const;

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
          {LETTERS.map((letter) => (
            <span
              key={letter}
              className="py-1 text-center text-[10px] font-black tracking-widest text-gold"
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
            return (
              <button
                key={`${r}:${c}`}
                type="button"
                disabled={!onToggle || value === null}
                onClick={() => value !== null && onToggle?.(value)}
                className={cn(
                  'flex items-center justify-center rounded-md font-display font-semibold tabular-nums transition',
                  compact ? 'h-6 text-[11px]' : 'aspect-square text-sm',
                  value === null && !free && 'bg-transparent',
                  value === null && free && 'bg-gold/20 text-[9px] font-black text-gold',
                  value !== null && !marked && 'bg-raised/80 text-text/80',
                  waitingTap && 'text-mint ring-1 ring-inset ring-mint/50',
                  marked && 'bg-mint text-[#04120c]',
                  isCurrent && 'ring-2 ring-gold',
                  inWin && 'bg-gold text-[#1a1204]',
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
