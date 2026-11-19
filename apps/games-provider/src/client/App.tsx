import React, { useCallback, useEffect, useRef, useState } from 'react';
import { exitGame, installBridge } from './bridge';
import { en, t } from './i18n';
import { money, BetPanel } from './components/BetPanel';
import { FlightCanvas } from './components/FlightCanvas';
import { ProvablyFairModal } from './components/ProvablyFairModal';
import { useCrashSocket } from './hooks/useCrashSocket';
import { soundEngine } from './sound';
import type { HandshakeData, Lang } from './types';

type Boot =
  | { state: 'loading' }
  | { state: 'ready'; session: HandshakeData }
  | { state: 'ended' }
  | { state: 'error' };

function readLang(): Lang {
  const value = new URLSearchParams(window.location.search).get('lang');
  return value === 'am' ? 'am' : 'en';
}

// The server message is a dev fallback: players only ever see a localized rule.
const ERROR_KEYS: Record<string, keyof typeof en> = {
  BETTING_CLOSED: 'bettingClosed',
  STAKE_OUT_OF_RANGE: 'stakeOutOfRange',
  AUTO_CASHOUT_INVALID: 'autoCashoutInvalid',
  ROUND_BET_LIMIT: 'roundBetLimit',
  NO_ACTIVE_BET: 'noActiveBet',
  ROUND_NOT_FLYING: 'roundNotFlying',
};

const EndedScreen: React.FC<{ lang: Lang; body?: string }> = ({ lang, body }) => (
  <div className="min-h-dvh bg-[var(--g-bg)] text-[var(--g-text)] flex flex-col items-center justify-center gap-3 px-6 text-center">
    <p className="font-display text-lg font-bold">
      {body ?? t(lang, 'sessionEnded')}
    </p>
    {body === undefined && <p className="text-sm text-[var(--g-hint)]">{t(lang, 'sessionEndedBody')}</p>}
    <button type="button" onClick={exitGame}
      className="px-4 py-2 rounded-lg bg-[var(--g-accent)] text-[var(--g-on-accent)] font-semibold">
      {t(lang, 'backToGames')}
    </button>
  </div>
);

const GameScreen: React.FC<{ token: string; session: HandshakeData; lang: Lang }> = ({
  token, session, lang,
}) => {
  const [ended, setEnded] = useState(false);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fairnessOpen, setFairnessOpen] = useState(false);
  const [inspectedRoundId, setInspectedRoundId] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const enteredNativeRef = useRef(false);

  const onSessionEnded = useCallback(() => {
    setEnded(true);
    exitGame();
  }, []);
  const socket = useCrashSocket({ token, initialBalance: session.balance, onSessionEnded });

  const limits = {
    minStake: BigInt(session.limits.minStake),
    maxStake: BigInt(session.limits.maxStake),
    maxWin: BigInt(session.limits.maxWin),
  };

  const balanceMinor = BigInt(socket.balance);

  useEffect(() => {
    const onFullscreenChange = () => {
      const nativeActive = Boolean(document.fullscreenElement);
      if (nativeActive) {
        enteredNativeRef.current = true;
        setIsFullscreen(true);
      } else if (enteredNativeRef.current) {
        enteredNativeRef.current = false;
        setIsFullscreen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isFullscreen && !document.fullscreenElement) setIsFullscreen(false);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isFullscreen]);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          // fall through to the expanded viewport state
        }
      }
      enteredNativeRef.current = false;
      setIsFullscreen(false);
      return;
    }
    const element = containerRef.current;
    if (element && typeof element.requestFullscreen === 'function') {
      try {
        await element.requestFullscreen();
        enteredNativeRef.current = true;
      } catch {
        enteredNativeRef.current = false;
      }
    }
    setIsFullscreen(true);
  }, [isFullscreen]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    soundEngine.setMuted(next);
  };

  if (ended || socket.ended !== null) {
    return <EndedScreen lang={lang} />;
  }

  return (
    <div ref={containerRef}
      className={`bg-[var(--g-bg)] text-[var(--g-text)] flex flex-col ${
        isFullscreen ? 'fixed inset-0 z-50 overflow-y-auto' : 'min-h-dvh'
      }`}>
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="font-display font-bold">{t(lang, 'gameTitle')}</div>
        <div className="font-mono font-bold tabular-nums text-[var(--g-gold)]">
          {money(balanceMinor, session.currency)}
        </div>
      </header>

      {!socket.connected && socket.ended === null && (
        <div className="mx-3 mb-2 rounded-lg bg-amber-950/60 border border-amber-500/40 px-3 py-1.5 text-xs text-amber-200">
          {t(lang, 'reconnecting')}
        </div>
      )}
      {socket.lastError && (
        <div className="mx-3 mb-2 rounded-lg bg-rose-950/70 border border-rose-500/40 px-3 py-1.5 text-xs text-rose-200">
          {t(lang, ERROR_KEYS[socket.lastError.code] ?? 'actionFailed')}
        </div>
      )}

      <main className="flex-1 w-full max-w-[760px] mx-auto px-3 pb-[calc(var(--g-safe-bottom)+0.75rem)] flex flex-col gap-3">
        <FlightCanvas
          roundId={socket.roundId}
          phase={socket.phase}
          multiplier={socket.multiplier}
          elapsedMs={socket.elapsedMs}
          bettingEndsAt={socket.bettingEndsAt}
          bettingWindowMs={socket.bettingWindowMs}
          serverSeedHash={socket.serverSeedHash}
          connected={socket.connected}
          history={socket.history}
          muted={muted}
          lang={lang}
          isFullscreen={isFullscreen}
          onToggleMute={toggleMute}
          onToggleFullscreen={() => void toggleFullscreen()}
          onSelectHistoryRound={(target) => {
            setInspectedRoundId(target);
            setFairnessOpen(true);
          }}
          onOpenFairness={() => {
            setInspectedRoundId(null);
            setFairnessOpen(true);
          }}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {([0, 1] as const).map((panel) => (
            <BetPanel key={panel} panel={panel} phase={socket.phase} multiplier={socket.multiplier}
              currency={session.currency} balanceMinor={balanceMinor} limits={limits}
              bet={socket.bets[panel]} lang={lang}
              onPlace={socket.placeBet} onCancel={socket.cancelBet} onCashout={socket.cashout} />
          ))}
        </div>
      </main>

      <ProvablyFairModal isOpen={fairnessOpen} onClose={() => setFairnessOpen(false)} lang={lang}
        currentRoundId={socket.roundId} currentServerSeedHash={socket.serverSeedHash}
        inspectedRoundId={inspectedRoundId} />
    </div>
  );
};

