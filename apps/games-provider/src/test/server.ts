import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../config';
import { createApp } from '../server/http';
import { BetManager } from '../server/betManager';
import type { OperatorRegistry } from '../server/operatorRegistry';
import { RoundEngine, type EngineLimits } from '../server/roundEngine';
import { attachSocket, type SocketHandle } from '../server/socket';
import type { Store } from '../server/store';

export interface TestServer {
  url: string;
  wsUrl: string;
  engine: RoundEngine;
  store: Store;
  socket: SocketHandle;
  close(): Promise<void>;
}

export async function startTestServer(
  input: { config: AppConfig; store: Store; registry: OperatorRegistry },
): Promise<TestServer> {
  // The engine only needs the round timings and `maxWin`; the per-operator bet
  // cap now comes from each session (`maxBetsPerRound`).
  const limits: EngineLimits = input.config.limits;
  let socket: SocketHandle | null = null;
  const betManager = new BetManager({
    store: input.store,
    wallets: input.registry,
    onSettled: (bet) => socket?.notifyBet(bet),
  });
  const engine = new RoundEngine({
    store: input.store, limits,
    operatorCode: input.config.operator.code,
    randomSeed: () => 'test-server-seed',
    clientSeeds: () => ['alpha', 'beta', 'gamma'],
    onEvent: (event) => socket?.broadcast(event),
    betManager,
  });
  const server = createServer(createApp({ config: input.config, store: input.store, registry: input.registry }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  socket = attachSocket({ server, store: input.store, engine, registry: input.registry });
  const attached: SocketHandle = socket;
  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    engine,
    store: input.store,
    socket: attached,
    async close() {
      await attached.close();
      engine.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
