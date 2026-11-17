export const DEFAULT_SEEDS = [
  'stratos_slot_1_00000001',
  'stratos_slot_2_00000002',
  'stratos_slot_3_00000003',
] as const;

const TWO_POW_52 = 4503599627370496;

export function multiplierAtElapsedMs(elapsedMs: number): number {
  if (elapsedMs <= 0) return 1.0;
  return Math.max(1.0, Math.floor(Math.exp(0.00006 * elapsedMs) * 100) / 100);
}

export interface ProofPayload {
  roundId: number;
  serverSeed: string;
  serverSeedHash: string;
  clientSeedComposite: string | null;
  crashPoint: number;
}

export interface VerifyResult {
  serverSeedHashComputed: string;
  serverSeedHashMatches: boolean;
  combinedInput: string;
  sha512Hash: string;
  hexSlice52Bit: string;
  decimalValue: number;
  computedCrashPoint: number;
  crashPointMatches: boolean;
}

async function digestHex(algorithm: 'SHA-256' | 'SHA-512', input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = new Uint8Array(await crypto.subtle.digest(algorithm, data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function crashPointFromDecimal(decimalValue: number): number {
  if (!Number.isFinite(decimalValue)) return 1.0;
  if (decimalValue % 33 === 0) return 1.0;
  const raw = Math.floor((100 * TWO_POW_52 - decimalValue) / (TWO_POW_52 - decimalValue)) / 100;
  return Math.max(1.0, Math.min(raw, 100_000.0));
}

export async function verifyProof(proof: ProofPayload): Promise<VerifyResult> {
  const serverSeedHashComputed = await digestHex('SHA-256', proof.serverSeed);
  const combinedInput = `${proof.serverSeed}:${proof.clientSeedComposite ?? DEFAULT_SEEDS.join(':')}`;
  const sha512Hash = await digestHex('SHA-512', combinedInput);
  const hexSlice52Bit = sha512Hash.slice(0, 13);
  const decimalValue = Number.parseInt(hexSlice52Bit, 16);
  const computedCrashPoint = crashPointFromDecimal(decimalValue);
  return {
    serverSeedHashComputed,
    serverSeedHashMatches: serverSeedHashComputed.toLowerCase() === proof.serverSeedHash.toLowerCase(),
    combinedInput,
    sha512Hash,
    hexSlice52Bit,
    decimalValue,
    computedCrashPoint,
    crashPointMatches: Math.abs(computedCrashPoint - proof.crashPoint) < 0.001,
  };
}
