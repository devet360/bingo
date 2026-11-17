import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, ShieldCheck, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-react';
import type { GamePhase, Lang, RoundHistoryItem } from '../types';
import { multiplierAtElapsedMs } from '../fair';
import { t } from '../i18n';
import { drawFlightScene } from './flightCanvasRenderer';

interface FlightCanvasProps {
  roundId: number | null;
  phase: GamePhase;
  multiplier: number;
  elapsedMs: number;
  bettingEndsAt: number | null;
  bettingWindowMs: number;
  serverSeedHash: string | null;
  connected: boolean;
  history: readonly RoundHistoryItem[];
  muted: boolean;
  lang: Lang;
  isFullscreen: boolean;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onSelectHistoryRound: (roundId: number) => void;
  onOpenFairness: () => void;
}

function getHistoryChipStyle(mult: number): string {
  if (mult >= 10) {
    return 'bg-rose-500/15 text-rose-300 border-rose-500/35 hover:bg-rose-500/25';
  }
  if (mult >= 2) {
    return 'bg-violet-500/15 text-violet-300 border-violet-500/35 hover:bg-violet-500/25';
  }
  return 'bg-sky-500/10 text-sky-300 border-sky-500/25 hover:bg-sky-500/20';
}

export const FlightCanvas: React.FC<FlightCanvasProps> = ({
  roundId,
  phase,
  multiplier,
  elapsedMs,
  bettingEndsAt,
  bettingWindowMs,
  serverSeedHash,
  connected,
  history,
  muted,
  lang,
  isFullscreen,
  onToggleMute,
  onToggleFullscreen,
  onSelectHistoryRound,
  onOpenFairness,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [displayMultiplier, setDisplayMultiplier] = useState(multiplier);
  const [bettingProgress, setBettingProgress] = useState(1);
  const [bettingSecondsLeft, setBettingSecondsLeft] = useState(0);

  const syncRef = useRef({
    phase,
    multiplier,
    elapsedMs,
    syncedAtPerf: performance.now(),
    crashFlyOffStartPerf: 0,
  });

  useEffect(() => {
    const prevPhase = syncRef.current.phase;
    syncRef.current.phase = phase;
    syncRef.current.multiplier = multiplier;
    syncRef.current.elapsedMs = elapsedMs;
    syncRef.current.syncedAtPerf = performance.now();
    if (phase === 'CRASHED' && prevPhase !== 'CRASHED') {
      syncRef.current.crashFlyOffStartPerf = performance.now();
    }
    if (phase !== 'FLYING') {
      setDisplayMultiplier(multiplier);
    }
  }, [phase, multiplier, elapsedMs]);

  useEffect(() => {
    let rafId = 0;

    const render = (nowPerf: number) => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (canvas && container) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (
          canvas.width !== Math.floor(width * dpr) ||
          canvas.height !== Math.floor(height * dpr)
        ) {
          canvas.width = Math.floor(width * dpr);
          canvas.height = Math.floor(height * dpr);
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.scale(dpr, dpr);

          const s = syncRef.current;
          let liveMult = s.multiplier;
          let liveElapsed = s.elapsedMs;

          if (s.phase === 'FLYING') {
            liveElapsed = s.elapsedMs + (nowPerf - s.syncedAtPerf);
            liveMult = Math.max(s.multiplier, multiplierAtElapsedMs(liveElapsed));
            setDisplayMultiplier(liveMult);
          } else if (s.phase === 'BETTING' && bettingEndsAt !== null) {
            const rem = Math.max(0, bettingEndsAt - Date.now());
            setBettingProgress(Math.min(1, rem / Math.max(1, bettingWindowMs)));
            setBettingSecondsLeft(rem / 1000);
          }

          drawFlightScene(
            ctx,
            width,
            height,
            s.phase,
            liveMult,
            liveElapsed,
            s.crashFlyOffStartPerf ? nowPerf - s.crashFlyOffStartPerf : 0,
            nowPerf
          );

          ctx.restore();
        }
      }
      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafId);
  }, [bettingEndsAt, bettingWindowMs]);

  return (
    <div className="flex flex-col gap-2.5 w-full">
      <div className="flex items-center gap-2 bg-[var(--g-panel)] border border-white/10 rounded-xl px-3 py-2">
        <span className="text-[11px] font-medium text-[var(--g-hint)] whitespace-nowrap shrink-0 mr-1">
          {t(lang, 'recentRounds')}
        </span>
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar flex-1 py-0.5">
          {history.length === 0 ? (
            <span className="text-xs text-[var(--g-hint)]">{t(lang, 'noRoundsYet')}</span>
          ) : (
            history.slice(0, 24).map((item) => (
              <button
                key={item.roundId}
                type="button"
                onClick={() => onSelectHistoryRound(item.roundId)}
                title={`${t(lang, 'round')} #${item.roundId} · ${t(lang, 'tapToVerify')}`}
                className={`px-2 py-1 text-xs font-mono font-semibold rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${getHistoryChipStyle(
                  item.crashPoint
                )}`}
              >
                {item.crashPoint.toFixed(2)}x
              </button>
            ))
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        className={`relative w-full bg-[var(--g-panel)] border border-white/10 rounded-xl overflow-hidden select-none ${
          isFullscreen
            ? 'h-[calc(100dvh-190px)] min-h-[300px]'
            : 'h-[300px] sm:h-[380px]'
        }`}
      >
        <canvas ref={canvasRef} className="w-full h-full block" />

        <div className="absolute top-3 left-3.5 right-3.5 flex items-center justify-between pointer-events-none">
          <div className="flex items-center gap-2.5 text-xs text-[var(--g-hint)] pointer-events-auto">
            <span className="font-mono font-semibold text-[var(--g-text)] tabular-nums">
              {t(lang, 'round')} #{roundId ?? '—'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="flex items-center gap-1.5">
              {connected ? (
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <WifiOff className="w-3.5 h-3.5 text-rose-400" />
              )}
            </span>
          </div>

          <div className="flex items-center gap-2 pointer-events-auto">
            <button
              type="button"
              onClick={onOpenFairness}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[var(--g-hint)] hover:text-[var(--g-text)] bg-slate-900/80 hover:bg-slate-800 border border-white/10 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>{t(lang, 'provablyFair')}</span>
            </button>
            <button
              type="button"
              onClick={onToggleMute}
              aria-label={muted ? t(lang, 'unmute') : t(lang, 'mute')}
              title={muted ? t(lang, 'unmute') : t(lang, 'mute')}
              className="p-1.5 text-[var(--g-hint)] hover:text-[var(--g-text)] bg-slate-900/80 hover:bg-slate-800 border border-white/10 rounded-lg transition-colors cursor-pointer"
            >
              {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={onToggleFullscreen}
              aria-label={isFullscreen ? t(lang, 'exitFullScreen') : t(lang, 'fullScreen')}
              title={isFullscreen ? t(lang, 'exitFullScreen') : t(lang, 'fullScreen')}
              className="p-1.5 text-[var(--g-hint)] hover:text-[var(--g-text)] bg-slate-900/80 hover:bg-slate-800 border border-white/10 rounded-lg transition-colors cursor-pointer"
            >
              {isFullscreen ? (
                <Minimize2 className="w-4 h-4" />
              ) : (
                <Maximize2 className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-4">
          {phase === 'BETTING' && bettingEndsAt !== null && (
            <div className="flex flex-col items-center gap-3 max-w-xs w-full">
              <div className="text-xs font-semibold tracking-wider uppercase text-[var(--g-hint)]">
                {t(lang, 'nextRoundIn')}
              </div>
              <div className="text-3xl sm:text-4xl font-display font-bold text-[var(--g-text)] font-mono tabular-nums">
                {Math.max(0.1, bettingSecondsLeft).toFixed(1)}s
              </div>
              <div className="w-56 h-2 bg-slate-800/90 rounded-full overflow-hidden border border-white/10">
                <div
                  className="h-full bg-rose-500 transition-[width] duration-75 ease-linear"
                  style={{ width: `${Math.max(0, Math.min(100, bettingProgress * 100))}%` }}
                />
              </div>
            </div>
          )}

          {phase === 'FLYING' && (
            <div className="flex flex-col items-center">
              <div
                className={`text-5xl sm:text-6xl lg:text-7xl font-display font-extrabold tracking-tight font-mono tabular-nums drop-shadow-[0_4px_24px_rgba(0,0,0,0.65)] ${
                  displayMultiplier >= 10
                    ? 'text-amber-400'
                    : displayMultiplier >= 2
                    ? 'text-violet-300'
                    : 'text-white'
                }`}
              >
                {displayMultiplier.toFixed(2)}x
              </div>
            </div>
          )}

          {phase === 'CRASHED' && (
            <div className="flex flex-col items-center gap-1.5">
              <div className="text-sm sm:text-base font-display font-bold tracking-wide uppercase text-rose-400">
                {t(lang, 'crashedAt')}
              </div>
              <div className="text-5xl sm:text-6xl lg:text-7xl font-display font-extrabold tracking-tight font-mono tabular-nums text-rose-500 drop-shadow-[0_4px_24px_rgba(244,63,94,0.35)]">
                {multiplier.toFixed(2)}x
              </div>
            </div>
          )}
        </div>

        {serverSeedHash && (
          <div className="absolute bottom-2.5 left-3.5 text-[11px] font-mono text-[var(--g-hint)] truncate max-w-[75%] pointer-events-none">
            {t(lang, 'sha256Commit')}: {serverSeedHash.slice(0, 18)}...{serverSeedHash.slice(-8)}
          </div>
        )}
      </div>
    </div>
  );
};
