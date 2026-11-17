'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  cancelWithdrawal,
  confirmCashReceived,
  createDeposit,
  createWithdrawal,
  fetchDeposit,
  fetchDepositLimits,
  fetchDepositProviders,
  fetchDeposits,
  fetchPayoutAccounts,
  fetchTransactions,
  fetchWithdrawalProofs,
  fetchWithdrawals,
  newIdempotencyKey,
  verifyDepositReceipt,
} from '@/lib/api';
import {
  creditsToMinor,
  formatCredits,
  formatDateTime,
  formatStake,
  minorToCreditsInput,
  providerLabel,
  timeAgo,
} from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { confirmAction, haptic } from '@/lib/telegram';
import { useSession } from '@/components/session';
import {
  Button,
  CopyButton,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Pill,
  Spinner,
  Tabs,
  cn,
} from '@/components/ui';
import type {
  Deposit,
  DepositLimits,
  DepositProvider,
  DepositStatus,
  PaymentMethod,
  PayoutAccount,
  TransactionLine,
  VerificationStatus,
  Withdrawal,
  WithdrawalProof,
  WithdrawalStatus,
} from '@/lib/types';

type Tab = 'deposit' | 'withdraw' | 'history';
type ActivitySection = 'bets' | 'finances';
type BetFilter = 'all' | 'won' | 'lost';
type FinanceFilter = 'all' | 'deposits' | 'withdrawals' | 'bonuses';

const QUICK_AMOUNTS = ['50', '100', '250', '500', '1000', '5000'];
const DEFAULT_MIN_DEPOSIT_MINOR = 1000n;
const LOW_BALANCE_MINOR = 5000n;
const LOW_BALANCE_KEY = 'bingo.lowBalanceDismissed.v1';

const STATUS_TONE: Record<string, 'mint' | 'gold' | 'warn' | 'danger' | 'neutral'> = {
  PENDING: 'warn',
  PROCESSING: 'gold',
  ESCROWED: 'gold',
  CREDITED: 'mint',
  PAID: 'mint',
  REJECTED: 'danger',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
};

const VERIFICATION_TONE: Record<VerificationStatus, 'mint' | 'gold' | 'warn' | 'danger' | 'neutral' | 'blue'> = {
  NOT_REQUIRED: 'neutral',
  PENDING: 'gold',
  VERIFIED: 'mint',
  FAILED: 'danger',
  MANUAL: 'blue',
};

const BET_KINDS = new Set(['CARD_PURCHASE', 'ROUND_PAYOUT', 'ROUND_REFUND', 'PROVIDER_BET', 'PROVIDER_WIN']);

function isWinningBet(kind: string): boolean {
  return kind === 'ROUND_PAYOUT' || kind === 'PROVIDER_WIN';
}

function isLosingBet(kind: string): boolean {
  return kind === 'CARD_PURCHASE' || kind === 'PROVIDER_BET';
}

function isFinanceKind(kind: string): boolean {
  return kind.startsWith('BONUS') || kind === 'AFFILIATE_COMMISSION' || kind === 'MANUAL_ADJUSTMENT';
}

function financeStatus(status: string): { labelKey: string; tone: 'mint' | 'gold' | 'warn' | 'danger' | 'neutral' } {
  switch (status) {
    case 'CREDITED':
      return { labelKey: 'wallet.stCredited', tone: 'mint' };
    case 'PAID':
      return { labelKey: 'wallet.stPaid', tone: 'mint' };
    case 'PENDING':
      return { labelKey: 'wallet.stPending', tone: 'warn' };
    case 'PROCESSING':
    case 'ESCROWED':
      return { labelKey: 'wallet.stProcessing', tone: 'gold' };
    case 'REJECTED':
      return { labelKey: 'wallet.stDeclined', tone: 'danger' };
    case 'EXPIRED':
      return { labelKey: 'wallet.stExpired', tone: 'neutral' };
    case 'CANCELLED':
      return { labelKey: 'wallet.stCancelled', tone: 'neutral' };
    default:
      return { labelKey: status.toLowerCase(), tone: 'neutral' };
  }
}

function StatusPill({ status }: { status: DepositStatus | WithdrawalStatus | string }) {
  return <Pill tone={STATUS_TONE[status] ?? 'neutral'}>{status.toLowerCase()}</Pill>;
}

function VerificationPill({ status }: { status: VerificationStatus }) {
  return (
    <Pill tone={VERIFICATION_TONE[status] ?? 'neutral'}>
      {status.toLowerCase().replaceAll('_', ' ')}
    </Pill>
  );
}

