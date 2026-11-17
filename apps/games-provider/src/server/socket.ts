import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { RoundEngine, RoundEngineEvent } from './roundEngine';
import type { Store } from './store';
import { WalletError } from './wallet';

const HEARTBEAT_MS = 30_000;
const PANELS = [0, 1] as const;
type Panel = (typeof PANELS)[number];
type EngineView = Pick<RoundEngine, 'snapshot' | 'placeBet' | 'cancelBet' | 'cashout'>;

export interface SocketHandle {
  broadcast(event: RoundEngineEvent): void;
  close(): Promise<void>;
}

interface ClientState { sessionToken: string | null; alive: boolean; tail: Promise<void> }

export function attachSocket(input: { server: Server; store: Store; engine: EngineView }): SocketHandle {
  const { store, engine } = input;
  // maxPayload keeps a hostile client from buffering 100 MiB before JSON.parse.
  const wss = new WebSocketServer({ server: input.server, path: '/ws', maxPayload: 64 * 1024 });
  const clients = new Map<WebSocket, ClientState>();

  const send = (ws: WebSocket, frame: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const sendToSession = (sessionToken: string, frame: Record<string, unknown>) => {
    for (const [ws, state] of clients) if (state.sessionToken === sessionToken) send(ws, frame);
  };

  wss.on('connection', (ws) => {
    const state: ClientState = { sessionToken: null, alive: true, tail: Promise.resolve() };
    clients.set(ws, state);
    ws.on('pong', () => { state.alive = true; });
    // `ws` emits 'error' for protocol violations (e.g. an unmasked frame); an
    // EventEmitter 'error' with no listener is an uncaughtException that would
    // take down the whole provider. Never leave it unhandled.
    ws.on('error', (error) => {
      console.error('socket client failed', error);
      clients.delete(ws);
    });
    ws.on('close', () => clients.delete(ws));
    // A socket's frames run strictly in order: a cancel must never overtake the
    // place it cancels while both sit on store/wallet awaits.
    ws.on('message', (raw) => {
      state.tail = state.tail
        .then(() => handleFrame(ws, raw.toString()))
        .catch((error: unknown) => {
          console.error('socket frame failed', error);
          send(ws, { type: 'error', code: 'INTERNAL_ERROR', message: 'Frame handling failed' });
        });
    });
  });

  async function handleFrame(ws: WebSocket, raw: string): Promise<void> {
    const state = clients.get(ws);
    if (!state) return;
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      frame = parsed as Record<string, unknown>;
    } catch {
      send(ws, { type: 'error', code: 'BAD_FRAME', message: 'Frame is not a JSON object' });
      return;
    }
    const type = frame.type;
    if (typeof type !== 'string') {
      send(ws, { type: 'error', code: state.sessionToken ? 'BAD_FRAME' : 'NOT_AUTHED', message: 'Frame has no type' });
      return;
    }
    if (type !== 'auth' && state.sessionToken === null) {
      send(ws, { type: 'error', code: 'NOT_AUTHED', message: 'Authenticate first' });
      return;
    }

    if (type === 'auth') {
      const token = frame.token;
      if (typeof token !== 'string' || token.length === 0) {
        send(ws, { type: 'error', code: 'BAD_FRAME', message: 'auth requires a token' });
        return;
      }
      const session = await store.getSession(token);
      if (session === null || session.status !== 'OPEN') {
        send(ws, { type: 'session:ended', reason: session === null ? 'UNKNOWN' : 'CLOSED' });
        ws.close(4001, 'session ended');
        return;
      }
      state.sessionToken = session.token;
      send(ws, { type: 'snapshot', ...engine.snapshot(), balance: session.displayBalance.toString() });
      return;
    }

    const token = state.sessionToken;
    if (token === null) return;
    const session = await store.getSession(token);
    if (session === null || session.status !== 'OPEN') {
      send(ws, { type: 'session:ended', reason: session === null ? 'UNKNOWN' : 'CLOSED' });
      ws.close(4001, 'session ended');
      return;
    }

    if (type === 'bet:place') {
      const panel = frame.panel;
      const stake = frame.stake;
      const autoCashout = frame.autoCashout ?? null;
      if (!PANELS.includes(panel as Panel) || typeof stake !== 'string' || !/^[1-9]\d*$/.test(stake)
        || (autoCashout !== null && (typeof autoCashout !== 'number' || !Number.isFinite(autoCashout) || autoCashout < 1))) {
        send(ws, { type: 'error', code: 'BAD_FRAME', message: 'bet:place requires panel 0|1, a decimal stake and an optional autoCashout >= 1' });
        return;
      }
      await act(ws, token, panel as Panel, () =>
        engine.placeBet({ session, panel: panel as Panel, stake: BigInt(stake), autoCashout: autoCashout as number | null }),
      );
      return;
    }
    if (type === 'bet:cancel' || type === 'bet:cashout') {
      const panel = frame.panel;
      if (!PANELS.includes(panel as Panel)) {
        send(ws, { type: 'error', code: 'BAD_FRAME', message: `${type} requires panel 0|1` });
        return;
      }
      await act(ws, token, panel as Panel, () =>
        type === 'bet:cancel'
          ? engine.cancelBet({ session, panel: panel as Panel })
          : engine.cashout({ session, panel: panel as Panel }),
      );
      return;
    }
    send(ws, { type: 'error', code: 'BAD_FRAME', message: `Unknown frame type ${type}` });
  }

  async function act(ws: WebSocket, token: string, panel: Panel, action: () => Promise<unknown>): Promise<void> {
    const roundId = engine.snapshot().roundId;
    try {
      await action();
    } catch (error) {
      if (error instanceof WalletError) {
        send(ws, { type: 'error', code: error.code, message: error.message });
      } else {
        send(ws, { type: 'error', code: 'BET_REJECTED', message: error instanceof Error ? error.message : 'Bet rejected' });
      }
      return;
    }
    if (roundId !== null) {
      const bet = await store.getBet(roundId, token, panel);
      if (bet !== null) {
        sendToSession(token, {
          type: 'bet:update', roundId: bet.roundId, panel: bet.panel, status: bet.status,
          stake: bet.stake.toString(), autoCashout: bet.autoCashout,
          cashoutMultiplier: bet.cashoutMultiplier, payout: bet.payout === null ? null : bet.payout.toString(),
        });
      }
    }
    const fresh = await store.getSession(token);
    if (fresh !== null) sendToSession(token, { type: 'balance:update', balance: fresh.displayBalance.toString() });
  }

  const heartbeat = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) { ws.terminate(); clients.delete(ws); continue; }
      state.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    broadcast(event) {
      const frame: Record<string, unknown> = event.type === 'round:flying'
        ? { type: 'round:tick', roundId: event.payload.roundId, multiplier: event.payload.multiplier, elapsedMs: event.payload.elapsedMs }
        : { type: event.type, ...event.payload };
      for (const [ws, state] of clients) if (state.sessionToken !== null) send(ws, frame);
    },
    async close() {
      clearInterval(heartbeat);
      for (const ws of clients.keys()) ws.terminate();
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
