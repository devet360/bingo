import { AccountCode, AccountOwnerKind, LedgerKind, type Prisma } from '@prisma/client';
import { AppError, Errors } from '../lib/errors';

export interface LedgerInstruction {
  ownerKind: AccountOwnerKind;
  ownerId: string;
  code: AccountCode;
  /** Signed: positive credits the account, negative debits it. */
  delta: bigint;
}

export interface PostLedgerInput {
  idempotencyKey: string;
  kind: LedgerKind;
  refType?: string;
  refId?: string;
  memo?: string;
  createdById?: string;
  instructions: LedgerInstruction[];
}

export interface LedgerAccountBalance {
  ownerKind: AccountOwnerKind;
  ownerId: string;
  code: AccountCode;
  accountId: string;
  balanceAfter: bigint;
}

export interface PostLedgerResult {
  ledgerId: string;
  replayed: boolean;
  balances: LedgerAccountBalance[];
}

const ALLOWED_CODES: Record<AccountOwnerKind, AccountCode[]> = {
  USER: [AccountCode.AVAILABLE, AccountCode.ESCROW, AccountCode.LOCKED],
  AGENT: [AccountCode.FLOAT, AccountCode.FLOAT_ESCROW, AccountCode.COMMISSION],
  PLATFORM: [
    AccountCode.RAKE,
    AccountCode.COMMISSION_EXPENSE,
    AccountCode.TREASURY,
    AccountCode.SUSPENSE,
  ],
};

// Bridge and expense accounts carry legitimate debit (negative) balances.
const MAY_GO_NEGATIVE: ReadonlySet<AccountCode> = new Set([
  AccountCode.SUSPENSE,
  AccountCode.COMMISSION_EXPENSE,
]);

type Bucket =
  | 'available'
  | 'escrow'
  | 'locked'
  | 'floatAvailable'
  | 'floatEscrow'
  | 'commissionEarned';

const BUCKETS: Partial<Record<AccountCode, Bucket>> = {
  [AccountCode.AVAILABLE]: 'available',
  [AccountCode.ESCROW]: 'escrow',
  [AccountCode.LOCKED]: 'locked',
  [AccountCode.FLOAT]: 'floatAvailable',
  [AccountCode.FLOAT_ESCROW]: 'floatEscrow',
  [AccountCode.COMMISSION]: 'commissionEarned',
};

function accountKey(instruction: LedgerInstruction): string {
  return `${instruction.ownerKind}:${instruction.ownerId}:${instruction.code}`;
}

/**
 * Posts one balanced double-entry journal inside an existing transaction.
 *
 * Ordering matters for correctness:
 *  1. ensure every chart-of-accounts row exists
 *  2. take FOR UPDATE row locks in ascending account id order (deadlock-free)
 *  3. only then check the idempotency key, so a concurrent duplicate that was
 *     blocked on our locks is guaranteed to see the committed journal
 *  4. write journal + cache balances in the same transaction
 */
