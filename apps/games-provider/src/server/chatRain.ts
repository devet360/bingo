import { randomUUID } from 'node:crypto';
import type { ChatMessageRecord, RainEventRecord, SessionRecord } from '../domain/types';

export interface ChatRainConfig {
  enabled: boolean;
  maxMessageLength: number;
  rateLimitPerMinute: number;
  blockedPatterns: readonly string[];
  retentionDays: number;
}

export class ChatRainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ChatRainError';
  }
}

export class ChatRainManager {
  private readonly messages = new Map<string, ChatMessageRecord[]>();
  private readonly rains = new Map<string, RainEventRecord>();
  private readonly muted = new Map<string, Date>();
  private readonly banned = new Set<string>();
  private readonly rate = new Map<string, { at: number; count: number }>();

  constructor(
    private readonly config: ChatRainConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  mute(operatorCode: string, sessionToken: string, until: Date): void {
    this.muted.set(`${operatorCode}:${sessionToken}`, until);
  }

  ban(operatorCode: string, sessionToken: string): void {
    this.banned.add(`${operatorCode}:${sessionToken}`);
  }

  post(input: {
    operatorCode: string;
    roomId: string;
    session: SessionRecord;
    body: string;
  }): ChatMessageRecord {
    if (!this.config.enabled) throw new ChatRainError('CHAT_DISABLED', 'Chat is disabled');
    if (this.banned.has(`${input.operatorCode}:${input.session.token}`)) {
      throw new ChatRainError('CHAT_BANNED', 'You are banned from chat');
    }
    const mutedUntil = this.muted.get(`${input.operatorCode}:${input.session.token}`);
    if (mutedUntil && mutedUntil.getTime() > this.now().getTime()) {
      throw new ChatRainError('CHAT_MUTED', 'You are temporarily muted');
    }
    const body = input.body.trim();
    if (body.length === 0) throw new ChatRainError('CHAT_EMPTY', 'Message is empty');
    if (body.length > this.config.maxMessageLength) {
      throw new ChatRainError('CHAT_TOO_LONG', 'Message is too long');
    }
    for (const pattern of this.config.blockedPatterns) {
      if (pattern && new RegExp(pattern, 'i').test(body)) {
        throw new ChatRainError('CHAT_FILTERED', 'Message contains a blocked word');
      }
    }
    const key = `${input.operatorCode}:${input.session.token}`;
    const minute = Math.floor(this.now().getTime() / 60_000);
    const prior = this.rate.get(key);
    if (prior?.at === minute) {
      if (prior.count >= this.config.rateLimitPerMinute) {
        throw new ChatRainError('CHAT_RATE_LIMIT', 'Send fewer messages');
      }
      prior.count++;
    } else {
      this.rate.set(key, { at: minute, count: 1 });
    }
    const row: ChatMessageRecord = {
      id: randomUUID(),
      operatorCode: input.operatorCode,
      roomId: input.roomId,
      sessionToken: input.session.token,
      body,
      isBot: false,
      createdAt: this.now(),
    };
    const roomKey = `${input.operatorCode}:${input.roomId}`;
    const rows = this.messages.get(roomKey) ?? [];
    rows.push(row);
    const cutoff = this.now().getTime() - this.config.retentionDays * 86_400_000;
    this.messages.set(roomKey, rows.filter((item) => item.createdAt.getTime() >= cutoff).slice(-200));
    return row;
  }

  recent(operatorCode: string, roomId: string): ChatMessageRecord[] {
    const cutoff = this.now().getTime() - this.config.retentionDays * 86_400_000;
    return (this.messages.get(`${operatorCode}:${roomId}`) ?? [])
      .filter((item) => item.createdAt.getTime() >= cutoff);
  }

  async rain(input: {
    operatorCode: string;
    amount: bigint;
    recipients: readonly SessionRecord[];
    expiresAt: Date;
    fund: (event: {
      operatorCode: string;
      fundingId: string;
      amount: bigint;
      recipients: readonly string[];
    }) => Promise<{ fundingId: string }>;
  }): Promise<RainEventRecord> {
    const eligible = [...new Map(input.recipients.map((session) => [session.token, session])).values()]
      .filter((session) => session.status === 'OPEN' && session.operatorCode === input.operatorCode);
    if (eligible.length === 0) throw new ChatRainError('RAIN_NO_ELIGIBLE_PLAYERS', 'No eligible players');
    if (eligible.length > input.recipients.length) throw new ChatRainError('RAIN_DUPLICATE_RECIPIENT', 'Recipients are duplicated');
    if (input.amount <= 0n) throw new ChatRainError('RAIN_AMOUNT_INVALID', 'Rain amount must be positive');
    const row: RainEventRecord = {
      id: randomUUID(),
      operatorCode: input.operatorCode,
      amount: input.amount,
      recipientCount: eligible.length,
      expiresAt: input.expiresAt,
      fundingId: null,
      status: 'PENDING',
      createdAt: this.now(),
    };
    this.rains.set(row.id, row);
    try {
      const funded = await input.fund({
        operatorCode: input.operatorCode,
        fundingId: row.id,
        amount: input.amount * BigInt(eligible.length),
        recipients: eligible.map((session) => session.token),
      });
      const fundedRow = { ...row, fundingId: funded.fundingId, status: 'FUNDED' as const };
      this.rains.set(row.id, fundedRow);
      return fundedRow;
    } catch (error) {
      const cancelled = { ...row, status: 'CANCELLED' as const };
      this.rains.set(row.id, cancelled);
      throw new ChatRainError('RAIN_FUNDING_FAILED', error instanceof Error ? error.message : 'Rain funding failed');
    }
  }

  rainEvent(id: string): RainEventRecord | null {
    return this.rains.get(id) ?? null;
  }
}
