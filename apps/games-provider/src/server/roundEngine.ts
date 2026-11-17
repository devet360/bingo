import type { BetRecord, RoundRecord, SessionRecord } from '../domain/types';
import {
  buildCombinedSeedInput,
  deriveCrashPointFromSha512Hex,
  elapsedMsForMultiplier,
  multiplierAtElapsedMs,
  sha256Hex,
  sha512Hex,
} from '../domain/provablyFair';
import type { Store } from './store';
import type { WalletClient } from './wallet';

/** Betting window, matching the prototype pacing. */
export const BETTING_WINDOW_MS = 5_500;
/** Engine loop cadence while flying; also the multiplier broadcast interval. */
export const FLIGHT_TICK_MS = 50;
/** How long the crashed result stays on screen before the next round opens. */
export const CRASHED_COOLDOWN_MS = 3_200;

export type RoundPhase = 'BETTING' | 'FLYING' | 'CRASHED';

export interface EngineLimits {
  minStake: bigint;
  maxStake: bigint;
  maxWin: bigint;
  maxBetsPerRound: number;
}

/**
 * Bet handling seam. Implemented by `BetManager` (Task 10); the engine only
 * decides *when* a round phase moves, never how a bet settles.
 */
export interface RoundBetManager {
  place(input: {
    round: RoundRecord;
    session: SessionRecord;
    panel: 0 | 1;
    stake: bigint;
    autoCashout: number | null;
  }): Promise<BetRecord>;
  cancel(input: { round: RoundRecord; session: SessionRecord; panel: 0 | 1 }): Promise<void>;
  cashout(input: {
    round: RoundRecord;
    session: SessionRecord;
    panel: 0 | 1;
    multiplier: number;
  }): Promise<void>;
  settleRound(input: { round: RoundRecord; maxWin: bigint }): Promise<void>;
  /**
   * Called on every FLYING tick, including the crash tick, before the tick event.
   * Optional so existing seams keep typechecking.
   */
  processAutoCashouts?(input: {
    round: RoundRecord;
    multiplier: number;
    elapsedMs: number;
  }): Promise<void>;
}

export type RoundEngineEvent =
  | {
      type: 'round:betting';
      payload: {
        roundId: number;
        serverSeedHash: string;
        clientSeeds: readonly string[];
        bettingEndsInMs: number;
      };
    }
  | {
      type: 'round:flying';
      payload: { roundId: number; serverSeedHash: string; multiplier: number; elapsedMs: number };
    }
  | { type: 'round:tick'; payload: { roundId: number; multiplier: number; elapsedMs: number } }
  | {
      type: 'round:crashed';
      payload: {
        roundId: number;
        crashPoint: number;
        serverSeed: string;
        serverSeedHash: string;
        clientSeedComposite: string | null;
        crashedAt: Date;
      };
    };

/**
 * Live snapshot. The crash point and the server seed stay `null` until the
 * round is CRASHED, so a reconnect can never leak the outcome.
 */
export interface RoundSnapshot {
  roundId: number | null;
  phase: RoundPhase;
  multiplier: number;
  elapsedMs: number;
  bettingEndsInMs: number;
  players: readonly unknown[];
  crashPoint: number | null;
  serverSeed: string | null;
  serverSeedHash: string | null;
  clientSeedComposite: string | null;
}

export interface PlaceBetInput {
  session: SessionRecord;
  panel: 0 | 1;
  stake: bigint;
  autoCashout?: number | null;
}

export interface CancelBetInput {
  session: SessionRecord;
  panel: 0 | 1;
}

export interface CashoutInput {
  session: SessionRecord;
  panel: 0 | 1;
}

export interface RoundEngineDeps {
  store: Store;
  wallet: WalletClient;
  limits: EngineLimits;
  operatorCode: string;
  /** Server seed for the next round; injectable for tests. */
  randomSeed: () => string;
  /** The three public client seeds in play, frozen when the round opens. */
  clientSeeds: () => readonly string[];
  onEvent: (event: RoundEngineEvent) => void;
  /** Timestamp source for persisted rows. Defaults to the real clock. */
  now?: () => Date;
  betManager?: RoundBetManager;
}

/**
 * Crash round engine.
 *
 * Persistence-first: every phase transition awaits the store write before the
 * matching `onEvent` call, so a client can never see a phase the database has
 * not committed.
 *
 * Time is an internal monotonic clock (`clockMs`). `tickOnce(afterMs)` advances
 * it and evaluates the phase machine; production schedules the same evaluation
 * from `setInterval` every `FLIGHT_TICK_MS`, deriving the advance from the
 * wall clock. Phase math therefore never depends on `Date.now()` advancing.
 */
export class RoundEngine {
  private readonly store: Store;
  private readonly limits: EngineLimits;
  private readonly randomSeed: () => string;
  private readonly clientSeedsProvider: () => readonly string[];
  private readonly onEvent: (event: RoundEngineEvent) => void;
  private readonly now: () => Date;
  private readonly betManager: RoundBetManager | undefined;
  // Consumed by the bet manager delegation (Task 10).
  private readonly wallet: WalletClient;