const CoinFlipScreen: React.FC<{ token: string; session: HandshakeData; lang: Lang }> = ({
  token, session, lang,
}) => {
  const [stake, setStake] = useState('100');
  const onSessionEnded = useCallback(() => undefined, []);
  const socket = useCrashSocket({ token, initialBalance: session.balance, onSessionEnded });
  const limits = {
    minStake: BigInt(session.limits.minStake),
    maxStake: BigInt(session.limits.maxStake),
  };
  const place = (panel: 0 | 1) => {
    const parsed = BigInt(stake || '0');
    if (parsed < limits.minStake || parsed > limits.maxStake) return;
    socket.placeBet(panel, parsed, null);
  };

  return (
    <div className="min-h-dvh bg-[var(--g-bg)] text-[var(--g-text)] px-3 py-2">
      <header className="flex items-center justify-between">
        <div className="font-display font-bold">{t(lang, 'coinFlipTitle')}</div>
        <div className="font-mono font-bold text-[var(--g-gold)]">
          {money(BigInt(socket.balance), session.currency)}
        </div>
      </header>
      {socket.lastError && (
        <p className="mt-2 rounded-lg bg-rose-950/70 px-3 py-2 text-xs">{socket.lastError.message}</p>
      )}
      <main className="mx-auto mt-5 max-w-[620px] space-y-4">
        <div className="grid grid-cols-2 gap-3">
          {([0, 1] as const).map((panel) => (
            <button
              key={panel}
              type="button"
              disabled={socket.phase !== 'BETTING'}
              onClick={() => place(panel)}
              className="min-h-40 rounded-2xl border border-white/10 bg-white/5 p-4 disabled:opacity-50"
            >
              <p className="font-display text-2xl font-black">
                {panel === 0 ? t(lang, 'heads') : t(lang, 'tails')}
              </p>
              {socket.bets[panel] ? (
                <p className="mt-2 text-sm">
                  {socket.bets[panel]?.status === 'CASHED'
                    ? t(lang, 'won')
                    : socket.bets[panel]?.status === 'LOST'
                      ? t(lang, 'lost')
                      : socket.bets[panel]?.stake}
                </p>
              ) : null}
            </button>
          ))}
        </div>
        <div className="rounded-xl border border-white/10 p-3">
          <label className="text-xs text-[var(--g-hint)]">{t(lang, 'stake')}</label>
          <input
            value={stake}
            onChange={(event) => setStake(event.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-3 font-mono"
          />
        </div>
        {socket.phase === 'CRASHED' && (
          <p className="text-center text-sm text-[var(--g-hint)]">
            {socket.coinOutcome === null
              ? t(lang, 'coinFlipReveal')
              : socket.coinOutcome === 'HEADS'
                ? t(lang, 'coinFlipHeadsWin')
                : t(lang, 'coinFlipTailsWin')}
          </p>
        )}
        <button type="button" onClick={exitGame} className="w-full rounded-lg bg-[var(--g-accent)] px-4 py-3 font-semibold">
          {t(lang, 'backToGames')}
        </button>
      </main>
    </div>
  );
};

export default function App() {
  const [lang, setLang] = useState<Lang>(readLang);
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });
  const params = new URLSearchParams(window.location.search);
  const token = useRef(params.get('token')).current;
  const operator = useRef(params.get('operator') ?? undefined).current;
  const game = useRef(params.get('game') ?? undefined).current;

  useEffect(() => {
    installBridge({ onLocale: setLang });
  }, []);

  useEffect(() => {
    if (!token) {
      setBoot({ state: 'ended' });
      return;
    }
    let cancelled = false;
    fetch('/api/sessions/handshake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, ...(operator ? { operator } : {}), ...(game ? { game } : {}) }),
    })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 410) {
          setBoot({ state: 'ended' });
          return;
        }
        if (!response.ok) {
          setBoot({ state: 'error' });
          return;
        }
        const body = (await response.json()) as { data: HandshakeData };
        setBoot({ state: 'ready', session: body.data });
      })
      .catch(() => {
        if (!cancelled) setBoot({ state: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (boot.state === 'loading') {
    return (
      <div className="min-h-dvh bg-[var(--g-bg)] text-[var(--g-hint)] flex items-center justify-center text-sm">
        {t(lang, 'loading')}
      </div>
    );
  }
  if (boot.state === 'ended') return <EndedScreen lang={lang} />;
  if (boot.state === 'error') return <EndedScreen lang={lang} body={t(lang, 'loadFailed')} />;
  if (boot.session.gameId === 'coinflip') {
    return <CoinFlipScreen token={token as string} session={boot.session} lang={lang} />;
  }
  return <GameScreen token={token as string} session={boot.session} lang={lang} />;
}
