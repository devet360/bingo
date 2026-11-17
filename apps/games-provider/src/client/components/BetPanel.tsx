import React, { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { t } from '../i18n';
import type { BetFrame, BetLimits, GamePhase, Lang } from '../types';

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

export const money = (minor: bigint, currency: string) =>
  `${(Number(minor) / 100).toFixed(2)} ${currency}`;

export const BetPanel: React.FC<BetPanelProps> = ({
  panel, phase, multiplier, currency, balanceMinor, limits, bet, lang, onPlace, onCancel, onCashout,
}) => {
  const [stakeMajor, setStakeMajor] = useState('10');
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoValue, setAutoValue] = useState('2.00');

  const parsed = Number.parseFloat(stakeMajor);
  const stakeMinor = Number.isFinite(parsed) && parsed > 0 ? BigInt(Math.round(parsed * 100)) : 0n;
  const active = bet !== null && (bet.status === 'ACTIVE' || bet.status === 'PLACING');
  const cashed = bet?.status === 'CASHED';
  const finished = bet !== null && ['LOST', 'CANCELLED', 'REJECTED', 'UNRESOLVED'].includes(bet.status);
  const autoCashout = (() => {
    if (!autoEnabled) return null;
    const value = Number.parseFloat(autoValue);
    return Number.isFinite(value) && value >= 1.01 ? Number(value.toFixed(2)) : null;
  })();
  const outOfBounds = stakeMinor < limits.minStake || stakeMinor > limits.maxStake;
  const unaffordable = stakeMinor > balanceMinor;

  const adjust = (delta: number) => {
    const next = Math.max(1, (Number.parseFloat(stakeMajor) || 0) + delta);
    setStakeMajor(String(next));
  };

  const renderPrimary = () => {
    const base =
      'w-full h-full min-h-[56px] px-3 rounded-xl font-display font-bold flex flex-col items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50';
    if (active && phase === 'FLYING' && bet) {
      const estimate = BigInt(Math.floor(Number(bet.stake) * multiplier));
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
    if (finished) {
      return (
        <button type="button" disabled className={`${base} bg-slate-800 text-slate-400`}>
          {t(lang, 'lost')}
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
        <button type="button" onClick={() => adjust(-1)} aria-label="Decrease stake"
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
        <button type="button" onClick={() => adjust(1)} aria-label="Increase stake"
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
