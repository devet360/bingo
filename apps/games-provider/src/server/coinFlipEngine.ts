import { randomUUID } from 'node:crypto';
import { deriveCoinFlipOutcome, sha256Hex } from '../domain/provablyFair';
import type { BetRecord, RoundRecord, SessionRecord } from '../domain/types';
import type { BetManager } from './betManager';
import type { Store } from './store';

export const COINFLIP_BETTING_WINDOW_MS = 5_500;
export const COINFLIP_COOLDOWN_MS = 3_200;

export interface CoinFlipEngineDeps {
  store: Store;
  betManager: BetManager;
  operatorCode: string;
  randomSeed?: () => string;
  clientSeeds?: () => readonly string[];
  now?: () => Date;
  onEvent?: (event: CoinFlipEngineEvent) => void;
}

export type CoinFlipEngineEvent =
  | { type: 'coinflip:betting'; payload: { roundId: number; serverSeedHash: string; bettingEndsInMs: number } }
  | { type: 'coinflip:revealed'; payload: { roundId: number; outcome: 'HEADS' | 'TAILS'; serverSeed: string; serverSeedHash: string; revealedAt: Date } };

export class CoinFlipEngine {
  private readonly store: Store;
  private readonly betManager: BetManager;
  private readonly operatorCode: string;
  private readonly randomSeed: () => string;
  private readonly clientSeeds: () => readonly string[];
  private readonly now: () => Date;
  private readonly onEvent: (event: CoinFlipEngineEvent) => void;
  private round: RoundRecord | null = null;
  private phase: 'BETTING' | 'REVEALED' = 'BETTING';
  private elapsedMs = 0;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: CoinFlipEngineDeps) {
    this.store = deps.store;
    this.betManager = deps.betManager;
    this.operatorCode = deps.operatorCode;
    this.randomSeed = deps.randomSeed ?? randomUUID;
    this.clientSeeds = deps.clientSeeds ?? (() => [
      'stratos_coin_1',
      'stratos_coin_2',
      'stratos_coin_3',
    ]);
    this.now = deps.now ?? (() => new Date());
    this.onEvent = deps.onEvent ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => { void this.tickOnce(50); }, 50);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tickOnce(afterMs = 0): Promise<void> {
    if (!this.running && afterMs === 0) return;
    this.elapsedMs += afterMs;
    if (this.round === null) {
      await this.openRound();
      return;
    }
    if (this.phase === 'BETTING' && this.elapsedMs >= COINFLIP_BETTING_WINDOW_MS) {
      await this.reveal();
    } else if (this.phase === 'REVEALED' && this.elapsedMs >= COINFLIP_BETTING_WINDOW_MS + COINFLIP_COOLDOWN_MS) {
      this.elapsedMs = 0;
      this.round = null;
      this.phase = 'BETTING';
    }
  }

  snapshot() {
    return {
      roundId: this.round?.id ?? null,
      phase: this.phase,
      elapsedMs: this.elapsedMs,
      outcome: this.round?.coinOutcome ?? null,
      serverSeedHash: this.round?.serverSeedHash ?? null,
    };
  }

  async placeBet(input: {
    session: SessionRecord;
    panel: 0 | 1;
    stake: bigint;
  }): Promise<BetRecord> {
    if (this.round === null) throw new Error('COINFLIP_NOT_OPEN');
    return this.betManager.place({
      round: this.round,
      session: input.session,
      panel: input.panel,
      stake: input.stake,
      autoCashout: null,
    });
  }

  async cancelBet(input: { session: SessionRecord; panel: 0 | 1 }): Promise<void> {
    if (this.round === null) throw new Error('COINFLIP_NOT_OPEN');
    await this.betManager.cancel({ round: this.round, session: input.session, panel: input.panel });
  }

  private async openRound(): Promise<void> {
    const serverSeed = this.randomSeed();
    const serverSeedHash = sha256Hex(serverSeed);
    const round = await this.store.createRound({
      operatorCode: this.operatorCode,
      gameId: 'coinflip',
      serverSeed,
      serverSeedHash,
      startedAt: this.now(),
    });
    this.round = round;
    this.phase = 'BETTING';
    this.elapsedMs = 0;
    this.onEvent({
      type: 'coinflip:betting',
      payload: { roundId: round.id, serverSeedHash, bettingEndsInMs: COINFLIP_BETTING_WINDOW_MS },
    });
  }

  private async reveal(): Promise<void> {
    if (this.round === null) return;
    const outcome = deriveCoinFlipOutcome(this.round.serverSeed, this.clientSeeds());
    await this.store.finishRound(this.round.id, {
      status: 'CRASHED',
      at: this.now(),
      coinOutcome: outcome,
    });
    this.round = { ...this.round, status: 'CRASHED', coinOutcome: outcome };
    await this.betManager.settleCoinFlip({ round: this.round, outcome });
    this.phase = 'REVEALED';
    this.elapsedMs = COINFLIP_BETTING_WINDOW_MS;
    this.onEvent({
      type: 'coinflip:revealed',
      payload: {
        roundId: this.round.id,
        outcome,
        serverSeed: this.round.serverSeed,
        serverSeedHash: this.round.serverSeedHash,
        revealedAt: this.now(),
      },
    });
  }
}
