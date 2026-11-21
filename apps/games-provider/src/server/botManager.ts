import { createHash } from 'node:crypto';
import type { BotConfig } from '../domain/types';

export interface BotParticipant {
  id: string;
  isBot: true;
  stake: bigint;
  cashout: number;
  payout: bigint;
  won: boolean;
  disclose: boolean;
}

export class BotManager {
  private roundPayout = new Map<number, bigint>();
  private dayPayout = new Map<string, bigint>();

  constructor(private config: BotConfig) {}

  updateConfig(config: BotConfig): void {
    this.config = config;
  }

  participants(roundId: number, seed: string): BotParticipant[] {
    if (!this.config.enabled || this.config.count <= 0) return [];
    const participants: BotParticipant[] = [];
    for (let i = 0; i < this.config.count; i++) {
      const digest = createHash('sha256').update(`${roundId}:${seed}:${i}`).digest();
      const stakeSpan = this.config.stakeMax - this.config.stakeMin + 1n;
      const stake = this.config.stakeMin + BigInt(digest.readUInt32BE(0)) % stakeSpan;
      const cashout = 100 + (digest.readUInt32BE(4) % 900);
      participants.push({
        id: `bot-${roundId}-${i}`,
        isBot: true,
        stake,
        cashout: cashout / 100,
        payout: 0n,
        won: false,
        disclose: this.config.disclose,
      });
    }
    return participants;
  }

  settle(roundId: number, seed: string, crashPoint: number, now = new Date(), disclosed = this.config.disclose): BotParticipant[] {
    const day = now.toISOString().slice(0, 10);
    let roundTotal = this.roundPayout.get(roundId) ?? 0n;
    let dayTotal = this.dayPayout.get(day) ?? 0n;
    return this.participants(roundId, seed).map((participant) => {
      if (participant.cashout >= crashPoint) return participant;
      const payout = participant.stake * BigInt(Math.floor(participant.cashout * 100)) / 100n;
      if (
        roundTotal + payout > this.config.roundPayoutCap ||
        dayTotal + payout > this.config.dayPayoutCap
      ) {
        return participant;
      }
      roundTotal += payout;
      dayTotal += payout;
      this.roundPayout.set(roundId, roundTotal);
      this.dayPayout.set(day, dayTotal);
      return { ...participant, payout, won: true, disclose: disclosed };
    });
  }

  roundPayouts(roundId: number): bigint {
    return this.roundPayout.get(roundId) ?? 0n;
  }

  dayPayouts(day: string): bigint {
    return this.dayPayout.get(day) ?? 0n;
  }
}
