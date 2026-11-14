'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { fetchMyCards, fetchRoom } from './api';
import { connectSocket } from './socket';
import type { Card, Room, Round, SettlementEvent, Wallet } from './types';

interface SubscribeAck {
  room?: Room;
  round?: Round | null;
  myCards?: Card[];
  error?: { code: string; message: string };
}

interface LiveState {
  room: Room | null;
  round: Round | null;
  cards: Card[];
  connected: boolean;
  error: string | null;
  settlement: SettlementEvent | null;
  cancelledReason: string | null;
}

export interface RoomLive extends LiveState {
  refreshRoom: () => Promise<void>;
  setCards: (updater: Card[] | ((current: Card[]) => Card[])) => void;
  requestRoundView: (roundId: string) => Promise<void>;
}

/**
 * One socket per table. REST owns purchases/claims; this hook only mirrors
 * server facts (`round:state`, `ball:drawn`, …) and refreshes around boundaries.
 */
export function useRoomLive(
  roomCode: string,
  options: { onWalletUpdate?: (wallet: Partial<Wallet>) => void } = {},
): RoomLive {
  const [state, setState] = useState<LiveState>({
    room: null,
    round: null,
    cards: [],
    connected: false,
    error: null,
    settlement: null,
    cancelledReason: null,
  });
  const socketRef = useRef<Socket | null>(null);
  const onWallet = useRef(options.onWalletUpdate);
  onWallet.current = options.onWalletUpdate;
  const roundRef = useRef<Round | null>(null);
  roundRef.current = state.round;

  const loadCards = useCallback(async (roundId: string | null | undefined) => {
    if (!roundId) return [];
    try {
      return await fetchMyCards(roundId);
    } catch {
      return [];
    }
  }, []);

  const applySnapshot = useCallback(
    (room: Room | null | undefined, round: Round | null | undefined, cards?: Card[]) => {
      setState((current) => ({
        ...current,
        room: room ?? current.room,
        round: round === undefined ? current.round : round,
        cards: cards ?? current.cards,
        error: null,
      }));
    },
    [],
  );

  const refreshRoom = useCallback(async () => {
    const view = await fetchRoom(roomCode);
    const currentRound = roundRef.current;
    if (!currentRound || view.round?.id !== currentRound.id) {
      const cards = view.round ? await loadCards(view.round.id) : [];
      setState((current) => ({
        ...current,
        room: view.room,
        round: view.round,
        cards,
        settlement: null,
        cancelledReason: null,
        error: null,
      }));
      return;
    }
    setState((current) => ({ ...current, room: view.room, round: view.round, error: null }));
  }, [roomCode, loadCards]);

  useEffect(() => {
    const socket = connectSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      setState((current) => ({ ...current, connected: true, error: null }));
      socket.emit('room:subscribe', { roomCode }, (ack: SubscribeAck) => {
        if (ack?.error) {
          setState((current) => ({ ...current, error: ack.error!.message }));
          return;
        }
        applySnapshot(ack.room, ack.round, ack.myCards ?? []);
      });
    });

    socket.on('disconnect', () => {
      setState((current) => ({ ...current, connected: false }));
    });

    socket.on('connect_error', (error: Error) => {
      setState((current) => ({
        ...current,
        connected: false,
        error:
          error.message === 'UNAUTHORIZED'
            ? 'Session expired. Reconnecting…'
            : 'Live updates offline — retrying.',
      }));
    });

    socket.on('round:state', (round: Round) => {
      setState((current) => {
        if (current.round && current.round.id !== round.id) {
          return {
            ...current,
            round,
            cards: [],
            settlement: null,
            cancelledReason: null,
          };
        }
        return { ...current, round, error: null };
      });
      if (round.status === 'WAITING') {
        void loadCards(round.id).then((cards) => {
          setState((current) =>
            current.round?.id === round.id ? { ...current, cards } : current,
          );
        });
      }
    });

    socket.on(
      'ball:drawn',
      (payload: { roundId: string; ball: number; index: number; drawnCount: number; status: Round['status'] }) => {
        setState((current) => {
          if (!current.round || current.round.id !== payload.roundId) return current;
          const drawn = current.round.drawnBalls.includes(payload.ball)
            ? current.round.drawnBalls
            : [...current.round.drawnBalls, payload.ball];
          return {
            ...current,
            round: {
              ...current.round,
              drawnBalls: drawn,
              currentBall: payload.ball,
              status: payload.status,
              lastDrawAt: new Date().toISOString(),
            },
          };
        });
      },
    );

    socket.on(
      'round:claiming',
      (payload: { roundId: string; claimsCloseAt: string; detectedWinners: number }) => {
        setState((current) =>
          current.round?.id === payload.roundId
            ? {
                ...current,
                round: {
                  ...current.round,
                  status: 'CLAIM_VERIFICATION',
                  claimsCloseAt: payload.claimsCloseAt,
                },
              }
            : current,
        );
      },
    );

    socket.on('round:settled', (payload: SettlementEvent) => {
      setState((current) =>
        current.round?.id === payload.roundId
          ? { ...current, settlement: payload, round: { ...current.round, status: 'COMPLETED' } }
          : current,
      );
      void loadCards(payload.roundId).then((cards) => {
        setState((current) =>
          current.round?.id === payload.roundId ? { ...current, cards } : current,
        );
      });
      void fetchRoom(roomCode)
        .then((view) => {
          setState((current) =>
            current.round?.id === view.round?.id
              ? { ...current, round: view.round, room: view.room }
              : current,
          );
        })
        .catch(() => undefined);
    });

    socket.on('round:cancelled', (payload: { roundId: string; reason: string }) => {
      setState((current) =>
        current.round?.id === payload.roundId
          ? {
              ...current,
              cancelledReason: payload.reason,
              round: { ...current.round, status: 'CANCELLED' },
            }
          : current,
      );
      void loadCards(payload.roundId).then((cards) => {
        setState((current) =>
          current.round?.id === payload.roundId ? { ...current, cards } : current,
        );
      });
    });

    socket.on('wallet:update', (wallet: Partial<Wallet>) => {
      onWallet.current?.(wallet);
    });

    void refreshRoom().catch(() => undefined);

    return () => {
      socket.emit('room:unsubscribe', { roomCode });
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomCode, applySnapshot, loadCards, refreshRoom]);

  // Lobby-level polling: socket state covers play, polling covers idle gaps
  // between rounds and a dropped socket.
  useEffect(() => {
    const active = state.round && ['WAITING', 'LOCKED', 'PLAYING', 'CLAIM_VERIFICATION'].includes(state.round.status);
    if (active && state.connected) return;
    const timer = setInterval(() => {
      void refreshRoom().catch(() => undefined);
    }, 4_000);
    return () => clearInterval(timer);
  }, [state.round?.status, state.connected, refreshRoom]);

  const setCards = useCallback((updater: Card[] | ((current: Card[]) => Card[])) => {
    setState((current) => ({
      ...current,
      cards: typeof updater === 'function' ? (updater as (cards: Card[]) => Card[])(current.cards) : updater,
    }));
  }, []);

  const requestRoundView = useCallback(async (roundId: string) => {
    const cards = await loadCards(roundId);
    setState((current) => ({ ...current, cards }));
  }, [loadCards]);

  return { ...state, refreshRoom, setCards, requestRoundView };
}
