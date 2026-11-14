import { EventEmitter } from 'node:events';
import type { RoundStatus } from '@prisma/client';

export interface SettlementWinner {
  userId: string;
  cardId: string;
  pattern: string;
  payout: string;
}

export interface WalletSnapshot {
  available: string;
  escrow: string;
  locked: string;
}

export type BingoEvent =
  | { type: 'state'; roomId: string; roundId: string; status: RoundStatus }
  | {
      type: 'ball';
      roomId: string;
      roundId: string;
      ball: number;
      index: number;
      drawnCount: number;
      status: RoundStatus;
    }
  | {
      type: 'claiming';
      roomId: string;
      roundId: string;
      claimsCloseAt: Date;
      detectedWinners: number;
    }
  | {
      type: 'settled';
      roomId: string;
      roundId: string;
      winners: SettlementWinner[];
      rake: string;
      prizePool: string;
      serverSeed: string;
    }
  | { type: 'cancelled'; roomId: string; roundId: string; reason: string }
  | { type: 'wallet'; userId: string; wallet: WalletSnapshot };

/**
 * In-process fan-out from the engine to the socket gateway. The gateway owns
 * sockets; services only publish facts after their transactions commit.
 */
class BingoEventBus extends EventEmitter {
  publish(event: BingoEvent): void {
    this.emit('event', event);
  }

  subscribe(listener: (event: BingoEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

export const bingoEvents = new BingoEventBus();
