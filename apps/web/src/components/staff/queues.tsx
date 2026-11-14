'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  cancelDepositByStaff,
  cancelWithdrawalByStaff,
  fetchStaffAgents,
  fetchStaffDeposits,
  fetchStaffTransactions,
  fetchStaffWithdrawals,
  newIdempotencyKey,
  topUpAgentFloat,
  updateAgentByAdmin,
} from '@/lib/api';
import { PAYMENT_METHODS, creditsToMinor, formatCredits, formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type {
  Agent,
  DepositStatus,
  PageMeta,
  PaymentMethod,
  StaffDeposit,
  StaffWithdrawal,
  LedgerView,
  WithdrawalStatus,
} from '@/lib/types';
import {
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Pill,
  Select,
  Sheet,
  cn,
} from '@/components/ui';
import {
  DEPOSIT_STATUSES,
  FilterBar,
  LEDGER_KINDS,
  LoadingBlock,
  Pager,
  StatusPill,
  WITHDRAWAL_STATUSES,
} from './shared';

export function TransactionsTab() {
  const { t } = useI18n();
  const [kind, setKind] = useState('ALL');
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<LedgerView[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchStaffTransactions({
        kind: kind === 'ALL' ? undefined : kind,
        userId: userId.trim() || undefined,
        page,
      });
      setRows(result.data);
      setMeta(result.page);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    }
  }, [kind, userId, page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel className="overflow-hidden">
      <FilterBar>
        <div className="w-52">
          <Select
            label={t('staff.kind')}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              setPage(0);
            }}
          >
            <option value="ALL">{t('common.all')}</option>
            {LEDGER_KINDS.map((option) => (
              <option key={option} value={option}>
                {option.replaceAll('_', ' ').toLowerCase()}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-[240px] flex-1">
          <Input
            label="User ID (optional)"
            placeholder="uuid"
            value={userId}
            onChange={(event) => {
              setUserId(event.target.value);
              setPage(0);
            }}
          />
        </div>
      </FilterBar>

      {error ? (
        <div className="p-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}

      {rows === null ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title={t('staff.noRows')} />
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {rows.map((ledger) => (
            <li key={ledger.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold">
                    {ledger.kind.replaceAll('_', ' ').toLowerCase()}
                  </p>
                  <p className="text-[10px] text-muted">
                    {formatDateTime(ledger.createdAt)}
                    {ledger.memo ? ` · ${ledger.memo}` : ''}
                  </p>
                </div>
                <span className="text-[10px] text-muted">{ledger.id.slice(0, 8)}</span>
              </div>
              <div className="mt-1.5 grid gap-1 sm:grid-cols-2">
                {ledger.entries.map((entry, index) => (
                  <div
                    key={`${ledger.id}-${index}`}
                    className="flex items-center justify-between gap-2 rounded-lg bg-ink/40 px-2 py-1 text-[10px]"
                  >
                    <span className="truncate text-muted">
                      {entry.accountCode} · {entry.ownerKind}
                    </span>
                    <span
                      className={cn(
                        'font-semibold tabular-nums',
                        entry.amount.startsWith('-') ? 'text-muted' : 'text-mint',
                      )}
                    >
                      {formatCredits(entry.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="px-4 pb-3">
        <Pager page={meta} onPage={setPage} />
      </div>
    </Panel>
  );
}

function PlayerCell({ player, agentCode }: { player: { displayName: string; phone: string | null }; agentCode: string | null }) {
  return (
    <div>
      <p className="text-xs font-semibold">{player.displayName}</p>
      <p className="text-[10px] text-muted">
        {player.phone ?? 'no phone'}
        {agentCode ? ` · agent ${agentCode}` : ''}
      </p>
    </div>
  );
}

export function DepositsTab() {
  const { t } = useI18n();
  const [status, setStatus] = useState<'ALL' | DepositStatus>('ALL');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<StaffDeposit[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchStaffDeposits({
        status: status === 'ALL' ? undefined : status,
        page,
      });
      setRows(result.data);
      setMeta(result.page);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    }
  }, [status, page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = async (deposit: StaffDeposit) => {
    setBusy(deposit.id);
    try {
      await cancelDepositByStaff(deposit.id);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel className="overflow-hidden">
      <FilterBar>
        <div className="w-44">
          <Select
            label={t('common.status')}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as 'ALL' | DepositStatus);
              setPage(0);
            }}
          >
            <option value="ALL">{t('common.all')}</option>
            {DEPOSIT_STATUSES.map((option) => (
              <option key={option} value={option}>
                {option.toLowerCase()}
              </option>
            ))}
          </Select>
        </div>
      </FilterBar>
      {error ? (
        <div className="p-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {rows === null ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title={t('staff.noRows')} />
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {rows.map((deposit) => (
            <li key={deposit.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="font-display text-lg font-bold tracking-[0.18em]">{deposit.code}</span>
                <div>
                  <PlayerCell player={deposit.player} agentCode={deposit.agentCode} />
                  <p className="text-[10px] text-muted">
                    {formatCredits(deposit.amount)} ·{' '}
                    {deposit.method.toLowerCase().replaceAll('_', ' ')} · {formatDateTime(deposit.createdAt)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill status={deposit.status} />
                {deposit.status === 'PENDING' || deposit.status === 'PROCESSING' ? (
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busy === deposit.id}
                    onClick={() => void cancel(deposit)}
                  >
                    {t('staff.cancelRequest')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="px-4 pb-3">
        <Pager page={meta} onPage={setPage} />
      </div>
    </Panel>
  );
}

export function WithdrawalsTab() {
  const { t } = useI18n();
  const [status, setStatus] = useState<'ALL' | WithdrawalStatus>('ALL');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<StaffWithdrawal[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchStaffWithdrawals({
        status: status === 'ALL' ? undefined : status,
        page,
      });
      setRows(result.data);
      setMeta(result.page);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    }
  }, [status, page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = async (withdrawal: StaffWithdrawal) => {
    setBusy(withdrawal.id);
    try {
      await cancelWithdrawalByStaff(withdrawal.id);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel className="overflow-hidden">
      <FilterBar>
        <div className="w-44">
          <Select
            label={t('common.status')}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as 'ALL' | WithdrawalStatus);
              setPage(0);
            }}
          >
            <option value="ALL">{t('common.all')}</option>
            {WITHDRAWAL_STATUSES.map((option) => (
              <option key={option} value={option}>
                {option.toLowerCase()}
              </option>
            ))}
          </Select>
        </div>
      </FilterBar>
      {error ? (
        <div className="p-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {rows === null ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title={t('staff.noRows')} />
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {rows.map((withdrawal) => (
            <li key={withdrawal.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="font-display text-lg font-bold tracking-[0.18em]">
                  {withdrawal.payoutCode}
                </span>
                <div>
                  <PlayerCell player={withdrawal.player} agentCode={withdrawal.agentCode} />
                  <p className="text-[10px] text-muted">
                    {formatCredits(withdrawal.amount)} · net {formatCredits(withdrawal.netAmount)} ·{' '}
                    {formatDateTime(withdrawal.createdAt)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill status={withdrawal.status} />
                {withdrawal.status === 'ESCROWED' ? (
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busy === withdrawal.id}
                    onClick={() => void cancel(withdrawal)}
                  >
                    {t('staff.cancelRequest')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="px-4 pb-3">
        <Pager page={meta} onPage={setPage} />
      </div>
    </Panel>
  );
}

const AGENT_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'] as const;
const AGENT_TIERS = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'] as const;

export function AgentsTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [floatTarget, setFloatTarget] = useState<Agent | null>(null);
  const [floatAmount, setFloatAmount] = useState('');
  const [floatMethod, setFloatMethod] = useState<PaymentMethod>('BANK_TRANSFER');
  const [floatBusy, setFloatBusy] = useState(false);
  const idempotency = useRef(newIdempotencyKey('float'));

  const load = useCallback(async () => {
    try {
      setAgents(await fetchStaffAgents());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = async (agent: Agent, patch: { status?: string; tier?: string }) => {
    setBusy(agent.id);
    setNotice(null);
    try {
      await updateAgentByAdmin(agent.id, patch);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setBusy(null);
    }
  };

  const submitFloat = async () => {
    if (!floatTarget) return;
    const minor = creditsToMinor(floatAmount);
    if (minor === null) {
      setError('Enter an amount like 500 or 12.50.');
      return;
    }
    setFloatBusy(true);
    try {
      await topUpAgentFloat({
        agentId: floatTarget.id,
        amount: minor,
        method: floatMethod,
        idempotencyKey: idempotency.current,
      });
      idempotency.current = newIdempotencyKey('float');
      setNotice(`Float topped up for ${floatTarget.agentCode}.`);
      setFloatTarget(null);
      setFloatAmount('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setFloatBusy(false);
    }
  };

  return (
    <>
      {notice ? (
        <p className="mb-3 rounded-xl border border-mint/30 bg-mint/10 px-3 py-2 text-xs text-mint">
          {notice}
        </p>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {agents === null ? (
        <Panel>
          <LoadingBlock />
        </Panel>
      ) : agents.length === 0 ? (
        <Panel className="p-4">
          <EmptyState title="No agents yet" body="Create an agent from the Staff tab." />
        </Panel>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {agents.map((agent) => (
            <li key={agent.id} className="rounded-2xl border border-line/80 bg-panel/90 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-display text-sm font-bold">
                    {agent.displayName ?? agent.agentCode}
                  </p>
                  <p className="text-[10px] text-muted">
                    {agent.agentCode} · {agent.region}
                    {agent.city ? ` · ${agent.city}` : ''}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted">
                    ★ {Number(agent.ratingAvg).toFixed(1)} ({agent.ratingCount}) ·{' '}
                    {agent.completedDeposits} in / {agent.completedWithdrawals} out
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusPill status={agent.status} />
                  <Pill tone={agent.isOnline ? 'mint' : 'neutral'}>
                    {agent.isOnline ? t('common.online') : t('common.offline')}
                  </Pill>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-ink/50 py-1.5">
                  <p className="text-[9px] uppercase tracking-wide text-muted">{t('staff.myFloat')}</p>
                  <p className="font-display text-xs font-bold text-gold">
                    {agent.floatAvailable ? formatCredits(agent.floatAvailable) : '—'}
                  </p>
                </div>
                <div className="rounded-lg bg-ink/50 py-1.5">
                  <p className="text-[9px] uppercase tracking-wide text-muted">{t('staff.floatEscrow')}</p>
                  <p className="font-display text-xs font-bold">
                    {agent.floatEscrow ? formatCredits(agent.floatEscrow) : '—'}
                  </p>
                </div>
                <div className="rounded-lg bg-ink/50 py-1.5">
                  <p className="text-[9px] uppercase tracking-wide text-muted">{t('staff.commission')}</p>
                  <p className="font-display text-xs font-bold text-mint">
                    {agent.commissionEarned ? formatCredits(agent.commissionEarned) : '—'}
                  </p>
                </div>
              </div>

              {canManage ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Select
                    className="h-9 w-32 text-xs"
                    value={agent.tier}
                    disabled={busy === agent.id}
                    onChange={(event) => void update(agent, { tier: event.target.value })}
                  >
                    {AGENT_TIERS.map((tier) => (
                      <option key={tier} value={tier}>
                        {tier}
                      </option>
                    ))}
                  </Select>
                  <Select
                    className="h-9 w-32 text-xs"
                    value={agent.status}
                    disabled={busy === agent.id}
                    onChange={(event) => void update(agent, { status: event.target.value })}
                  >
                    {AGENT_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="gold"
                    onClick={() => {
                      setFloatTarget(agent);
                      setFloatAmount('');
                      setError(null);
                    }}
                  >
                    Top up float
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Sheet open={floatTarget !== null} title="Top up agent float" onClose={() => setFloatTarget(null)}>
        {floatTarget ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              {floatTarget.agentCode} · current float{' '}
              {floatTarget.floatAvailable ? formatCredits(floatTarget.floatAvailable) : '—'}
            </p>
            <Input
              label="Amount (credits)"
              inputMode="decimal"
              placeholder="500"
              value={floatAmount}
              onChange={(event) => setFloatAmount(event.target.value)}
            />
            <Select
              label="Funding method"
              value={floatMethod}
              onChange={(event) => setFloatMethod(event.target.value as PaymentMethod)}
            >
              {PAYMENT_METHODS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <Button className="w-full" variant="gold" loading={floatBusy} onClick={() => void submitFloat()}>
              Approve float top-up
            </Button>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}
