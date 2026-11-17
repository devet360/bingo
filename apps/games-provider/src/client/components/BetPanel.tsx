import React, { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { t } from '../i18n';
import type { BetFrame, BetLimits, BetStatus, GamePhase, Lang } from '../types';

interface BetPanelProps {
  panel: 0 | 1;
  phase: GamePhase;
  multiplier: number;
  currency: string;
  balanceMinor: bigint;
  limits: BetLimits;
  bet: BetFrame | null;
  lang: Lang;
  onPlace: (panel: 0 | 1, stakeMinor: bigint, autoCashout: number | null) => void;
  onCancel: (panel: 0 | 1) => void;
  onCashout: (panel: 0 | 1) => void;
}

const PRESETS_MAJOR = [1, 5, 25, 100];

// Money is integer minor units: no float math anywhere on the way out.
export const money = (minor: bigint, currency: string) => {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const major = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${major}.${cents} ${currency}`;
};

// Parse a major-unit decimal string (at most 2 fraction digits) into minor
// units without going through a float.
const parseStakeMinor = (input: string): bigint => {
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(input.trim());
  if (!match) return 0n;
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return BigInt(match[1]) * 100n + BigInt(fraction);
};

const TERMINAL_STATUSES: readonly BetStatus[] = ['LOST', 'CANCELLED', 'REJECTED', 'UNRESOLVED'];

const terminalLabel = (lang: Lang, status: BetStatus): string | null => {
  switch (status) {
    case 'LOST': return t(lang, 'lost');
    case 'CANCELLED': return t(lang, 'cancelled');
    case 'REJECTED': return t(lang, 'rejected');
    case 'UNRESOLVED': return t(lang, 'unresolved');
    default: return null;
  }
};

export const BetPanel: React.FC<BetPanelProps> = ({
  panel, phase, multiplier, currency, balanceMinor, limits, bet, lang, onPlace, onCancel, onCashout,
}) => {
  const [stakeMajor, setStakeMajor] = useState('10');
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoValue, setAutoValue] = useState('2.00');

  const stakeMinor = parseStakeMinor(stakeMajor);
  const active = bet !== null && (bet.status === 'ACTIVE' || bet.status === 'PLACING');
  const cashed = bet?.status === 'CASHED';
  const finishedLabel = bet !== null && TERMINAL_STATUSES.includes(bet.status)
    ? terminalLabel(lang, bet.status)
    : null;
  const autoCashout = (() => {
    if (!autoEnabled) return null;
    const value = Number.parseFloat(autoValue);
    return Number.isFinite(value) && value >= 1.01 ? Number(value.toFixed(2)) : null;
  })();
  const outOfBounds = stakeMinor < limits.minStake || stakeMinor > limits.maxStake;
  const unaffordable = stakeMinor > balanceMinor;

  const adjust = (delta: number) => {
    // Hundredth steps in integer minor units: never reparse the display as a float.
    const stepped = parseStakeMinor(stakeMajor) + BigInt(delta) * 100n;
    const next = stepped < 100n ? 100n : stepped;
    setStakeMajor(`${next / 100n}.${(next % 100n).toString().padStart(2, '0')}`);
  };

  const renderPrimary = () => {
    const base =
      'w-full h-full min-h-[56px] px-3 rounded-xl font-display font-bold flex flex-col items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50';
    if (active && phase === 'FLYING' && bet) {
      const estimate = BigInt(bet.stake) * BigInt(Math.round(multiplier * 100)) / 100n;
      return (
        <button type="button" onClick={() => onCashout(panel)}
          className={`${base} bg-[var(--g-gold)] text-slate-950`}>
          <span className="text-sm uppercase tracking-wide">{t(lang, 'cashOut')}</span>
          <span className="text-base font-mono tabular-nums">{money(estimate, currency)}</span>
        </button>
      );
    }
    if (active) {
      return (
        <button type="button" onClick={() => onCancel(panel)}
          className={`${base} bg-[var(--g-danger)] text-white`}>
          <span className="text-base">{t(lang, 'cancel')}</span>
          {bet && <span className="text-xs font-mono tabular-nums">{money(BigInt(bet.stake), currency)}</span>}
        </button>
      );
    }
    if (cashed && bet) {
      return (
        <button type="button" disabled className={`${base} bg-emerald-900/60 text-emerald-200`}>
          <span className="text-xs uppercase">{t(lang, 'won')}</span>
          <span className="text-base font-mono tabular-nums">+{money(BigInt(bet.payout ?? '0'), currency)}</span>
        </button>
      );
    }
    if (finishedLabel) {
      const lost = bet?.status === 'LOST';
      return (
        <button type="button" disabled
          className={`${base} ${lost ? 'bg-slate-800 text-slate-400' : 'bg-slate-700/60 text-slate-200'}`}>
          <span className="text-sm text-center leading-tight">{finishedLabel}</span>
        </button>
      );
    }
    if (phase !== 'BETTING') {
      return (
        <button type="button" disabled className={`${base} bg-slate-800 text-slate-400`}>
          {t(lang, 'waitingForNextRound')}
        </button>
      );
    }
    return (
      <button type="button" onClick={() => onPlace(panel, stakeMinor, autoCashout)}
        disabled={outOfBounds || unaffordable}
        className={`${base} bg-[var(--g-accent)] text-[var(--g-on-accent)]`}>
        <span className="text-base">{t(lang, 'bet')}</span>
        <span className="text-sm font-mono tabular-nums">{money(stakeMinor, currency)}</span>
      </button>
    );
  };

  return (
    <div className="bg-[var(--g-panel)] border border-white/10 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => adjust(-1)} aria-label={t(lang, 'decreaseStake')}
          disabled={active}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-slate-800 text-[var(--g-text)] disabled:opacity-40">
          <Minus className="w-4 h-4" />
        </button>
        <div className="flex-1 flex items-center justify-center gap-1 bg-black/30 border border-white/10 rounded-lg px-2 py-1.5">
          <input type="number" inputMode="decimal" min={1} step={1} value={stakeMajor}
            disabled={active} onChange={(event) => setStakeMajor(event.target.value)}
            aria-label={t(lang, 'stake')}
            className="w-20 bg-transparent text-center font-mono font-semibold text-sm text-[var(--g-text)] focus:outline-none disabled:opacity-50" />
          <span className="text-xs font-mono text-[var(--g-hint)]">{currency}</span>
        </div>
        <button type="button" onClick={() => adjust(1)} aria-label={t(lang, 'increaseStake')}
          disabled={active}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-slate-800 text-[var(--g-text)] disabled:opacity-40">
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {PRESETS_MAJOR.map((preset) => (
          <button key={preset} type="button" disabled={active}
            onClick={() => setStakeMajor(String(preset))}
            className="py-1.5 text-xs font-mono rounded-md bg-black/30 border border-white/10 text-[var(--g-hint)] hover:text-[var(--g-text)] disabled:opacity-40">
            {preset}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 text-xs text-[var(--g-hint)]">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input type="checkbox" checked={autoEnabled} disabled={active}
            onChange={(event) => setAutoEnabled(event.target.checked)}
            className="w-4 h-4 accent-[var(--g-gold)]" />
          <span>{t(lang, 'autoCashout')}</span>
        </label>
        <div className="flex items-center gap-1 bg-black/30 border border-white/10 rounded-md px-2 py-1">
          <input type="number" inputMode="decimal" min={1.01} step={0.01} value={autoValue}
            disabled={!autoEnabled || active}
            onChange={(event) => setAutoValue(event.target.value)}
            aria-label={t(lang, 'autoCashout')}
            className="w-14 bg-transparent text-right font-mono text-xs text-[var(--g-text)] focus:outline-none disabled:opacity-40" />
          <span className="font-mono text-[var(--g-hint)]">x</span>
        </div>
      </div>

      <div className="h-14">{renderPrimary()}</div>
    </div>
  );
};