function CodeBlock({
  label,
  code,
  hint,
}: {
  label: string;
  code: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-gold/30 bg-gold/5 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gold">{label}</p>
      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="font-display text-2xl font-black tracking-[0.25em] text-text">{code}</span>
        <CopyButton value={code} />
      </div>
      {hint ? <p className="mt-1 text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

function AmountField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  action,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint?: string;
  error?: string;
  action?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted">{label}</span>
        {action}
      </div>
      <div className="relative mt-1.5">
        <input
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="h-14 w-full rounded-xl border border-line bg-ink/60 pl-3 pr-12 font-display text-2xl font-bold text-text placeholder:text-sm placeholder:font-normal placeholder:text-muted/60 focus:border-mint/60 focus:outline-none disabled:opacity-50"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-semibold uppercase text-muted">
          ETB
        </span>
      </div>
      {error ? (
        <p className="mt-1 text-[10px] text-danger">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[10px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

function QuickAmounts({ value, onPick }: { value: string; onPick: (value: string) => void }) {
  return (
    <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
      {QUICK_AMOUNTS.map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => onPick(item)}
          className={cn(
            'h-9 rounded-lg border text-xs font-semibold tabular-nums transition',
            value === item
              ? 'border-mint/60 bg-mint/10 text-mint'
              : 'border-line/70 bg-raised/50 text-muted hover:border-mint/40 hover:text-text',
          )}
        >
          {Number(item).toLocaleString()}
        </button>
      ))}
    </div>
  );
}

function HelpSteps({ title, steps }: { title: string; steps: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-line/70 bg-ink/40">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-semibold text-mint"
      >
        {title}
        <span className="text-muted">{open ? '−' : '+'}</span>
      </button>
      {open ? (
        <ol className="space-y-1.5 px-3 pb-3">
          {steps.map((step, index) => (
            <li key={step} className="flex gap-2 text-[11px] text-muted">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-mint/15 text-[9px] font-bold text-mint">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function MiniStat({ label, value, gold }: { label: string; value: string; gold?: boolean }) {
  return (
    <div className="rounded-lg bg-ink/40 px-2.5 py-2">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className={cn('mt-0.5 font-display text-sm font-bold tabular-nums', gold ? 'text-gold' : 'text-text')}>
        {value}
      </p>
    </div>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-7 w-7" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-7 w-7" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path d="M21.9 4.6 18.9 19c-.2 1-.8 1.2-1.7.8l-4.6-3.4-2.2 2.1c-.2.2-.5.5-.9.5l.3-4.6 8.4-7.6c.4-.3-.1-.5-.6-.2L7.2 12.8l-4.5-1.4c-1-.3-1-1 .2-1.4l17.6-6.8c.8-.3 1.5.2 1.4 1.4Z" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <path
        d="M6.6 3h2.7l1.4 4-1.7 1.4a12.7 12.7 0 0 0 6.6 6.6l1.4-1.7 4 1.4v2.7A2.6 2.6 0 0 1 18.4 20 15.4 15.4 0 0 1 4 5.6 2.6 2.6 0 0 1 6.6 3Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TicketIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <path
        d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.5a2.5 2.5 0 0 0 0 5V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.5a2.5 2.5 0 0 0 0-5V8Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M14 6v12" strokeDasharray="2 2" strokeLinecap="round" />
    </svg>
  );
}

function CardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" strokeLinejoin="round" />
      <path d="M8 5H5a3 3 0 0 0 3 5M16 5h3a3 3 0 0 1-3 5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 13v4M9 20h6M10 17h4l1 3H9l1-3Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefundIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <path d="M4 5v5h5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 10a8 8 0 1 1 1.6 6" strokeLinecap="round" />
    </svg>
  );
}

function ArrowDownLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <path d="M17 7 7 17M17 17H7V7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowUpRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <path d="M7 17 17 7M7 7h10v10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GiftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M12 8v13" />
      <path d="M12 8H8.5a2.5 2.5 0 1 1 0-5C11 3 12 8 12 8ZM12 8h3.5a2.5 2.5 0 1 0 0-5C13 3 12 8 12 8Z" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * What the payer sees right after submitting the reference: either the bank
 * check credited them, or the agent is confirming by hand. Both states keep
 * the agent's contact one tap away.
 */
function DepositConfirmation({
  deposit,
  providerName,
  onNewDeposit,
  onViewHistory,
}: {
  deposit: Deposit;
  providerName: string;
  onNewDeposit: () => void;
  onViewHistory: () => void;
}) {
  const { t } = useI18n();
  // A verified receipt can still be waiting for the agent to credit it, so
  // only a CREDITED deposit may claim the money reached the balance.
  const credited = deposit.status === 'CREDITED';
  const amount = formatStake(deposit.amount);
  const agent = deposit.agent ?? null;
  const agentName = agent?.displayName ?? agent?.agentCode ?? null;
  const handle = agent?.telegramUsername?.replace(/^@/, '') ?? null;
  const tel = agent?.phone ? agent.phone.replace(/[^+\d]/g, '') : null;
  const canContact = Boolean(agentName && (handle || tel));

  return (
    <Panel className="p-6 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-mint/15 text-mint">
        {credited ? <CheckIcon /> : <ClockIcon />}
      </div>
      <h2 className="mt-3 font-display text-xl font-black">
        {credited ? t('wallet.depositCreditedTitle') : t('wallet.verificationSentTitle')}
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted">
        {credited
          ? t('wallet.depositCreditedBody', { amount, method: providerName })
          : t('wallet.verificationSentBody', { amount, method: providerName })}
      </p>
      <p className="mt-1 text-[11px] text-muted">
        {credited ? t('wallet.depositCreditedHint') : t('wallet.verificationSentHint')}
      </p>
      <p className="mt-2 text-[10px] text-muted">
        {t('wallet.depositCode')} ·{' '}
        <span className="font-display text-xs font-bold tracking-[0.2em] text-text">{deposit.code}</span>
      </p>

      {canContact ? (
        <div className="mt-4 rounded-xl border border-line/70 bg-ink/40 p-3">
          <p className="text-[11px] text-muted">{t('wallet.contactAgent')}</p>
          <p className="mt-0.5 text-xs font-semibold text-text">{agentName}</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {handle ? (
              <a
                href={`https://t.me/${handle}`}
                target="_blank"
                rel="noreferrer"
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-mint/40 bg-mint/10 text-xs font-semibold text-mint transition hover:bg-mint/15"
              >
                <TelegramIcon />
                {t('wallet.contactTelegram')}
              </a>
            ) : null}
            {tel ? (
              <a
                href={`tel:${tel}`}
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-line/70 bg-raised/50 text-xs font-semibold text-text transition hover:border-mint/40"
              >
                <PhoneIcon />
                {t('wallet.callAgent')}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={onNewDeposit}>
          {t('wallet.newDeposit')}
        </Button>
        <Button onClick={onViewHistory}>{t('wallet.viewHistory')}</Button>
      </div>
    </Panel>
  );
}

/** Chunked so a multi-megabyte receipt page does not blow the argument limit. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

const MAX_RECEIPT_BYTES = 4_500_000;

function DepositPanel({
  onChanged,
  onViewHistory,
}: {
  onChanged: () => void;
  onViewHistory: () => void;
}) {
  const { refreshWallet } = useSession();
  const { t } = useI18n();
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [receiptPhone, setReceiptPhone] = useState('');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [proof, setProof] = useState<{ contentType: string; base64: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Deposit | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Deposit[]>([]);
  const [providers, setProviders] = useState<DepositProvider[]>([]);
  const [limits, setLimits] = useState<DepositLimits>({
    minAmount: DEFAULT_MIN_DEPOSIT_MINOR.toString(),
    maxAmount: null,
  });
  const [verifying, setVerifying] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const idempotency = useRef(newIdempotencyKey('dep'));

  const createdProvider = providers.find((item) => item.code === created?.providerCode) ?? null;
  const selectedProvider = providers.find((item) => item.code === selectedCode) ?? null;
  const account = created?.paymentAccount ?? null;
  const open = Boolean(created && (created.status === 'PENDING' || created.status === 'PROCESSING'));
  const showConfirmation = Boolean(created && submitted && created.verificationStatus !== 'FAILED');
  const platformMin = BigInt(limits.minAmount);
  const platformMax = limits.maxAmount === null ? null : BigInt(limits.maxAmount);
  const minLabel = formatStake(platformMin.toString());
  const amountHint =
    platformMax === null
      ? t('wallet.minHint', { amount: minLabel })
      : t('wallet.depositRangeHint', {
          min: minLabel,
          max: formatStake(platformMax.toString()),
        });
  /** Effective range for one rail: the platform window narrowed by the rail's own limits. */
  const railRange = (item: DepositProvider) => {
    const floor = item.minAmount && BigInt(item.minAmount) > platformMin ? BigInt(item.minAmount) : platformMin;
    const railMax = item.maxAmount ? BigInt(item.maxAmount) : null;
    const cap = railMax === null ? platformMax : platformMax === null ? railMax : railMax < platformMax ? railMax : platformMax;
    return { floor, cap };
  };
  const methodLabel = (method: PaymentMethod) => t(`method.${method}`);
  const remaining = created
    ? Math.max(0, Math.floor((new Date(created.expiresAt).getTime() - now) / 1000))
    : 0;
  const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, created?.id]);

  const loadPending = useCallback(async () => {
    try {
      const deposits = await fetchDeposits();
      setPending(deposits.filter((deposit) => deposit.status === 'PENDING' || deposit.status === 'PROCESSING'));
    } catch {
      // The balance panel remains usable if the queue cannot be read.
    }
  }, []);

  useEffect(() => {
    void loadPending();
    fetchDepositProviders()
      .then(setProviders)
      .catch(() => undefined);
    fetchDepositLimits()
      .then(setLimits)
      .catch(() => undefined);
  }, [loadPending]);

  const attachProof = async (file: File | null) => {
    setProof(null);
    setError(null);
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError(t('wallet.proofType'));
      return;
    }
    if (file.size > MAX_RECEIPT_BYTES) {
      setError(t('wallet.proofTooLarge'));
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    setProof({ contentType: file.type, base64: bytesToBase64(bytes), name: file.name });
  };

  /** "I have paid": submit whatever evidence the player attached. */
  const markPaid = async () => {
    if (!created) return;
    if (!reference.trim() && !proof) {
      setError(t('wallet.proofOrReferenceRequired'));
      return;
    }
    if (reference.trim() && createdProvider?.requiresPhone && !receiptPhone.trim()) {
      setError(t('wallet.receiptPhone'));
      return;
    }
    setVerifying(true);
    setError(null);
    setNotice(null);
    const body = {
      receiptReference: reference.trim(),
      receiptPhone: receiptPhone.trim() || undefined,
    };
    const proofBody = proof
      ? { proofBase64: proof.base64, proofContentType: proof.contentType }
      : {};
    try {
      // A reference, a screenshot, or both: one is enough. The API checks the
      // reference with the issuer and keeps the screenshot for the agent.
      const result = await verifyDepositReceipt(created.code, { ...body, ...proofBody });
      setCreated(result.data);
      setSubmitted(result.data.verificationStatus !== 'FAILED');
      setNotice(result.autoCredited ? t('wallet.depositCredited') : result.verification.message);
      haptic(result.autoCredited ? 'success' : 'tap');
      await Promise.all([loadPending(), onChanged()]);
      void refreshWallet();
    } catch (cause) {
      haptic('error');
      if (cause instanceof ApiError) setError(cause.message);
      else setError(t('wallet.bankFetchFailed'));
    } finally {
      setVerifying(false);
    }
  };

  // Server-side rails are checked in the background; poll until the outcome lands.
  useEffect(() => {
    if (!created) return;
    if (created.status !== 'PENDING' && created.status !== 'PROCESSING') return;
    if (created.verificationStatus !== 'PENDING') return;
    if (createdProvider?.clientSide) return;
    let stopped = false;
    let attempts = 0;
    const depositId = created.id;
    const timer = setInterval(() => {
      attempts += 1;
      void fetchDeposit(depositId)
        .then((next) => {
          if (stopped) return;
          setCreated(next);
          if (next.status === 'CREDITED') {
            setNotice(t('wallet.depositCredited'));
            void refreshWallet();
            void loadPending();
          } else if (next.verificationStatus !== 'PENDING') {
            setNotice(next.verificationMessage ?? null);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (attempts >= 8) clearInterval(timer);
        });
    }, 2_500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // Only the identity and outcome fields decide whether to keep polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [created?.id, created?.status, created?.verificationStatus, createdProvider?.clientSide]);

  /**
   * Create the deposit for the selected rail. The server assigns the agent,
   * so the account to pay is revealed on the next screen.
   */
  const begin = async () => {
    setError(null);
    setNotice(null);
    const item = selectedProvider;
    if (!item) {
      setError(t('wallet.selectMethodRequired'));
      return;
    }
    const minor = creditsToMinor(amount);
    if (minor === null) {
      setError(t('wallet.enterAmountFirst'));
      return;
    }
    const { floor, cap } = railRange(item);
    if (BigInt(minor) < platformMin) {
      setError(t('wallet.minHint', { amount: minLabel }));
      return;
    }
    if (platformMax !== null && BigInt(minor) > platformMax) {
      setError(t('wallet.depositMaxHint', { amount: formatStake(platformMax.toString()) }));
      return;
    }
    if (BigInt(minor) < floor || (cap !== null && BigInt(minor) > cap)) {
      setError(
        t('wallet.providerLimits', {
          min: formatStake(floor.toString()),
          max: cap === null ? '∞' : formatStake(cap.toString()),
        }),
      );
      return;
    }
    setBusy(true);
    try {
      const deposit = await createDeposit({
        amount: minor,
        method: item.method,
        providerCode: item.code,
        idempotencyKey: idempotency.current,
      });
      idempotency.current = newIdempotencyKey('dep');
      setCreated(deposit);
      setSubmitted(false);
      setAmount('');
      setReference('');
      setReceiptPhone('');
      setProof(null);
      haptic('success');
      await Promise.all([loadPending(), onChanged()]);
      void refreshWallet();
    } catch (cause) {
      haptic('error');
      if (cause instanceof ApiError && cause.code === 'NO_AGENT_FOR_METHOD') {
        setError(t('wallet.noAgentForMethod', { method: item.name }));
      } else {
        setError(cause instanceof ApiError ? cause.message : t('wallet.couldNotDeposit'));
      }
    } finally {
      setBusy(false);
    }
  };

  const startNewDeposit = () => {
    setCreated(null);
    setSubmitted(false);
    setReference('');
    setReceiptPhone('');
    setProof(null);
    setAmount('');
    setError(null);
    setNotice(null);
    idempotency.current = newIdempotencyKey('dep');
  };

  return (
    <div className="space-y-3">
      {created && showConfirmation ? (
        <DepositConfirmation
          deposit={created}
          providerName={createdProvider?.name ?? methodLabel(created.method)}
          onNewDeposit={startNewDeposit}
          onViewHistory={onViewHistory}
        />
      ) : null}

      {created && !showConfirmation ? (
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-line/70 px-4 py-3">
            <button
              type="button"
              onClick={startNewDeposit}
              className="flex items-center gap-1 text-[11px] font-semibold text-muted transition hover:text-text"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {t('wallet.back')}
            </button>
            <div className="text-right">
              <p className="text-[9px] font-semibold uppercase tracking-widest text-muted">
                {t('wallet.requestExpiresIn')}
              </p>
              <p className="font-display text-sm font-bold tabular-nums text-text">{countdown}</p>
            </div>
          </div>

          <div className="space-y-3 p-4">
            <div className="rounded-xl border border-mint/30 bg-mint/5 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-mint">
                  {t('wallet.sendMoneyToAccount')}
                </p>
                <div className="flex items-center gap-1">
                  <StatusPill status={created.status} />
                  <VerificationPill status={created.verificationStatus} />
                </div>
              </div>

              <dl className="mt-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[10px] uppercase tracking-wide text-muted">{t('wallet.paymentMethod')}</dt>
                  <dd className="truncate text-sm font-semibold text-text">
                    {createdProvider?.name ??
                      (account?.provider ? providerLabel(account.provider) : methodLabel(created.method))}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[10px] uppercase tracking-wide text-muted">{t('wallet.accountNumber')}</dt>
                  <dd className="flex items-center gap-2">
                    <span className="font-mono text-base font-bold tracking-wide text-gold">
                      {account?.accountNumber ?? '—'}
                    </span>
                    {account ? <CopyButton value={account.accountNumber} /> : null}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[10px] uppercase tracking-wide text-muted">{t('wallet.accountName')}</dt>
                  <dd className="truncate text-sm font-semibold text-text">{account?.accountName ?? '—'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[10px] uppercase tracking-wide text-muted">{t('wallet.amountDue')}</dt>
                  <dd className="font-display text-lg font-black tabular-nums text-gold">
                    {formatCredits(created.amount)} ETB
                  </dd>
                </div>
                {created.agent ? (
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-[10px] uppercase tracking-wide text-muted">{t('wallet.receivingAgent')}</dt>
                    <dd className="truncate text-sm font-semibold text-text">
                      {created.agent.displayName ?? created.agent.agentCode}
                      {created.agent.isOnline ? (
                        <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-mint">
                          · {t('wallet.online')}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[10px] uppercase tracking-wide text-muted">{t('wallet.depositCode')}</dt>
                  <dd className="font-display text-sm font-bold tracking-[0.2em] text-text">{created.code}</dd>
                </div>
              </dl>

              {account?.instructions ? (
                <p className="mt-2 text-[11px] text-muted">{account.instructions}</p>
              ) : null}
              {!account ? (
                <p className="mt-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] text-warn">
                  {t('wallet.noAccountYet')}
                </p>
              ) : null}

              {created.agent?.telegramUsername || created.agent?.phone ? (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {created.agent.telegramUsername ? (
                    <a
                      href={`https://t.me/${created.agent.telegramUsername.replace(/^@/, '')}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex h-9 items-center justify-center gap-1.5 rounded-xl border border-mint/40 bg-mint/10 text-[11px] font-semibold text-mint"
                    >
                      <TelegramIcon />
                      {t('wallet.contactTelegram')}
                    </a>
                  ) : null}
                  {created.agent.phone ? (
                    <a
                      href={`tel:${created.agent.phone.replace(/[^+\d]/g, '')}`}
                      className="flex h-9 items-center justify-center gap-1.5 rounded-xl border border-line/70 bg-raised/50 text-[11px] font-semibold text-text"
                    >
                      <PhoneIcon />
                      {t('wallet.callAgent')}
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>

            <p className="text-[11px] text-muted">{t('wallet.sendExactAmount')}</p>

            {open && createdProvider ? (
              <div className="space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">
                  {t('wallet.uploadVerification')}
                </p>
                <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line/80 bg-ink/40 px-4 py-6 text-center transition hover:border-mint/50">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    onChange={(event) => void attachProof(event.target.files?.[0] ?? null)}
                  />
                  <svg
                    viewBox="0 0 24 24"
                    className="h-6 w-6 text-mint"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    aria-hidden
                  >
                    <path d="M4 16l4-4 4 4 4-6 4 6" strokeLinecap="round" strokeLinejoin="round" />
                    <rect x="3" y="5" width="18" height="14" rx="3" />
                  </svg>
                  <span className="text-xs font-semibold text-text">
                    {proof ? t('wallet.proofSelected', { name: proof.name }) : t('wallet.uploadScreenshot')}
                  </span>
                  <span className="text-[10px] text-muted">
                    {proof ? t('wallet.tapToReplace') : t('wallet.uploadScreenshotHint')}
                  </span>
                </label>

                <div className="flex items-center gap-2">
                  <span className="h-px flex-1 bg-line/70" />
                  <span className="text-[9px] font-semibold uppercase tracking-widest text-muted">{t('wallet.or')}</span>
                  <span className="h-px flex-1 bg-line/70" />
                </div>

                <Input
                  label={t('wallet.receiptReference')}
                  placeholder={createdProvider.refHint ?? 'FT…'}
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  hint={createdProvider.refHint ?? t('wallet.referenceOrLinkHint')}
                />
                {createdProvider.requiresPhone ? (
                  <Input
                    label={t('wallet.receiptPhone')}
                    inputMode="tel"
                    placeholder="+2519…"
                    value={receiptPhone}
                    onChange={(event) => setReceiptPhone(event.target.value)}
                  />
                ) : null}
                <Button className="w-full" size="lg" loading={verifying} onClick={() => void markPaid()}>
                  {verifying ? t('wallet.verifying') : t('wallet.verifyPayment')}
                </Button>
              </div>
            ) : null}

            {!open ? (
              <CodeBlock
                label={t('wallet.depositCode')}
                code={created.code}
                hint={`${t('wallet.depositCodeHint')} ${t('wallet.depositExpires', { when: formatDateTime(created.expiresAt) })}`}
              />
            ) : null}

            {created.receiptReference ? (
              <p className="text-[11px] text-muted">
                {t('wallet.receiptReference')}: <span className="font-mono text-text">{created.receiptReference}</span>
              </p>
            ) : null}
            {created.verificationMessage ? (
              <p className="text-[11px] text-muted">{created.verificationMessage}</p>
            ) : null}
            {notice ? <p className="text-[11px] text-mint">{notice}</p> : null}
            <p className="text-[11px] text-muted">{t('wallet.depositBalanceNote')}</p>
          </div>
        </Panel>
      ) : null}

      {!created ? (
        <Panel className="p-4">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-mint">
            {t('wallet.stepChooseMethod')}
          </p>
          <h2 className="mt-0.5 font-display text-base font-bold">{t('wallet.deposit')}</h2>
          <p className="mt-0.5 text-[11px] text-muted">{t('wallet.buyCreditsBlurb')}</p>

          <div className="mt-3">
            <AmountField
              label={t('wallet.depositAmount')}
              value={amount}
              onChange={setAmount}
              placeholder={t('wallet.amountPlaceholder', { min: minLabel })}
              hint={amountHint}
            />
            <QuickAmounts value={amount} onPick={setAmount} />
          </div>

          <div className="mt-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">
              {t('wallet.selectPaymentMethod')}
            </p>
            {providers.length === 0 ? (
              <p className="mt-1 text-[11px] text-warn">{t('wallet.noDepositMethods')}</p>
            ) : (
              <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {providers.map((item) => {
                  const selected = item.code === selectedCode;
                  const { floor, cap } = railRange(item);
                  return (
                    <button
                      key={item.code}
                      type="button"
                      aria-pressed={selected}
                      disabled={busy}
                      onClick={() => setSelectedCode(item.code)}
                      className={cn(
                        'flex items-center justify-between gap-2 rounded-xl border p-3 text-left transition disabled:opacity-50',
                        selected
                          ? 'border-mint/60 bg-mint/10'
                          : 'border-line/70 bg-raised/50 hover:border-mint/50 hover:bg-mint/5',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-text">{item.name}</span>
                        <span className="block text-[10px] text-muted">{methodLabel(item.method)}</span>
                        <span className="mt-0.5 block text-[10px] text-muted">
                          {formatStake(floor.toString())} – {cap === null ? '∞' : formatStake(cap.toString())} ETB
                        </span>
                      </span>
                      <span
                        className={cn(
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                          selected ? 'border-mint bg-mint text-ink' : 'border-line/80 text-transparent',
                        )}
                        aria-hidden
                      >
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3">
                          <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="mt-1.5 text-[10px] text-muted">{t('wallet.tapMethodHint')}</p>
          </div>

          <Button className="mt-3 w-full" size="lg" loading={busy} onClick={() => void begin()}>
            {t('wallet.depositButton')}
          </Button>
          {error ? (
            <div className="mt-3">
              <ErrorNote>{error}</ErrorNote>
            </div>
          ) : null}
          <div className="mt-3">
            <HelpSteps
              title={t('wallet.helpHowToDeposit')}
              steps={[
                t('wallet.depositStep1'),
                t('wallet.depositStep2'),
                t('wallet.depositStep3'),
                t('wallet.depositStep4'),
                t('wallet.depositStep5'),
                t('wallet.depositStep6'),
              ]}
            />
          </div>
        </Panel>
      ) : null}

      {pending.length > 0 ? (
        <Panel className="p-4">
          <h2 className="mb-2 font-display text-sm font-bold uppercase tracking-wider text-muted">
            {t('wallet.waitingAgent')}
          </h2>
          <ul className="space-y-2">
            {pending.map((deposit) => (
              <li key={deposit.id} className="rounded-xl border border-line/70 bg-ink/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-lg font-bold tracking-[0.2em]">{deposit.code}</span>
                  <div className="flex items-center gap-1">
                    <VerificationPill status={deposit.verificationStatus} />
                    <StatusPill status={deposit.status} />
                  </div>
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  {formatCredits(deposit.amount)} ETB · {formatDateTime(deposit.createdAt)} ·
                  expires {formatDateTime(deposit.expiresAt)}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

function WithdrawPanel({ onChanged }: { onChanged: () => void }) {
  const { wallet, refreshWallet } = useSession();
  const { t } = useI18n();
  const [providers, setProviders] = useState<DepositProvider[] | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accounts, setAccounts] = useState<PayoutAccount[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Withdrawal | null>(null);
  const [open, setOpen] = useState<Withdrawal[]>([]);
  const [proofs, setProofs] = useState<Record<string, WithdrawalProof[]>>({});
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const idempotency = useRef(newIdempotencyKey('wd'));

  const selectedProvider = providers?.find((item) => item.code === selectedCode) ?? null;

  const loadOpen = useCallback(async () => {
    try {
      const withdrawals = await fetchWithdrawals();
      const live = withdrawals.filter(
        (item) => item.status === 'ESCROWED' || item.status === 'PROCESSING',
      );
      setOpen(live);
      setCreated((current) => (current ? withdrawals.find((item) => item.id === current.id) ?? current : current));
      const proofsByWithdrawal = await Promise.all(
        live
          .filter((item) => item.status === 'PROCESSING')
          .map(async (item) => {
            const items = await fetchWithdrawalProofs(item.id).catch(() => [] as WithdrawalProof[]);
            return [item.id, items] as const;
          }),
      );
      setProofs(Object.fromEntries(proofsByWithdrawal));
    } catch {
      // Leave the form usable even when the queue is unreachable.
    }
  }, []);

  useEffect(() => {
    void loadOpen();
    fetchDepositProviders()
      .then(setProviders)
      .catch(() => setProviders([]));
    fetchPayoutAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadOpen();
    }, 15_000);
    return () => clearInterval(timer);
  }, [loadOpen]);

  // Default to the first rail, then reuse the saved destination for that rail
  // so a returning player only has to confirm the amount.
  useEffect(() => {
    if (!providers || providers.length === 0) return;
    if (!selectedCode) {
      setSelectedCode(providers[0]!.code);
      return;
    }
    if (accounts === null || accountName.trim() || accountNumber.trim()) return;
    const provider = providers.find((item) => item.code === selectedCode);
    if (!provider) return;
    const saved =
      accounts.find((item) => item.isActive && item.provider === selectedCode) ??
      accounts.find((item) => item.isActive && item.method === provider.method);
    if (saved) {
      setAccountName(saved.accountName);
      setAccountNumber(saved.accountNumber);
    }
  }, [providers, accounts, selectedCode, accountName, accountNumber]);

  const chooseProvider = (item: DepositProvider) => {
    setSelectedCode(item.code);
    setError(null);
    const saved =
      accounts?.find((account) => account.isActive && account.provider === item.code) ??
      accounts?.find((account) => account.isActive && account.method === item.method);
    setAccountName(saved?.accountName ?? '');
    setAccountNumber(saved?.accountNumber ?? '');
  };

  const availableMinor = wallet ? Number(wallet.available) : null;
  const requestedMinor = creditsToMinor(amount);
  const exceedsBalance =
    requestedMinor !== null && availableMinor !== null && requestedMinor > availableMinor;
  const max = wallet ? minorToCreditsInput(wallet.available) : '';

  const submit = async () => {
    if (!selectedProvider) {
      setError(t('wallet.selectMethodRequired'));
      return;
    }
    if (requestedMinor === null) {
      setError(t('wallet.invalidAmount'));
      return;
    }
    if (exceedsBalance) {
      setError(t('wallet.exceedsBalance', { amount: formatCredits(wallet?.available ?? '0') }));
      return;
    }
    if (!accountName.trim() || !accountNumber.trim()) {
      setError(t('wallet.payoutAccountFields'));
      return;
    }
    const confirmed = await confirmAction({
      title: t('wallet.confirmWithdrawTitle'),
      message: t('wallet.confirmWithdrawBody', {
        amount: formatCredits(String(requestedMinor)),
        name: accountName.trim(),
        method: selectedProvider.name,
      }),
      confirmText: t('wallet.withdraw'),
      cancelText: t('common.cancel'),
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const withdrawal = await createWithdrawal({
        amount: requestedMinor,
        method: selectedProvider.method,
        providerCode: selectedProvider.code,
        payoutAccount: {
          accountName: accountName.trim(),
          accountNumber: accountNumber.trim(),
          provider: selectedProvider.code,
        },
        playerNote: note.trim() || undefined,
        idempotencyKey: idempotency.current,
      });
      idempotency.current = newIdempotencyKey('wd');
      setCreated(withdrawal);
      setAmount('');
      setNote('');
      setAccountName('');
      setAccountNumber('');
      haptic('success');
      await Promise.all([loadOpen(), onChanged()]);
      void refreshWallet();
    } catch (cause) {
      haptic('error');
      setError(cause instanceof ApiError ? cause.message : t('wallet.couldNotWithdraw'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    const confirmed = await confirmAction({
      title: t('wallet.confirmCancelTitle'),
      message: t('wallet.confirmCancelBody'),
      confirmText: t('wallet.confirmCancelTitle'),
      cancelText: t('wallet.keepWithdrawal'),
      destructive: true,
    });
    if (!confirmed) return;
    setCancelling(id);
    try {
      await cancelWithdrawal(id);
      setCreated((current) => (current?.id === id ? null : current));
      haptic('success');
      await Promise.all([loadOpen(), onChanged()]);
      void refreshWallet();
    } catch (cause) {
      haptic('error');
      setError(cause instanceof ApiError ? cause.message : t('wallet.couldNotCancel'));
    } finally {
      setCancelling(null);
    }
  };

  const confirmCash = async (withdrawal: Withdrawal) => {
    const confirmed = await confirmAction({
      title: t('wallet.confirmCashTitle'),
      message: t('wallet.confirmCashBody', { amount: formatCredits(withdrawal.netAmount) }),
      confirmText: t('wallet.confirmCashReceived'),
      cancelText: t('common.cancel'),
    });
    if (!confirmed) return;
    setConfirming(withdrawal.id);
    setError(null);
    try {
      await confirmCashReceived(withdrawal.id);
      haptic('success');
      await Promise.all([loadOpen(), onChanged()]);
      void refreshWallet();
    } catch (cause) {
      haptic('error');
      setError(cause instanceof ApiError ? cause.message : t('wallet.couldNotConfirm'));
    } finally {
      setConfirming(null);
    }
  };

  const createdProvider =
    providers?.find((item) => item.code === created?.providerCode)?.name ??
    created?.providerCode ??
    (created ? t(`method.${created.method}`) : '');
  const createdAgent = created?.agent ?? null;
  const agentName = createdAgent?.displayName ?? createdAgent?.agentCode ?? null;
  const agentHandle = createdAgent?.telegramUsername?.replace(/^@/, '') ?? null;
  const agentTel = createdAgent?.phone ? createdAgent.phone.replace(/[^+\d]/g, '') : null;

  return (
    <div className="space-y-3">
      {created ? (
        <Panel className="p-5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
                <CheckIcon />
              </span>
              <div>
                <h2 className="font-display text-base font-bold">{t('wallet.withdrawalRequestedTitle')}</h2>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
                  {agentName
                    ? t('wallet.withdrawalRequestedBody', {
                        amount: formatCredits(created.amount),
                        agent: agentName,
                        net: formatCredits(created.netAmount),
                        method: createdProvider,
                      })
                    : t('wallet.withdrawalRequestedBodyNoAgent', {
                        amount: formatCredits(created.amount),
                      })}
                </p>
              </div>
            </div>
            <StatusPill status={created.status} />
          </div>

          <dl className="mt-4 space-y-1.5 rounded-xl border border-line/70 bg-ink/40 p-3 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted">{t('wallet.withdrawAmount')}</dt>
              <dd className="font-semibold tabular-nums">{formatCredits(created.amount)} ETB</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted">{t('wallet.fee')}</dt>
              <dd className="tabular-nums">{formatCredits(created.fee)} ETB</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted">{t('wallet.youReceive')}</dt>
              <dd className="font-display text-sm font-bold text-mint tabular-nums">
                {formatCredits(created.netAmount)} ETB
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted">{t('wallet.paymentMethod')}</dt>
              <dd className="font-semibold">{createdProvider}</dd>
            </div>
          </dl>

          {created.payoutAccount ? (
            <div className="mt-3 rounded-xl border border-line/70 bg-ink/40 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">
                {t('wallet.payingTo')}
              </p>
              <p className="mt-0.5 text-xs font-semibold text-text">{created.payoutAccount.accountName}</p>
              <p className="text-[11px] text-muted">{created.payoutAccount.accountNumber}</p>
            </div>
          ) : null}

          {agentName ? (
            <div className="mt-3 rounded-xl border border-line/70 bg-ink/40 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">
                {t('wallet.agentAssigned')}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold text-text">
                {agentName}
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    createdAgent?.isOnline ? 'bg-mint' : 'bg-muted',
                  )}
                  aria-hidden
                />
                <span className="text-[10px] font-normal text-muted">
                  {createdAgent?.isOnline ? t('wallet.online') : createdAgent?.agentCode ?? ''}
                </span>
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {agentHandle ? (
                  <a
                    href={`https://t.me/${agentHandle}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-mint/40 bg-mint/10 text-xs font-semibold text-mint transition hover:bg-mint/15"
                  >
                    <TelegramIcon />
                    {t('wallet.talkOnTelegram')}
                  </a>
                ) : null}
                {agentTel ? (
                  <a
                    href={`tel:${agentTel}`}
                    className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-line/70 bg-raised/50 text-xs font-semibold text-text transition hover:border-mint/40"
                  >
                    <PhoneIcon />
                    {t('wallet.callAgent')}
                  </a>
                ) : null}
              </div>
              {!createdAgent?.isOnline ? (
                <p className="mt-1.5 text-[10px] text-muted">{t('wallet.agentOfflineHint')}</p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-3">
            <CodeBlock
              label={t('wallet.payoutCode')}
              code={created.payoutCode}
              hint={t('wallet.agentPayoutHint')}
            />
          </div>

          <p className="mt-2 text-[10px] text-muted">
            {t('wallet.expiresAt', { when: formatDateTime(created.expiresAt) })}
          </p>

          <div className="mt-4 grid grid-cols-2 gap-2">
            {created.status === 'ESCROWED' ? (
              <Button
                variant="danger"
                loading={cancelling === created.id}
                onClick={() => void cancel(created.id)}
              >
                {t('common.cancel')}
              </Button>
            ) : null}
            <Button
              variant="outline"
              className={created.status === 'ESCROWED' ? '' : 'col-span-2'}
              onClick={() => {
                setCreated(null);
                setError(null);
              }}
            >
              {t('wallet.newWithdrawal')}
            </Button>
          </div>
        </Panel>
      ) : (
        <Panel className="p-4">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gold">
            {t('wallet.stepChoosePayout')}
          </p>
          <h2 className="mt-0.5 font-display text-base font-bold">{t('wallet.withdraw')}</h2>
          <p className="mt-0.5 text-[11px] text-muted">{t('wallet.withdrawBlurb')}</p>

          <div className="mt-3">
            <AmountField
              label={t('wallet.withdrawAmount')}
              value={amount}
              onChange={setAmount}
              placeholder={t('wallet.withdrawPlaceholder')}
              hint={`${t('wallet.available')} ${wallet ? formatCredits(wallet.available) : '—'} ETB`}
              error={exceedsBalance ? t('wallet.exceedsBalance', { amount: formatCredits(wallet?.available ?? '0') }) : undefined}
              action={
                <button
                  type="button"
                  onClick={() => setAmount(max)}
                  className="rounded-md bg-raised px-2 py-0.5 text-[10px] font-bold uppercase text-mint"
                >
                  {t('wallet.max')}
                </button>
              }
            />
          </div>

          <div className="mt-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">
              {t('wallet.selectPaymentMethod')}
            </p>
            {providers === null ? (
              <div className="mt-2 flex justify-center py-2">
                <Spinner className="h-4 w-4 text-mint" />
              </div>
            ) : providers.length === 0 ? (
              <p className="mt-1 text-[11px] text-warn">{t('wallet.noWithdrawMethods')}</p>
            ) : (
              <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {providers.map((item) => {
                  const selected = item.code === selectedCode;
                  return (
                    <button
                      key={item.code}
                      type="button"
                      aria-pressed={selected}
                      disabled={busy}
                      onClick={() => chooseProvider(item)}
                      className={cn(
                        'flex items-center justify-between gap-2 rounded-xl border p-3 text-left transition disabled:opacity-50',
                        selected
                          ? 'border-gold/60 bg-gold/10'
                          : 'border-line/70 bg-raised/50 hover:border-gold/50 hover:bg-gold/5',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-text">{item.name}</span>
                        <span className="block text-[10px] text-muted">{t(`method.${item.method}`)}</span>
                      </span>
                      <span
                        className={cn(
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                          selected ? 'border-gold bg-gold text-ink' : 'border-line/80 text-transparent',
                        )}
                        aria-hidden
                      >
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3">
                          <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-4 space-y-2">
            <Input
              label={t('wallet.withdrawFullName')}
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
              autoComplete="name"
            />
            <Input
              label={t('wallet.withdrawAccountNumber')}
              value={accountNumber}
              onChange={(event) => setAccountNumber(event.target.value)}
              inputMode="numeric"
            />
            <p className="text-[10px] text-muted">{t('wallet.withdrawAccountHint')}</p>
          </div>

          <div className="mt-3">
            <Input
              label={t('wallet.payoutDetails')}
              placeholder={t('wallet.payoutDetailsPlaceholder')}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {error ? (
            <div className="mt-3">
              <ErrorNote>{error}</ErrorNote>
            </div>
          ) : null}
          <Button
            className="mt-3 w-full"
            size="lg"
            variant="gold"
            loading={busy}
            disabled={
              !selectedProvider ||
              requestedMinor === null ||
              exceedsBalance ||
              !accountName.trim() ||
              !accountNumber.trim()
            }
            onClick={() => void submit()}
          >
            {t('wallet.requestWithdrawal')}
          </Button>
          <div className="mt-3">
            <HelpSteps
              title={t('wallet.helpHowToWithdraw')}
              steps={[
                t('wallet.withdrawStep1'),
                t('wallet.withdrawStep2'),
                t('wallet.withdrawStep3'),
                t('wallet.withdrawStep4'),
                t('wallet.withdrawStep5'),
                t('wallet.withdrawStep6'),
              ]}
            />
          </div>
        </Panel>
      )}

      {open.length > 0 ? (
        <Panel className="p-4">
          <h2 className="mb-2 font-display text-sm font-bold uppercase tracking-wider text-muted">
            {t('wallet.openPayouts')}
          </h2>
          <ul className="space-y-2">
            {open.map((withdrawal) => {
              const latest = proofs[withdrawal.id]?.[0] ?? null;
              const canConfirm =
                withdrawal.method === 'CASH' &&
                withdrawal.status === 'PROCESSING' &&
                latest !== null &&
                (latest.status === 'PENDING' || latest.status === 'MANUAL');
              return (
                <li key={withdrawal.id} className="rounded-xl border border-line/70 bg-ink/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-lg font-bold tracking-[0.2em]">
                      {withdrawal.payoutCode}
                    </span>
                    <StatusPill status={withdrawal.status} />
                  </div>
                  <p className="mt-1 text-[11px] text-muted">
                    {formatCredits(withdrawal.amount)} ETB · {formatDateTime(withdrawal.createdAt)}
                  </p>
                  {withdrawal.agent ? (
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted">
                      <span>
                        {t('wallet.payingAgent')}:{' '}
                        <span className="font-semibold text-text">
                          {withdrawal.agent.displayName ?? withdrawal.agent.agentCode}
                        </span>
                      </span>
                      {withdrawal.agent.telegramUsername ? (
                        <a
                          href={`https://t.me/${withdrawal.agent.telegramUsername.replace(/^@/, '')}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-mint underline-offset-2 hover:underline"
                        >
                          {t('wallet.talkOnTelegram')}
                        </a>
                      ) : null}
                      {withdrawal.agent.phone ? (
                        <a
                          href={`tel:${withdrawal.agent.phone.replace(/[^+\d]/g, '')}`}
                          className="font-semibold text-mint underline-offset-2 hover:underline"
                        >
                          {t('wallet.callAgent')}
                        </a>
                      ) : null}
                    </p>
                  ) : null}
                  {withdrawal.status === 'PROCESSING' ? (
                    <p className="mt-1 text-[11px] text-muted">{t('wallet.processingHint')}</p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    {withdrawal.status === 'PROCESSING' ? (
                      latest ? (
                        <Pill
                          tone={
                            latest.status === 'VERIFIED'
                              ? 'mint'
                              : latest.status === 'FAILED'
                                ? 'danger'
                                : 'gold'
                          }
                        >
                          {t('wallet.proofStatus', { status: latest.status.toLowerCase() })}
                        </Pill>
                      ) : (
                        <Pill tone="gold">{t('wallet.awaitingProof')}</Pill>
                      )
                    ) : (
                      <span className="text-[10px] text-muted">
                        {t('wallet.expiresAt', { when: formatDateTime(withdrawal.expiresAt) })}
                      </span>
                    )}
                    <div className="flex items-center gap-2">
                      {canConfirm ? (
                        <Button
                          variant="gold"
                          size="sm"
                          loading={confirming === withdrawal.id}
                          onClick={() => void confirmCash(withdrawal)}
                        >
                          {t('wallet.confirmCashReceived')}
                        </Button>
                      ) : null}
                      {withdrawal.status === 'ESCROWED' ? (
                        <Button
                          variant="danger"
                          size="sm"
                          loading={cancelling === withdrawal.id}
                          onClick={() => void cancel(withdrawal.id)}
                        >
                          {t('common.cancel')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

interface ActivityRow {
  id: string;
  title: string;
  amount: string;
  meta: string;
  createdAt: string;
  icon: ReactNode;
  tileClass: string;
  badge: { label: string; tone: 'mint' | 'gold' | 'warn' | 'danger' | 'neutral' } | null;
}

function ActivityRowCard({ row }: { row: ActivityRow }) {
  const negative = row.amount.startsWith('-');
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line/70 bg-panel p-3.5">
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', row.tileClass)}>
        {row.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-text">{row.title}</span>
          <span
            className={cn(
              'shrink-0 font-display text-sm font-bold tabular-nums',
              negative ? 'text-danger' : 'text-mint',
            )}
          >
            {negative ? '−' : '+'}
            {formatStake(negative ? row.amount.slice(1) : row.amount)}
            <span className="ml-1 text-[9px] font-semibold uppercase text-muted">ETB</span>
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="truncate text-[10px] text-muted">{row.meta}</span>
          {row.badge ? <Pill tone={row.badge.tone}>{row.badge.label}</Pill> : null}
        </div>
      </div>
    </div>
  );
}

function FilterChips<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1">
      {options.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onChange(item.value)}
          aria-pressed={value === item.value}
          className={cn(
            'shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition',
            value === item.value
              ? 'border-mint/50 bg-mint/10 text-mint'
              : 'border-line/70 bg-raised/40 text-muted hover:text-text',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function HistoryPanel({
  section,
  onSectionChange,
}: {
  section: ActivitySection;
  onSectionChange: (value: ActivitySection) => void;
}) {
  const { t } = useI18n();
  const [lines, setLines] = useState<TransactionLine[] | null>(null);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [providers, setProviders] = useState<DepositProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [betFilter, setBetFilter] = useState<BetFilter>('all');
  const [financeFilter, setFinanceFilter] = useState<FinanceFilter>('all');

  const load = useCallback(async () => {
    try {
      const [nextLines, nextDeposits, nextWithdrawals] = await Promise.all([
        fetchTransactions(60),
        fetchDeposits(),
        fetchWithdrawals(),
      ]);
      setLines(nextLines);
      setDeposits(nextDeposits);
      setWithdrawals(nextWithdrawals);
      setError(null);
    } catch {
      setError(t('wallet.historyError'));
    }
    setProviders(await fetchDepositProviders().catch(() => []));
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!lines) {
    return (
      <div className="flex justify-center py-10">
        <Spinner className="h-5 w-5 text-mint" />
      </div>
    );
  }

  const methodLabel = (method: PaymentMethod) => t(`method.${method}`);
  const providerName = (code: string | null) => providers.find((item) => item.code === code)?.name ?? code;

  const betTitle = (kind: string): string => {
    switch (kind) {
      case 'CARD_PURCHASE':
        return t('wallet.betCardPurchase');
      case 'ROUND_PAYOUT':
        return t('wallet.betRoundWin');
      case 'ROUND_REFUND':
        return t('wallet.betRoundRefund');
      case 'PROVIDER_BET':
        return t('wallet.betProvider');
      case 'PROVIDER_WIN':
        return t('wallet.betProviderWin');
      default:
        return kind.replaceAll('_', ' ').toLowerCase();
    }
  };

  const betRows: ActivityRow[] = lines
    .filter((line) => BET_KINDS.has(line.kind))
    .filter((line) => {
      if (betFilter === 'won') return isWinningBet(line.kind);
      if (betFilter === 'lost') return isLosingBet(line.kind);
      return true;
    })
    .map((line) => {
      const won = isWinningBet(line.kind);
      const refund = line.kind === 'ROUND_REFUND';
      return {
        id: `bet-${line.id}`,
        title: betTitle(line.kind),
        amount: line.amount,
        meta: [line.memo, timeAgo(line.createdAt)].filter(Boolean).join(' · '),
        createdAt: line.createdAt,
        icon: refund ? <RefundIcon /> : won ? <TrophyIcon /> : <TicketIcon />,
        tileClass: refund ? 'bg-raised text-muted' : won ? 'bg-mint/15 text-mint' : 'bg-gold/15 text-gold',
        badge: refund
          ? { label: t('wallet.betRefunded'), tone: 'neutral' as const }
          : won
            ? { label: t('wallet.betWon'), tone: 'mint' as const }
            : null,
      };
    });

  const depositRows: ActivityRow[] = deposits.map((deposit) => ({
    id: `dep-${deposit.id}`,
    title: t('wallet.deposit'),
    amount: deposit.amount,
    meta: [providerName(deposit.providerCode) ?? methodLabel(deposit.method), timeAgo(deposit.createdAt)].join(' · '),
    createdAt: deposit.createdAt,
    icon: <ArrowDownLeftIcon />,
    tileClass: 'bg-mint/15 text-mint',
    badge: { label: t(financeStatus(deposit.status).labelKey), tone: financeStatus(deposit.status).tone },
  }));

  const withdrawalRows: ActivityRow[] = withdrawals.map((withdrawal) => ({
    id: `wd-${withdrawal.id}`,
    title: t('wallet.finWithdrawal'),
    amount: `-${withdrawal.amount}`,
    meta: [methodLabel(withdrawal.method), timeAgo(withdrawal.createdAt)].join(' · '),
    createdAt: withdrawal.createdAt,
    icon: <ArrowUpRightIcon />,
    tileClass: 'bg-danger/10 text-danger',
    badge: { label: t(financeStatus(withdrawal.status).labelKey), tone: financeStatus(withdrawal.status).tone },
  }));

  const otherRows: ActivityRow[] = lines
    .filter((line) => isFinanceKind(line.kind))
    .map((line) => ({
      id: `fin-${line.id}`,
      title: line.kind.startsWith('BONUS')
        ? t('wallet.finBonus')
        : line.kind === 'AFFILIATE_COMMISSION'
          ? t('wallet.finCommission')
          : t('wallet.finAdjustment'),
      amount: line.amount,
      meta: [line.memo, timeAgo(line.createdAt)].filter(Boolean).join(' · '),
      createdAt: line.createdAt,
      icon: <GiftIcon />,
      tileClass: 'bg-gold/15 text-gold',
      badge: null,
    }));

  const financeRows = [...depositRows, ...withdrawalRows, ...otherRows]
    .filter((row) => {
      if (financeFilter === 'deposits') return row.id.startsWith('dep-');
      if (financeFilter === 'withdrawals') return row.id.startsWith('wd-');
      if (financeFilter === 'bonuses') return row.id.startsWith('fin-');
      return true;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const rows = section === 'bets' ? betRows : financeRows;
  const empty =
    section === 'bets'
      ? {
          title: betFilter === 'all' ? t('wallet.noBets') : t('wallet.noFiltered'),
          body: betFilter === 'all' ? t('wallet.noBetsBody') : undefined,
        }
      : {
          title: financeFilter === 'all' ? t('wallet.noFinances') : t('wallet.noFiltered'),
          body: financeFilter === 'all' ? t('wallet.noFinancesBody') : undefined,
        };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">{t('wallet.activity')}</p>
        <button type="button" onClick={() => void load()} className="text-[11px] font-semibold text-mint">
          {t('common.refresh')}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-xl border border-line/70 bg-ink/40 p-1">
        {(
          [
            { value: 'bets' as const, label: t('wallet.activityBets'), icon: <TicketIcon /> },
            { value: 'finances' as const, label: t('wallet.activityFinances'), icon: <CardIcon /> },
          ]
        ).map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => onSectionChange(item.value)}
            aria-pressed={section === item.value}
            className={cn(
              'flex h-10 items-center justify-center gap-2 rounded-lg text-xs font-semibold transition',
              section === item.value ? 'bg-mint/15 text-mint shadow-sm' : 'text-muted hover:text-text',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      {section === 'bets' ? (
        <FilterChips<BetFilter>
          value={betFilter}
          onChange={setBetFilter}
          options={[
            { value: 'all', label: t('wallet.filterAll') },
            { value: 'won', label: t('wallet.betWon') },
            { value: 'lost', label: t('wallet.betLost') },
          ]}
        />
      ) : (
        <FilterChips<FinanceFilter>
          value={financeFilter}
          onChange={setFinanceFilter}
          options={[
            { value: 'all', label: t('wallet.filterAll') },
            { value: 'deposits', label: t('wallet.filterDeposits') },
            { value: 'withdrawals', label: t('wallet.filterWithdrawals') },
            { value: 'bonuses', label: t('wallet.filterBonuses') },
          ]}
        />
      )}

      {rows.length === 0 ? (
        <EmptyState title={empty.title} body={empty.body} />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <ActivityRowCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function WalletPage() {
  const { wallet, refreshWallet } = useSession();
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('deposit');
  const [historySection, setHistorySection] = useState<ActivitySection>('bets');
  const [lowBalanceDismissed, setLowBalanceDismissed] = useState(true);

  const bump = useCallback(async () => {
    await refreshWallet().catch(() => undefined);
  }, [refreshWallet]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested === 'deposit' || requested === 'withdraw' || requested === 'history') {
      setTab(requested);
    }
    setLowBalanceDismissed(window.sessionStorage.getItem(LOW_BALANCE_KEY) === '1');
  }, []);

  const dismissLowBalance = () => {
    setLowBalanceDismissed(true);
    window.sessionStorage.setItem(LOW_BALANCE_KEY, '1');
  };

  const lowBalance = Boolean(wallet && BigInt(wallet.available) < LOW_BALANCE_MINOR && !lowBalanceDismissed);
  const hasLocked = Boolean(wallet && (wallet.escrow !== '0' || wallet.locked !== '0'));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-black tracking-tight">{t('wallet.title')}</h1>
        <p className="text-xs text-muted">{t('wallet.blurb')}</p>
      </div>

      <Panel className="overflow-hidden">
        <div className="bg-gradient-to-br from-mint/15 via-panel to-gold/10 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">
                {t('wallet.totalBalance')}
              </p>
              <p className="mt-1 font-display text-4xl font-black tracking-tight text-text">
                {wallet ? formatCredits(wallet.available) : '—'}
                <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">ETB</span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => void bump()}
              className="rounded-lg border border-line/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted transition hover:text-text"
            >
              {t('common.refresh')}
            </button>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            <MiniStat label={t('wallet.won')} value={wallet ? formatCredits(wallet.lifetimeWon) : '—'} />
            <MiniStat
              label={t('wallet.deposited')}
              value={wallet ? formatCredits(wallet.lifetimeDeposited) : '—'}
            />
            <MiniStat
              label={t('wallet.freebets')}
              value={wallet ? formatCredits(wallet.bonus) : '—'}
              gold
            />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button size="lg" onClick={() => setTab('deposit')}>
              {t('wallet.deposit')}
            </Button>
            <Button size="lg" variant="outline" onClick={() => setTab('withdraw')}>
              {t('wallet.withdraw')}
            </Button>
          </div>

          {hasLocked && wallet ? (
            <p className="mt-2 text-center text-[10px] text-muted">
              {t('wallet.inEscrowShort', {
                escrow: formatCredits(wallet.escrow),
                locked: formatCredits(wallet.locked),
              })}
            </p>
          ) : null}
        </div>
      </Panel>

      {lowBalance ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2.5">
          <div>
            <p className="text-xs font-semibold text-warn">{t('wallet.lowBalance')}</p>
            <p className="text-[11px] text-muted">{t('wallet.lowBalanceBody')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={dismissLowBalance}
              className="text-[11px] font-semibold text-muted"
            >
              {t('wallet.notNow')}
            </button>
            <Button size="sm" onClick={() => setTab('deposit')}>
              {t('wallet.depositNow')}
            </Button>
          </div>
        </div>
      ) : null}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'deposit', label: t('wallet.deposit') },
          { value: 'withdraw', label: t('wallet.withdraw') },
          { value: 'history', label: t('wallet.history') },
        ]}
      />

      {tab === 'deposit' ? (
        <DepositPanel
          onChanged={bump}
          onViewHistory={() => {
            setHistorySection('finances');
            setTab('history');
          }}
        />
      ) : null}
      {tab === 'withdraw' ? <WithdrawPanel onChanged={bump} /> : null}
      {tab === 'history' ? (
        <HistoryPanel section={historySection} onSectionChange={setHistorySection} />
      ) : null}
    </div>
  );
}
