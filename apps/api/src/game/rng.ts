import { createHash, createHmac, randomBytes } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacSha256Hex(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

export function generateServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function computeSeedHash(serverSeed: string): string {
  return sha256Hex(serverSeed);
}

/**
 * Aggregate player entropy. Seeds are deduplicated per player upstream; the
 * sorted join makes the result independent of join order.
 */
export function aggregateClientSeed(seeds: string[]): string {
  if (seeds.length === 0) return sha256Hex('');
  return sha256Hex([...seeds].sort().join(':'));
}

export interface DeriveBallOrderInput {
  serverSeed: string;
  clientSeed: string | null;
  nonce: number;
  ballMax: number;
}

/**
 * Commit-reveal draw order.
 *
 *   finalSeed = HMAC_SHA256(key = serverSeed, msg = `${clientSeed}:${nonce}`)
 *   stream    = HMAC_SHA256(key = finalSeed, msg = `${counter++}`) -> 8 uint32 chunks
 *   shuffle   = Fisher-Yates over [1..ballMax] with rejection sampling
 *
 * Everything here is pure, so any client can recompute the order from the
 * revealed serverSeed once the round is complete.
 */
export function deriveBallOrder(input: DeriveBallOrderInput): number[] {
  if (!Number.isInteger(input.ballMax) || input.ballMax < 2) {
    throw new Error('ballMax must be an integer >= 2');
  }
  if (!Number.isInteger(input.nonce) || input.nonce < 0) {
    throw new Error('nonce must be a non-negative integer');
  }

  const finalSeed = hmacSha256Hex(input.serverSeed, `${input.clientSeed ?? ''}:${input.nonce}`);
  const stream = createUint32Stream(finalSeed);
  const balls = Array.from({ length: input.ballMax }, (_, index) => index + 1);

  for (let i = balls.length - 1; i > 0; i -= 1) {
    const j = stream.nextInt(i + 1);
    const swap = balls[i]!;
    balls[i] = balls[j]!;
    balls[j] = swap;
  }
  return balls;
}

function createUint32Stream(key: string): { nextInt(bound: number): number } {
  let counter = 0;
  let buffer: number[] = [];

  const refill = (): void => {
    const digest = createHmac('sha256', key)
      .update(String(counter), 'utf8')
      .digest();
    counter += 1;
    for (let offset = 0; offset < digest.length; offset += 4) {
      buffer.push(digest.readUInt32BE(offset));
    }
  };

  const nextUint32 = (): number => {
    if (buffer.length === 0) refill();
    return buffer.shift()!;
  };

  return {
    nextInt(bound: number): number {
      if (!Number.isInteger(bound) || bound <= 0 || bound > 0x1_0000_0000) {
        throw new Error('bound must be in (0, 2^32]');
      }
      const limit = Math.floor(0x1_0000_0000 / bound) * bound;
      let value = nextUint32();
      while (value >= limit) value = nextUint32();
      return value % bound;
    },
  };
}
