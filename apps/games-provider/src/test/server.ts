import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../config';
import { createApp } from '../server/http';
import { BetManager } from '../server/betManager';
import { RoundEngine, type EngineLimits } from '../server/roundEngine';
import { attachSocket, type SocketHandle } from '../server/socket';
import type { Store } from '../server/store';
import type { WalletClient } from '../server/wallet';

export interface TestServer { url: string; wsUrl: string; engine: RoundEngine; close(): Promise<void> }

export async function startTestServer(input: { config: AppConfig; store: Store; wallet: WalletClient }): Promise<TestServer> {
  const limits: EngineLimits = { ...input.config.limits, maxBetsPerRound: 4 };
  const betManager = new BetManager({ store: input.store, wallet: input.wallet, limits });
  let socket: SocketHandle | null = null;
  const engine = new RoundEngine({
    store: input.store, wallet: input.wallet, limits,
    operatorCode: input.config.operator.code,
    randomSeed: () => 'test-server-seed',
    clientSeeds: () => ['alpha', 'beta', 'gamma'],
    onEvent: (event) => socket?.broadcast(event),
    betManager,
  });
  const server = createServer(createApp(input));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  socket = attachSocket({ server, store: input.store, engine });
  const attached = socket;
  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    engine,
    async close() {
      await attached.close();
      engine.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
