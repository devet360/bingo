'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  cancelWithdrawal,
  createDeposit,
  createWithdrawal,
  fetchAgents,
  fetchDeposits,
  fetchTransactions,
  fetchWithdrawals,
  newIdempotencyKey,
} from '@/lib/api';
import {
  PAYMENT_METHODS,
  creditsToMinor,
  formatCredits,
  formatDateTime,
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
  Agent,
  Deposit,
  DepositStatus,
  PaymentMethod,
  TransactionLine,
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

function StatusPill({ status }: { status: DepositStatus | WithdrawalStatus | string }) {
  return <Pill tone={STATUS_TONE[status] ?? 'neutral'}>{status.toLowerCase()}</Pill>;
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

function DepositPanel({ onChanged }: { onChanged: () => void }) {
  const { refreshWallet, wallet } = useSession();
  const { t } = useI18n();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('MOBILE_MONEY');
  const [agentCode, setAgentCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Deposit | null>(null);
  const [pending, setPending] = useState<Deposit[]>([]);
  const idempotency = useRef(newIdempotencyKey('dep'));

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
  }, [loadPending]);

  const submit = async () => {
    const minor = creditsToMinor(amount);
    if (minor === null) {
      setError(t('wallet.invalidAmount'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const deposit = await createDeposit({
        amount: minor,
        method,
        agentCode: agentCode.trim() || undefined,
        playerNote: note.trim() || undefined,
        idempotencyKey: idempotency.current,
      });
      idempotency.current = newIdempotencyKey('dep');
      setCreated(deposit);
      setAmount('');
      setNote('');
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
                {PAYMENT_METHODS.find((item) => item.value === created.method)?.label} ·{' '}
                {formatCredits(created.amount)} credits
              </p>
            </div>
            <StatusPill status={created.status} />
          </div>
          <div className="mt-3">
            <CodeBlock
              label={t('wallet.depositCode')}
              code={created.code}
              hint={`${t('wallet.depositCodeHint')} ${t('wallet.depositExpires', { when: formatDateTime(created.expiresAt) })}`}
            />
          </div>
          <p className="mt-2 text-[11px] text-muted">
            {t('wallet.depositBalanceNote')}
          </p>
        </Panel>
      ) : null}

      <Panel className="p-4">
        <h2 className="font-display text-base font-bold">{t('wallet.buyCredits')}</h2>
        <p className="mt-0.5 text-[11px] text-muted">
          {t('wallet.buyCreditsBlurb')}
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Input
            label={t('wallet.amount')}
            inputMode="decimal"
            placeholder="50"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
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
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Input
            label={t('wallet.agentCodeOptional')}
            placeholder="AG-1234"
            value={agentCode}
            onChange={(event) => setAgentCode(event.target.value)}
          />
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
        <Button className="mt-3 w-full" loading={busy} onClick={() => void submit()}>
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
                  <StatusPill status={deposit.status} />
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
  const [agentId, setAgentId] = useState('');
  const [note, setNote] = useState('');
  const [agents, setAgents] = useState<Agent[]>([]);
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
    fetchAgents()
      .then((list) => {
        setAgents(list);
        const online = list.find((agent) => agent.isOnline);
        if (online) setAgentId(online.id);
        else if (list[0]) setAgentId(list[0].id);
      })
      .catch(() => undefined);
  }, [loadOpen]);

  const submit = async () => {
    const minor = creditsToMinor(amount);
    if (minor === null) {
      setError(t('wallet.invalidAmount'));
      return;
    }
    if (!agentId) {
      setError('Pick an agent to hand you the payout.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const withdrawal = await createWithdrawal({
        amount: minor,
        method,
        agentProfileId: agentId,
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
        <div className="mt-3">
          <Select
            label={t('wallet.payingAgent')}
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <option value="">{t('wallet.chooseAgent')}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.displayName ?? agent.agentCode} · {agent.region}
                {agent.isOnline ? ' · online' : ' · offline'}
              </option>
            ))}
          </Select>
          {agents.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted">
              {t('wallet.noAgents')}
            </p>
          ) : null}
        </div>
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
          disabled={agents.length === 0}
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
