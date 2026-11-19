import { useCallback, useEffect, useRef, useState } from 'react';
import { haptic } from '../bridge';
import { soundEngine } from '../sound';
import type {
  BetFrame, GamePhase, RoundHistoryItem, ServerFrame,
} from '../types';

const BETTING_WINDOW_MS = 5_500;

export function useCrashSocket(input: {
  token: string;
  initialBalance: string;
  onSessionEnded: () => void;
}) {
  const { token, initialBalance, onSessionEnded } = input;
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<GamePhase>('BETTING');
  const [roundId, setRoundId] = useState<number | null>(null);
  const [multiplier, setMultiplier] = useState(1);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [bettingEndsAt, setBettingEndsAt] = useState<number | null>(null);
  const [bettingWindowMs, setBettingWindowMs] = useState(BETTING_WINDOW_MS);
  const [serverSeedHash, setServerSeedHash] = useState<string | null>(null);
  const [history, setHistory] = useState<RoundHistoryItem[]>([]);
  const [bets, setBets] = useState<[BetFrame | null, BetFrame | null]>([null, null]);
  const [balance, setBalance] = useState(initialBalance);
  const [lastError, setLastError] = useState<{ code: string; message: string } | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [coinOutcome, setCoinOutcome] = useState<'HEADS' | 'TAILS' | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const endedRef = useRef(false);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The round only changes on `snapshot` / `round:betting`; bet:update frames
  // are matched against it so a late sweep cannot touch a newer round's panels.
  const roundIdRef = useRef<number | null>(null);
  // Last (roundId, panel, status) tuple that played win feedback, so a
  // duplicated CASHED frame does not chime or buzz twice.
  const feedbackRef = useRef<string | null>(null);

  useEffect(() => {
    let unmounted = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;

    const showError = (code: string, message: string) => {
      setLastError({ code, message });
      haptic('error');
      if (errorTimer.current) clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => setLastError(null), 4000);
    };

    const handleFrame = (raw: string) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(raw) as ServerFrame;
      } catch {
        return;
      }
      switch (frame.type) {
        case 'snapshot':
          setPhase(frame.phase);
          setRoundId(frame.roundId);
          roundIdRef.current = frame.roundId;
          setMultiplier(frame.multiplier);
          setElapsedMs(frame.elapsedMs);
          setBettingWindowMs(BETTING_WINDOW_MS);
          setBettingEndsAt(frame.phase === 'BETTING' ? Date.now() + frame.bettingEndsInMs : null);
          setServerSeedHash(frame.serverSeedHash);
          setBalance(frame.balance);
          setBets(frame.bets);
          setCoinOutcome(frame.coinOutcome ?? null);
          break;
        case 'round:betting':
          setPhase('BETTING');
          setRoundId(frame.roundId);
          roundIdRef.current = frame.roundId;
          setMultiplier(1);
          setElapsedMs(0);
          setBettingWindowMs(frame.bettingEndsInMs);
          setBettingEndsAt(Date.now() + frame.bettingEndsInMs);
          setServerSeedHash(frame.serverSeedHash);
          setBets([null, null]);
          break;
        case 'round:tick':
          // The gateway delivers takeoff as the elapsed-0 tick, and emits ticks
          // only while a round is flying.
          if (frame.elapsedMs === 0) {
            setPhase('FLYING');
            setBettingEndsAt(null);
            soundEngine.playTakeoff();
          }
          setMultiplier(frame.multiplier);
          setElapsedMs(frame.elapsedMs);
          break;
        case 'round:crashed':
          setPhase('CRASHED');
          setMultiplier(frame.crashPoint);
          setHistory((prev) => [
            { roundId: frame.roundId, crashPoint: frame.crashPoint },
            ...prev.filter((item) => item.roundId !== frame.roundId),
          ].slice(0, 24));
          soundEngine.playCrash();
          break;
        case 'coinflip:betting':
          setPhase('BETTING');
          setRoundId(frame.roundId);
          roundIdRef.current = frame.roundId;
          setMultiplier(1);
          setElapsedMs(0);
          setBettingWindowMs(frame.bettingEndsInMs);
          setBettingEndsAt(Date.now() + frame.bettingEndsInMs);
          setServerSeedHash(frame.serverSeedHash);
          setBets([null, null]);
          setCoinOutcome(null);
          break;
        case 'coinflip:revealed':
          setPhase('CRASHED');
          setMultiplier(2);
          setElapsedMs(5500);
          setBettingEndsAt(null);
          setCoinOutcome(frame.outcome);
          soundEngine.playCrash();
          break;
        case 'bet:update': {
          if (frame.roundId !== roundIdRef.current) break;
          const bet: BetFrame = frame;
          setBets((prev) => {
            const next: [BetFrame | null, BetFrame | null] = [prev[0], prev[1]];
            next[bet.panel] = bet;
            return next;
          });
          if (bet.status === 'ACTIVE') soundEngine.playBetPlaced();
          if (bet.status === 'CASHED') {
            const feedbackKey = `${bet.roundId}:${bet.panel}:${bet.status}`;
            if (feedbackRef.current !== feedbackKey) {
              feedbackRef.current = feedbackKey;
              soundEngine.playCashout();
              haptic('success');
            }
          }
          break;
        }
        case 'balance:update':
          setBalance(frame.balance);
          break;
        case 'session:ended':
          endedRef.current = true;
          setEnded(frame.reason);
          ws?.close();
          onSessionEnded();
          break;
        case 'error':
          showError(frame.code, frame.message);
          break;
      }
    };

    const connect = () => {
      if (unmounted || endedRef.current) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        if (unmounted) return;
        setConnected(true);
        ws?.send(JSON.stringify({ type: 'auth', token }));
      };
      ws.onmessage = (event) => {
        if (!unmounted) handleFrame(event.data as string);
      };
      ws.onclose = () => {
        if (unmounted) return;
        setConnected(false);
        if (!endedRef.current) reconnectTimer = setTimeout(connect, 1200);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (errorTimer.current) clearTimeout(errorTimer.current);
      ws?.close();
      wsRef.current = null;
    };
  }, [token, onSessionEnded]);

  const send = useCallback((frame: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }, []);

  const placeBet = useCallback((panel: 0 | 1, stakeMinor: bigint, autoCashout: number | null) => {
    haptic('tap');
    send({ type: 'bet:place', panel, stake: stakeMinor.toString(), ...(autoCashout === null ? {} : { autoCashout }) });
  }, [send]);

  const cancelBet = useCallback((panel: 0 | 1) => {
    haptic('tap');
    send({ type: 'bet:cancel', panel });
  }, [send]);

  const cashout = useCallback((panel: 0 | 1) => send({ type: 'bet:cashout', panel }), [send]);

  return {
    connected, phase, roundId, multiplier, elapsedMs, bettingEndsAt, bettingWindowMs,
    serverSeedHash, history, bets, balance, lastError, ended, coinOutcome,
    placeBet, cancelBet, cashout,
  };
}
