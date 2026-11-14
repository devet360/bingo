'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  cancelWithdrawal,
  createDeposit,
  createWithdrawal,
  fetchDeposit,
  fetchDepositProviders,
  fetchDeposits,
  fetchTransactions,
  fetchWithdrawals,
  newIdempotencyKey,
  verifyDepositReceipt,
} from '@/lib/api';
import {
  PAYMENT_METHODS,
  creditsToMinor,
  formatCredits,
  formatDateTime,
  formatStake,
  minorToCreditsInput,
} from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/components/session';
import {
  Button,
  CopyButton,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Pill,
  Select,
  Spinner,
  Stat,
  Tabs,
  cn,
} from '@/components/ui';
import type {
  Deposit,
  DepositProvider,
  DepositStatus,
  PaymentMethod,
  TransactionLine,
  VerificationStatus,
  Withdrawal,
  WithdrawalStatus,
} from '@/lib/types';

type Tab = 'deposit' | 'withdraw' | 'history';

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

/** The bank receipt page, fetched by the payer's device because of geo-blocks. */
async function fetchBankReceipt(url: string): Promise<{ contentType?: string; bodyBase64: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Bank responded ${response.status}`);
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_RECEIPT_BYTES) throw new Error('Receipt page is too large');
    return {
      contentType: response.headers.get('content-type') ?? undefined,
      bodyBase64: bytesToBase64(new Uint8Array(body)),
    };
  } finally {
    clearTimeout(timer);
  }
}

function DepositPanel({ onChanged }: { onChanged: () => void }) {
  const { refreshWallet, wallet } = useSession();
  const { t } = useI18n();
  const [amount, setAmount] = useState('');
  const [providerCode, setProviderCode] = useState('');
  const [reference, setReference] = useState('');
  const [receiptAccount, setReceiptAccount] = useState('');
  const [receiptPhone, setReceiptPhone] = useState('');
  const [note, setNote] = useState('');
  const [proof, setProof] = useState<{ contentType: string; base64: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Deposit | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Deposit[]>([]);
  const [providers, setProviders] = useState<DepositProvider[]>([]);
  const [verifying, setVerifying] = useState(false);
  const idempotency = useRef(newIdempotencyKey('dep'));

  const provider = providers.find((item) => item.code === providerCode) ?? null;
  const createdProvider = providers.find((item) => item.code === created?.providerCode) ?? null;
  const account = created?.paymentAccount ?? null;
  const open = Boolean(created && (created.status === 'PENDING' || created.status === 'PROCESSING'));

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

  /** "I have paid": submit the reference, try the bank page, fall back to proof. */
  const markPaid = async () => {
    if (!created) return;
    if (!reference.trim()) {
      setError(t('wallet.receiptReferenceRequired'));
      return;
    }
    if (createdProvider?.accountDigits && receiptAccount.replace(/\D/g, '').length < createdProvider.accountDigits) {
      setError(t('wallet.receiptAccount', { count: createdProvider.accountDigits }));
      return;
    }
    if (createdProvider?.requiresPhone && !receiptPhone.trim()) {
      setError(t('wallet.receiptPhone'));
      return;
    }
    setVerifying(true);
    setError(null);
    setNotice(null);
    const body = {
      receiptReference: reference.trim(),
      receiptAccount: receiptAccount.trim() || undefined,
      receiptPhone: receiptPhone.trim() || undefined,
    };
    const proofBody = proof
      ? { proofBase64: proof.base64, proofContentType: proof.contentType }
      : {};
    try {
      let result = await verifyDepositReceipt(
        created.code,
        createdProvider?.clientSide ? body : { ...body, ...proofBody },
      );
      if (result.needsClientFetch && result.data.clientReceiptUrl) {
        try {
          const bank = await fetchBankReceipt(result.data.clientReceiptUrl);
          result = await verifyDepositReceipt(created.code, { ...body, ...bank });
        } catch {
          if (!proof) throw new Error('BANK_FETCH_FAILED');
          result = await verifyDepositReceipt(created.code, { ...body, ...proofBody });
        }
      }
      setCreated(result.data);
      setNotice(result.autoCredited ? t('wallet.depositCredited') : result.verification.message);
      await Promise.all([loadPending(), onChanged()]);
      void refreshWallet();
    } catch (cause) {
      if (cause instanceof ApiError) setError(cause.message);
      else if (cause instanceof Error && cause.message === 'BANK_FETCH_FAILED') {
        setError(t('wallet.bankFetchFailed'));
      } else {
        setError(t('wallet.bankFetchFailed'));
      }
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

  const submit = async () => {
    const minor = creditsToMinor(amount);
    if (minor === null) {
      setError(t('wallet.invalidAmount'));
      return;
    }
    if (!provider) {
      setError(t('wallet.chooseMethod'));
      return;
    }
    if (provider.minAmount && BigInt(minor) < BigInt(provider.minAmount)) {
      setError(t('wallet.providerLimits', { min: formatStake(provider.minAmount), max: provider.maxAmount ? formatStake(provider.maxAmount) : '∞' }));
      return;
    }
    if (provider.maxAmount && BigInt(minor) > BigInt(provider.maxAmount)) {
      setError(t('wallet.providerLimits', { min: formatStake(provider.minAmount), max: formatStake(provider.maxAmount) }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const deposit = await createDeposit({
        amount: minor,
        method: provider.method,
        providerCode: provider.code,
        playerNote: note.trim() || undefined,
        idempotencyKey: idempotency.current,
      });
      idempotency.current = newIdempotencyKey('dep');
      setCreated(deposit);
      setAmount('');
      setReference('');
      setReceiptAccount('');
      setReceiptPhone('');
      setNote('');
      setProof(null);
      await Promise.all([loadPending(), onChanged()]);
      void refreshWallet();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('wallet.couldNotDeposit'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {created ? (
        <Panel className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-bold">{t('wallet.depositOpened')}</h2>
              <p className="text-[11px] text-muted">
                {PAYMENT_METHODS.find((item) => item.value === created.method)?.label}
                {created.providerCode ? ` · ${createdProvider?.name ?? created.providerCode}` : ''} ·{' '}
                {formatCredits(created.amount)} credits
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <StatusPill status={created.status} />
              <VerificationPill status={created.verificationStatus} />
            </div>
          </div>
          {open && created.agent ? (
            <div className="mt-3 rounded-xl border border-mint/30 bg-mint/5 p-3 text-[11px]">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-mint">
                {t('wallet.paymentDetails')}
              </p>
              <p className="mt-1 font-semibold text-text">
                {t('wallet.payAgent', {
                  name: created.agent.displayName ?? created.agent.agentCode,
                })}
                {created.agent.isOnline ? ` · ${t('wallet.online')}` : ''}
              </p>
              <p className="text-muted">{created.agent.agentCode}</p>
              {account ? (
                <div className="mt-2 rounded-lg bg-ink/50 p-2.5">
                  <p className="text-text">
                    {account.accountName}
                    {account.provider ? <span className="text-muted"> · {account.provider}</span> : null}
                  </p>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="font-mono text-sm tracking-wide text-gold">{account.accountNumber}</span>
                    <CopyButton value={account.accountNumber} />
                  </div>
                  {account.instructions ? <p className="mt-1 text-muted">{account.instructions}</p> : null}
                </div>
              ) : null}
              <p className="mt-2 text-muted">
                {t('wallet.depositCodeHint')}{' '}
                <span className="font-display font-bold tracking-[0.2em] text-text">{created.code}</span>
              </p>
            </div>
          ) : (
            <div className="mt-3">
              <CodeBlock
                label={t('wallet.depositCode')}
                code={created.code}
                hint={`${t('wallet.depositCodeHint')} ${t('wallet.depositExpires', { when: formatDateTime(created.expiresAt) })}`}
              />
            </div>
          )}

          {open && createdProvider ? (
            <div className="mt-3 space-y-3">
              <Input
                label={t('wallet.receiptReference')}
                placeholder={createdProvider.refHint ?? 'FT…'}
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                hint={createdProvider.refHint ?? undefined}
              />
              {createdProvider.accountDigits || createdProvider.requiresPhone ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {createdProvider.accountDigits ? (
                    <Input
                      label={t('wallet.receiptAccount', { count: createdProvider.accountDigits })}
                      inputMode="numeric"
                      value={receiptAccount}
                      onChange={(event) => setReceiptAccount(event.target.value)}
                    />
                  ) : null}
                  {createdProvider.requiresPhone ? (
                    <Input
                      label={t('wallet.receiptPhone')}
                      inputMode="tel"
                      placeholder="+2519…"
                      value={receiptPhone}
                      onChange={(event) => setReceiptPhone(event.target.value)}
                    />
                  ) : null}
                </div>
              ) : null}
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
                  {t('wallet.proofLabel')}
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => void attachProof(event.target.files?.[0] ?? null)}
                  className="block w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-raised file:px-3 file:py-2 file:text-xs file:font-semibold file:text-text"
                />
                <span className="mt-1 block text-[10px] text-muted">
                  {proof ? t('wallet.proofSelected', { name: proof.name }) : t('wallet.proofHint')}
                </span>
              </label>
              <Button className="w-full" loading={verifying} onClick={() => void markPaid()}>
                {verifying ? t('wallet.verifying') : t('wallet.iHavePaid')}
              </Button>
            </div>
          ) : null}

          {created.receiptReference ? (
            <p className="mt-2 text-[11px] text-muted">
              {t('wallet.receiptReference')}: <span className="font-mono text-text">{created.receiptReference}</span>
            </p>
          ) : null}
          {created.verificationMessage ? (
            <p className="mt-1 text-[11px] text-muted">{created.verificationMessage}</p>
          ) : null}
          {notice ? <p className="mt-2 text-[11px] text-mint">{notice}</p> : null}
          <p className="mt-2 text-[11px] text-muted">{t('wallet.depositBalanceNote')}</p>
        </Panel>
      ) : null}

      <Panel className="p-4">
        <h2 className="font-display text-base font-bold">{t('wallet.buyCredits')}</h2>
        <p className="mt-0.5 text-[11px] text-muted">{t('wallet.buyCreditsBlurb')}</p>

        <div className="mt-3">
          <Select
            label={t('wallet.provider')}
            value={providerCode}
            onChange={(event) => setProviderCode(event.target.value)}
          >
            <option value="">{t('wallet.chooseMethod')}</option>
            {providers.map((item) => (
              <option key={item.code} value={item.code}>
                {item.name} · {PAYMENT_METHODS.find((entry) => entry.value === item.method)?.label}
              </option>
            ))}
          </Select>
          {providers.length === 0 ? (
            <p className="mt-1 text-[11px] text-warn">{t('wallet.noDepositMethods')}</p>
          ) : null}
        </div>

        {provider ? (
          <div className="mt-3 rounded-xl border border-gold/25 bg-gold/5 p-3 text-[11px] text-muted">
            <p className="font-semibold text-gold">
              {provider.name}
              {provider.minAmount || provider.maxAmount ? (
                <span className="ml-2 font-normal">
                  {formatStake(provider.minAmount ?? undefined)} –{' '}
                  {provider.maxAmount ? formatStake(provider.maxAmount) : '∞'} cr
                </span>
              ) : null}
            </p>
            {provider.instructions ? <p className="mt-1">{provider.instructions}</p> : null}
            <p className="mt-1">
              {provider.supported ? t('wallet.autoCheckOn') : t('wallet.manualConfirm')}
            </p>
          </div>
        ) : null}

        <div className="mt-3">
          <Input
            label={t('wallet.amount')}
            inputMode="decimal"
            placeholder="50"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>

        <div className="mt-3">
          <Input
            label={t('wallet.noteOptional')}
            placeholder="Cash at Main Street kiosk"
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
          loading={busy}
          disabled={!provider || providers.length === 0}
          onClick={() => void submit()}
        >
          {t('wallet.openDeposit')}
        </Button>
        {wallet ? (
          <p className="mt-2 text-center text-[10px] text-muted">
            {t('wallet.currentBalance', { amount: formatCredits(wallet.available) })}
          </p>
        ) : null}
      </Panel>

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
                  {formatCredits(deposit.amount)} cr · {formatDateTime(deposit.createdAt)} ·
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
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('MOBILE_MONEY');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Withdrawal | null>(null);
  const [open, setOpen] = useState<Withdrawal[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const idempotency = useRef(newIdempotencyKey('wd'));

  const loadOpen = useCallback(async () => {
    try {
      const withdrawals = await fetchWithdrawals();
      setOpen(withdrawals.filter((item) => item.status === 'ESCROWED'));
    } catch {
      // Leave the form usable even when the queue is unreachable.
    }
  }, []);

  useEffect(() => {
    void loadOpen();
  }, [loadOpen]);

  const submit = async () => {
    const minor = creditsToMinor(amount);
    if (minor === null) {
      setError(t('wallet.invalidAmount'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const withdrawal = await createWithdrawal({
        amount: minor,
        method,
        playerNote: note.trim() || undefined,
        idempotencyKey: idempotency.current,
      });
      idempotency.current = newIdempotencyKey('wd');
      setCreated(withdrawal);
      setAmount('');
      setNote('');
      await Promise.all([loadOpen(), onChanged()]);
      void refreshWallet();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('wallet.couldNotWithdraw'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    setCancelling(id);
    try {
      await cancelWithdrawal(id);
      setCreated((current) => (current?.id === id ? null : current));
      await Promise.all([loadOpen(), onChanged()]);
      void refreshWallet();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('wallet.couldNotCancel'));
    } finally {
      setCancelling(null);
    }
  };

  const max = wallet ? minorToCreditsInput(wallet.available) : '';

  return (
    <div className="space-y-3">
      {created ? (
        <Panel className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-bold">{t('wallet.payoutReserved')}</h2>
              <p className="text-[11px] text-muted">
                {t('wallet.heldEscrowNet', {
                  amount: formatCredits(created.amount),
                  net: formatCredits(created.netAmount),
                })}
              </p>
            </div>
            <StatusPill status={created.status} />
          </div>
          <div className="mt-3">
            <CodeBlock
              label={t('wallet.payoutCode')}
              code={created.payoutCode}
              hint={t('wallet.payoutCodeHint')}
            />
          </div>
        </Panel>
      ) : null}

      <Panel className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-bold">{t('wallet.cashOut')}</h2>
            <p className="mt-0.5 text-[11px] text-muted">
              {t('wallet.cashOutBlurb')}
            </p>
          </div>
          <span className="text-right text-[10px] text-muted">
            {t('wallet.available')}
            <span className="block font-display text-sm font-bold text-gold">
              {wallet ? formatCredits(wallet.available) : '—'}
            </span>
          </span>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="relative">
            <Input
              label={t('wallet.amount')}
              inputMode="decimal"
              placeholder="50"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <button
              type="button"
              onClick={() => setAmount(max)}
              className="absolute right-2 top-[30px] rounded-md bg-raised px-2 py-1 text-[10px] font-bold uppercase text-mint"
            >
              {t('wallet.max')}
            </button>
          </div>
          <Select
            label={t('wallet.paymentMethod')}
            value={method}
            onChange={(event) => setMethod(event.target.value as PaymentMethod)}
          >
            {PAYMENT_METHODS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <p className="mt-3 rounded-xl border border-line/70 bg-ink/40 px-3 py-2 text-[11px] text-muted">
          {t('wallet.anyAgentPays')}
        </p>
        <div className="mt-3">
          <Input
            label={t('wallet.noteOptional')}
            placeholder="Payout at the market stall"
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
          variant="gold"
          loading={busy}
          onClick={() => void submit()}
        >
          {t('wallet.requestPayout')}
        </Button>
      </Panel>

      {open.length > 0 ? (
        <Panel className="p-4">
          <h2 className="mb-2 font-display text-sm font-bold uppercase tracking-wider text-muted">
            {t('wallet.openPayouts')}
          </h2>
          <ul className="space-y-2">
            {open.map((withdrawal) => (
              <li key={withdrawal.id} className="rounded-xl border border-line/70 bg-ink/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-lg font-bold tracking-[0.2em]">
                    {withdrawal.payoutCode}
                  </span>
                  <StatusPill status={withdrawal.status} />
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <p className="text-[11px] text-muted">
                    {formatCredits(withdrawal.amount)} cr · {formatDateTime(withdrawal.createdAt)}
                  </p>
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
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

function HistoryPanel() {
  const { t } = useI18n();
  const [lines, setLines] = useState<TransactionLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLines(await fetchTransactions(60));
      setError(null);
    } catch {
      setError(t('wallet.historyError'));
    }
  }, []);

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
  if (lines.length === 0) {
    return <EmptyState title={t('wallet.noMovements')} body={t('wallet.noMovementsBody')} />;
  }

  return (
    <Panel className="divide-y divide-line/60">
      {lines.map((line) => {
        const negative = line.amount.startsWith('-');
        return (
          <div key={line.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold">
                {line.kind.replaceAll('_', ' ').toLowerCase()}
                {line.memo ? <span className="font-normal text-muted"> · {line.memo}</span> : null}
              </p>
              <p className="text-[10px] text-muted">
                {line.account} · {formatDateTime(line.createdAt)}
              </p>
            </div>
            <div className="text-right">
              <p
                className={cn(
                  'font-display text-sm font-bold tabular-nums',
                  negative ? 'text-muted' : 'text-mint',
                )}
              >
                {negative ? '' : '+'}
                {formatCredits(line.amount)}
              </p>
              <p className="text-[10px] text-muted">bal {formatCredits(line.balanceAfter)}</p>
            </div>
          </div>
        );
      })}
    </Panel>
  );
}

export default function WalletPage() {
  const { wallet, refreshWallet } = useSession();
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('deposit');

  const bump = useCallback(async () => {
    await refreshWallet().catch(() => undefined);
  }, [refreshWallet]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-black tracking-tight">{t('wallet.title')}</h1>
        <p className="text-xs text-muted">{t('wallet.blurb')}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t('wallet.playable')} value={wallet ? formatCredits(wallet.available) : '—'} />
        <Stat label={t('wallet.escrow')} value={wallet ? formatCredits(wallet.escrow) : '—'} />
        <Stat label={t('wallet.inPlay')} value={wallet ? formatCredits(wallet.locked) : '—'} />
        <Stat
          label={t('wallet.lifetimeWon')}
          value={wallet ? formatCredits(wallet.lifetimeWon) : '—'}
          className="col-span-2 sm:col-span-1"
        />
      </div>

      <div className="flex items-center justify-between px-1 text-[11px] text-muted">
        <span>
          {t('wallet.depositedWithdrawn', {
            deposited: wallet ? formatCredits(wallet.lifetimeDeposited) : '—',
            withdrawn: wallet ? formatCredits(wallet.lifetimeWithdrawn) : '—',
            wagered: wallet ? formatCredits(wallet.lifetimeWagered) : '—',
          })}
        </span>
        <button type="button" onClick={() => void bump()} className="font-semibold text-mint">
          {t('common.refresh')}
        </button>
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'deposit', label: t('wallet.deposit') },
          { value: 'withdraw', label: t('wallet.withdraw') },
          { value: 'history', label: t('wallet.history') },
        ]}
      />

      {tab === 'deposit' ? <DepositPanel onChanged={bump} /> : null}
      {tab === 'withdraw' ? <WithdrawPanel onChanged={bump} /> : null}
      {tab === 'history' ? <HistoryPanel /> : null}
    </div>
  );
}