  readonly operatorCode: string;

  private phase: RoundPhase = 'BETTING';
  private round: RoundRecord | null = null;
  private roundClientSeeds: readonly string[] = [];
  private multiplier = 1;
  /** Engine-monotonic elapsed time in ms, advanced only by ticks. */
  private clockMs = 0;
  private phaseStartedAtMs = 0;

  private running = false;
  private wallStartedAtMs = 0;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  /** Serialises evaluations so an overlapping timer tick cannot interleave phases. */
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: RoundEngineDeps) {
    this.store = deps.store;
    this.wallet = deps.wallet;
    this.limits = deps.limits;
    this.operatorCode = deps.operatorCode;
    this.randomSeed = deps.randomSeed;
    this.clientSeedsProvider = deps.clientSeeds;
    this.onEvent = deps.onEvent;
    this.now = deps.now ?? (() => new Date());
    this.betManager = deps.betManager;
  }

  /** Schedules the loop. Idempotent; the first round opens on the first tick. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Rebase the wall clock onto the engine clock: `onTimer` derives its advance
    // from `wallElapsed - clockMs`, so without this a stop→start would stall for
    // as long as the engine had already run. A fresh engine has `clockMs === 0`,
    // which leaves the old behaviour untouched.
    this.wallStartedAtMs = this.now().getTime() - this.clockMs;
    this.loopTimer = setInterval(() => this.onTimer(), FLIGHT_TICK_MS);
  }

  /** Clears the timer chain. Safe to call more than once. */
  stop(): void {
    this.running = false;
    if (this.loopTimer !== null) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
  }

  /**
   * Advances the engine clock by `afterMs` and evaluates phase transitions.
   * Production drives this from the timer; tests drive it directly.
   */
  async tickOnce(afterMs = 0): Promise<void> {
    this.clockMs += Number.isFinite(afterMs) && afterMs > 0 ? afterMs : 0;
    const run = this.queue.then(() => this.advance());
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** FLYING duration of the current round, derived from its crash point. */
  currentFlightMs(): number {
    const crashPoint = this.round?.crashPoint;
    return crashPoint === null || crashPoint === undefined
      ? 0
      : elapsedMsForMultiplier(crashPoint);
  }

  snapshot(): RoundSnapshot {
    const isFlying = this.round !== null && this.phase === 'FLYING';
    const isCrashed = this.round !== null && this.phase === 'CRASHED';
    const bettingEndsInMs =
      this.round === null
        ? BETTING_WINDOW_MS
        : this.phase === 'BETTING'
          ? Math.max(0, BETTING_WINDOW_MS - this.phaseElapsedMs())
          : 0;

    return {
      roundId: this.round?.id ?? null,
      phase: this.phase,
      multiplier: this.multiplier,
      elapsedMs: isFlying ? this.phaseElapsedMs() : 0,
      bettingEndsInMs,
      players: [],
      crashPoint: isCrashed ? (this.round?.crashPoint ?? null) : null,
      serverSeed: isCrashed ? (this.round?.serverSeed ?? null) : null,
      serverSeedHash: isCrashed ? (this.round?.serverSeedHash ?? null) : null,
      clientSeedComposite: isCrashed ? (this.round?.clientSeedComposite ?? null) : null,
    };
  }

  async placeBet(input: PlaceBetInput): Promise<BetRecord> {
    if (!this.betManager) throw new Error('bet handling not wired');
    return this.betManager.place({
      round: this.requireRound(),
      session: input.session,
      panel: input.panel,
      stake: input.stake,
      autoCashout: input.autoCashout ?? null,
    });
  }

  async cancelBet(input: CancelBetInput): Promise<void> {
    if (!this.betManager) throw new Error('bet handling not wired');
    await this.betManager.cancel({
      round: this.requireRound(),
      session: input.session,
      panel: input.panel,
    });
  }

  async cashout(input: CashoutInput): Promise<void> {
    if (!this.betManager) throw new Error('bet handling not wired');
    await this.betManager.cashout({
      round: this.requireRound(),
      session: input.session,
      panel: input.panel,
      multiplier: this.multiplier,
    });
  }

  private onTimer(): void {
    const wallElapsedMs = this.now().getTime() - this.wallStartedAtMs;
    const advanceMs = Math.max(0, wallElapsedMs - this.clockMs);
    void this.tickOnce(advanceMs).catch((error: unknown) => {
      console.error('round engine tick failed', error);
    });
  }

  private phaseElapsedMs(): number {
    return this.clockMs - this.phaseStartedAtMs;
  }

  private requireRound(): RoundRecord {
    if (this.round === null) throw new Error('no round is open');
    return this.round;
  }

  /** Drives the phase machine until it is waiting for the next tick. */
  private async advance(): Promise<void> {
    for (;;) {
      if (this.round === null) {
        await this.beginRound();
      }
      if (this.phase === 'BETTING' && this.phaseElapsedMs() >= BETTING_WINDOW_MS) {
        await this.takeoff();
        continue;
      }
      if (this.phase === 'FLYING') {
        const round = this.round;
        const crashPoint = round?.crashPoint ?? null;
        if (round === null || crashPoint === null) return;
        const elapsedMs = this.phaseElapsedMs();
        // Computed before the crash check so the auto-cashout sweep also runs on
        // the crash tick with the final multiplier, exactly like the prototype;
        // the sweep itself guards `autoCashout < round.crashPoint`.
        const multiplier = multiplierAtElapsedMs(elapsedMs);
        if (elapsedMs > 0 && this.betManager?.processAutoCashouts) {
          try {
            await this.betManager.processAutoCashouts({ round, multiplier, elapsedMs });
          } catch (error) {
            // A sweep failure must not stop the loop or hide the crash.
            console.error('auto cashout sweep failed', error);
          }
        }
        if (elapsedMs >= elapsedMsForMultiplier(crashPoint)) {
          await this.crash(crashPoint);
          continue;
        }
        this.multiplier = multiplier;
        // Elapsed 0 is the takeoff instant, already covered by `round:flying`.
        if (elapsedMs > 0) {
          this.onEvent({
            type: 'round:tick',
            payload: { roundId: round.id, multiplier, elapsedMs },
          });
        }
        return;
      }
      if (this.phase === 'CRASHED' && this.phaseElapsedMs() >= CRASHED_COOLDOWN_MS) {
        await this.beginRound();
        continue;
      }
      return;
    }
  }

  private async beginRound(): Promise<void> {
    const serverSeed = this.randomSeed();
    const serverSeedHash = sha256Hex(serverSeed);
    const startedAt = this.now();
    // Commit before announcing: the row id comes from the store, never a counter.
    const round = await this.store.createRound({ serverSeed, serverSeedHash, startedAt });

    this.round = round;
    this.roundClientSeeds = [...this.clientSeedsProvider()];
    this.phase = 'BETTING';
    this.phaseStartedAtMs = this.clockMs;
    this.multiplier = 1;

    this.onEvent({
      type: 'round:betting',
      payload: {
        roundId: round.id,
        serverSeedHash,
        clientSeeds: this.roundClientSeeds,
        bettingEndsInMs: BETTING_WINDOW_MS,
      },
    });
  }

  private async takeoff(): Promise<void> {
    const round = this.round;
    if (round === null) return;

    const clientSeedComposite = this.roundClientSeeds.join(':');
    const crashPoint = deriveCrashPointFromSha512Hex(
      sha512Hex(buildCombinedSeedInput(round.serverSeed, this.roundClientSeeds)),
    ).crashPoint;
    const flewAt = this.now();
    // The crash point is committed before it is announced.
    await this.store.startFlight(round.id, { crashPoint, clientSeedComposite, at: flewAt });

    this.round = {
      ...round,
      clientSeedComposite,
      crashPoint,
      status: 'FLYING',
      flewAt,
    };
    this.phase = 'FLYING';
    this.phaseStartedAtMs = this.clockMs;
    this.multiplier = 1;

    this.onEvent({
      type: 'round:flying',
      payload: {
        roundId: round.id,
        serverSeedHash: round.serverSeedHash,
        multiplier: this.multiplier,
        elapsedMs: 0,
      },
    });
  }

  private async crash(crashPoint: number): Promise<void> {
    const round = this.round;
    if (round === null) return;

    const crashedAt = this.now();
    // The result is committed before it is announced.
    await this.store.finishRound(round.id, { status: 'CRASHED', at: crashedAt });
    const crashedRound: RoundRecord = { ...round, status: 'CRASHED', crashPoint, crashedAt };

    this.round = crashedRound;
    this.phase = 'CRASHED';
    this.phaseStartedAtMs = this.clockMs;
    this.multiplier = crashPoint;

    this.onEvent({
      type: 'round:crashed',
      payload: {
        roundId: round.id,
        crashPoint,
        serverSeed: round.serverSeed,
        serverSeedHash: round.serverSeedHash,
        clientSeedComposite: round.clientSeedComposite,
        crashedAt,
      },
    });

    // Settlement only marks leftover ACTIVE bets LOST -- a DB-only update, since the
    // stake was already debited at placement. A settlement failure must therefore
    // never freeze the loop (which would re-run this path on every tick) or hide the
    // crash broadcast; the leftovers stay recoverable via `listUnsettledBets()` and
    // boot recovery.
    if (this.betManager) {
      try {
        await this.betManager.settleRound({ round: crashedRound, maxWin: this.limits.maxWin });
      } catch (error) {
        console.error('round settle failed', error);
      }
    }
  }
}