export async function postLedger(
  tx: Prisma.TransactionClient,
  input: PostLedgerInput,
): Promise<PostLedgerResult> {
  const merged = new Map<string, LedgerInstruction>();

  for (const instruction of input.instructions) {
    if (instruction.delta === 0n) continue;
    if (!ALLOWED_CODES[instruction.ownerKind].includes(instruction.code)) {
      throw new AppError(
        500,
        'LEDGER_ACCOUNT_MISMATCH',
        `${instruction.code} is not a valid ${instruction.ownerKind} account`,
      );
    }
    const key = accountKey(instruction);
    const current = merged.get(key);
    if (current) current.delta += instruction.delta;
    else merged.set(key, { ...instruction });
  }

  const instructions = [...merged.values()].filter((instruction) => instruction.delta !== 0n);
  if (instructions.length === 0) {
    throw new AppError(500, 'LEDGER_EMPTY', 'Ledger transaction has no postings');
  }

  const total = instructions.reduce((sum, instruction) => sum + instruction.delta, 0n);
  if (total !== 0n) {
    throw new AppError(500, 'LEDGER_UNBALANCED', `Journal does not net to zero (${total})`);
  }

  // 1. chart of accounts
  const resolved: Array<LedgerInstruction & { accountId: string }> = [];
  for (const instruction of instructions) {
    const account = await tx.ledgerAccount.upsert({
      where: {
        ownerKind_ownerId_code: {
          ownerKind: instruction.ownerKind,
          ownerId: instruction.ownerId,
          code: instruction.code,
        },
      },
      create: {
        ownerKind: instruction.ownerKind,
        ownerId: instruction.ownerId,
        code: instruction.code,
      },
      update: {},
      select: { id: true },
    });
    resolved.push({ ...instruction, accountId: account.id });
  }

  // 2. deterministic lock order
  const locked = [...resolved].sort((a, b) => a.accountId.localeCompare(b.accountId));
  const balances = new Map<string, bigint>();
  for (const item of locked) {
    const rows = await tx.$queryRaw<Array<{ id: string; balance: bigint }>>`
      SELECT "id", "balance" FROM "LedgerAccount" WHERE "id" = ${item.accountId}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new AppError(500, 'LEDGER_ACCOUNT_MISSING', 'Chart of accounts row disappeared');
    balances.set(item.accountId, row.balance);
  }

  // 3. idempotency, evaluated after the locks
  const existing = await tx.transactionLedger.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });
  if (existing) {
    return { ledgerId: existing.id, replayed: true, balances: [] };
  }

  // 4. apply
  const entries: Array<LedgerInstruction & { accountId: string; balanceAfter: bigint }> = [];
  for (const item of locked) {
    const before = balances.get(item.accountId)!;
    const after = before + item.delta;
    if (after < 0n && !MAY_GO_NEGATIVE.has(item.code)) {
      throw Errors.insufficientFunds(
        item.code === AccountCode.FLOAT ? 'agent float' : item.code.toLowerCase(),
        before,
        -item.delta,
      );
    }
    entries.push({ ...item, balanceAfter: after });
  }

  for (const entry of entries) {
    await tx.ledgerAccount.update({
      where: { id: entry.accountId },
      data: { balance: entry.balanceAfter, version: { increment: 1 } },
    });
  }

  const ledger = await tx.transactionLedger.create({
    data: {
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      refType: input.refType,
      refId: input.refId,
      memo: input.memo,
      createdById: input.createdById,
      entries: {
        create: entries.map((entry) => ({
          accountId: entry.accountId,
          amount: entry.delta,
          balanceAfter: entry.balanceAfter,
        })),
      },
    },
    select: { id: true },
  });

  await applyBalanceCaches(tx, entries);

  return {
    ledgerId: ledger.id,
    replayed: false,
    balances: entries.map((entry) => ({
      ownerKind: entry.ownerKind,
      ownerId: entry.ownerId,
      code: entry.code,
      accountId: entry.accountId,
      balanceAfter: entry.balanceAfter,
    })),
  };
}

async function applyBalanceCaches(
  tx: Prisma.TransactionClient,
  entries: Array<LedgerInstruction & { accountId: string; balanceAfter: bigint }>,
): Promise<void> {
  const walletDeltas = new Map<string, Partial<Record<Bucket, bigint>>>();
  const agentDeltas = new Map<string, Partial<Record<Bucket, bigint>>>();

  for (const entry of entries) {
    const bucket = BUCKETS[entry.code];
    if (!bucket) continue;

    if (entry.ownerKind === AccountOwnerKind.USER) {
      const deltas = walletDeltas.get(entry.ownerId) ?? {};
      deltas[bucket] = (deltas[bucket] ?? 0n) + entry.delta;
      walletDeltas.set(entry.ownerId, deltas);
    } else if (entry.ownerKind === AccountOwnerKind.AGENT) {
      const deltas = agentDeltas.get(entry.ownerId) ?? {};
      deltas[bucket] = (deltas[bucket] ?? 0n) + entry.delta;
      agentDeltas.set(entry.ownerId, deltas);
    }
  }

  for (const [userId, deltas] of walletDeltas) {
    const result = await tx.wallet.updateMany({
      where: { userId },
      data: {
        version: { increment: 1 },
        ...(deltas.available ? { available: { increment: deltas.available } } : {}),
        ...(deltas.escrow ? { escrow: { increment: deltas.escrow } } : {}),
        ...(deltas.locked ? { locked: { increment: deltas.locked } } : {}),
      },
    });
    if (result.count !== 1) {
      throw new AppError(500, 'WALLET_NOT_PROVISIONED', `Wallet missing for user ${userId}`);
    }
  }

  for (const [agentProfileId, deltas] of agentDeltas) {
    const result = await tx.agentProfile.updateMany({
      where: { id: agentProfileId },
      data: {
        version: { increment: 1 },
        ...(deltas.floatAvailable ? { floatAvailable: { increment: deltas.floatAvailable } } : {}),
        ...(deltas.floatEscrow ? { floatEscrow: { increment: deltas.floatEscrow } } : {}),
        ...(deltas.commissionEarned
          ? { commissionEarned: { increment: deltas.commissionEarned } }
          : {}),
      },
    });
    if (result.count !== 1) {
      throw new AppError(500, 'AGENT_NOT_PROVISIONED', `Agent profile missing for ${agentProfileId}`);
    }
  }
}
