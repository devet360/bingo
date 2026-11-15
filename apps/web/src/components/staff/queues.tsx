'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  cancelDepositByStaff,
  cancelWithdrawalByStaff,
  createAgentPaymentAccount,
  createStaffMember,
  fetchMediaBlobUrl,
  fetchStaffAgents,
  fetchStaffDeposits,
  fetchStaffTransactions,
  fetchStaffWithdrawals,
  newIdempotencyKey,
  reviewWithdrawalProof,
  topUpAgentFloat,
  updateAgentByAdmin,
} from '@/lib/api';
import { PAYMENT_METHODS, creditsToMinor, formatCredits, formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type {
  Agent,
  CreatedStaff,
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
  CopyButton,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Pill,
  Select,
  Sheet,
  Spinner,
  cn,
} from '@/components/ui';
import {
  DEPOSIT_STATUSES,
  FilterBar,
  LEDGER_KINDS,
  LoadingBlock,
  Pager,
  Row,
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

const PROOF_TONE: Record<string, 'mint' | 'gold' | 'blue' | 'danger' | 'neutral'> = {
  NOT_REQUIRED: 'neutral',
  PENDING: 'gold',
  MANUAL: 'blue',
  VERIFIED: 'mint',
  FAILED: 'danger',
};

export function WithdrawalsTab() {
  const { t } = useI18n();
  const [status, setStatus] = useState<'ALL' | WithdrawalStatus>('ALL');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<StaffWithdrawal[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<StaffWithdrawal | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewBusy, setReviewBusy] = useState<'VERIFIED' | 'FAILED' | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);

  const reviewProof = reviewTarget?.proofs[0] ?? null;

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

  useEffect(() => {
    setShotUrl(null);
    setShotError(null);
    if (!reviewProof?.mediaAssetId) return;
    let revoked: string | null = null;
    let cancelled = false;
    void fetchMediaBlobUrl(reviewProof.mediaAssetId)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        revoked = url;
        setShotUrl(url);
      })
      .catch(() => {
        if (!cancelled) setShotError('Could not load the screenshot.');
      });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [reviewProof?.mediaAssetId]);

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

  const openReview = (withdrawal: StaffWithdrawal) => {
    setReviewTarget(withdrawal);
    setReviewNote('');
    setReviewError(null);
  };

  const submitReview = async (decision: 'VERIFIED' | 'FAILED') => {
    if (!reviewTarget || !reviewProof) return;
    setReviewBusy(decision);
    setReviewError(null);
    try {
      await reviewWithdrawalProof(reviewTarget.id, reviewProof.id, {
        decision,
        note: reviewNote.trim() || undefined,
      });
      setReviewTarget(null);
      await load();
    } catch (caught) {
      setReviewError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setReviewBusy(null);
    }
  };

  return (
    <>
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
            {rows.map((withdrawal) => {
              const proof = withdrawal.proofs[0] ?? null;
              const reviewable =
                withdrawal.status === 'PROCESSING' &&
                proof !== null &&
                (proof.status === 'PENDING' || proof.status === 'MANUAL');
              return (
                <li key={withdrawal.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
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
                      {withdrawal.status === 'PROCESSING' || withdrawal.status === 'ESCROWED' ? (
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
                  </div>
                  {withdrawal.payoutAccount ? (
                    <p className="mt-1 text-[10px] text-muted">
                      Payout account: {withdrawal.payoutAccount.accountName} ·{' '}
                      <span className="font-mono">{withdrawal.payoutAccount.accountNumber}</span>
                      {withdrawal.payoutAccount.provider
                        ? ` · ${withdrawal.payoutAccount.provider}`
                        : ''}
                    </p>
                  ) : null}
                  {withdrawal.task ? (
                    <p className="text-[10px] text-muted">
                      Task {withdrawal.task.status.toLowerCase()}
                      {withdrawal.task.slaDeadline
                        ? ` · SLA ${formatDateTime(withdrawal.task.slaDeadline)}`
                        : ''}
                    </p>
                  ) : null}
                  {proof ? (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-ink/40 px-2.5 py-1.5">
                      <p className="text-[10px] text-muted">
                        Proof {proof.status.toLowerCase()}
                        {proof.reference ? ` · ref ${proof.reference}` : ''}
                        {proof.paidAmount ? ` · paid ${formatCredits(proof.paidAmount)}` : ''}
                      </p>
                      {reviewable ? (
                        <Button size="sm" variant="gold" onClick={() => openReview(withdrawal)}>
                          Review proof
                        </Button>
                      ) : null}
                    </div>
                  ) : withdrawal.status === 'PROCESSING' ? (
                    <p className="mt-1 text-[10px] text-warn">
                      {t('staff.noProofs')}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <div className="px-4 pb-3">
          <Pager page={meta} onPage={setPage} />
        </div>
      </Panel>

      <Sheet
        open={reviewTarget !== null}
        title="Review payout proof"
        onClose={() => setReviewTarget(null)}
      >
        {reviewTarget && reviewProof ? (
          <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            <div className="rounded-xl bg-ink/50 p-3 text-xs">
              <p>
                Payout{' '}
                <span className="font-display font-bold tracking-[0.2em] text-gold">
                  {reviewTarget.payoutCode}
                </span>{' '}
                · net {formatCredits(reviewTarget.netAmount)} ETB
              </p>
              <p className="mt-1 text-muted">
                {reviewTarget.player.displayName}
                {reviewTarget.player.phone ? ` · ${reviewTarget.player.phone}` : ''}
                {reviewTarget.agentCode ? ` · agent ${reviewTarget.agentCode}` : ''}
              </p>
              {reviewTarget.payoutAccount ? (
                <p className="mt-1 text-muted">
                  Target: {reviewTarget.payoutAccount.accountName} ·{' '}
                  <span className="font-mono">{reviewTarget.payoutAccount.accountNumber}</span>
                </p>
              ) : null}
            </div>

            <div className="space-y-1 rounded-xl border border-line/70 bg-ink/30 p-3 text-[11px]">
              <Row label="Status">
                <Pill tone={PROOF_TONE[reviewProof.status] ?? 'neutral'}>
                  {reviewProof.status.toLowerCase()}
                </Pill>
              </Row>
              <Row label="Reference">{reviewProof.reference ?? '—'}</Row>
              <Row label="Paid amount">
                {reviewProof.paidAmount ? formatCredits(reviewProof.paidAmount) : '—'}
              </Row>
              <Row label="Sender account">{reviewProof.senderAccount ?? '—'}</Row>
              <Row label="Receiver account">{reviewProof.receiverAccount ?? '—'}</Row>
              <Row label="Paid at">
                {reviewProof.paidAt ? formatDateTime(reviewProof.paidAt) : '—'}
              </Row>
              <Row label="Submitted">{formatDateTime(reviewProof.createdAt)}</Row>
              {reviewProof.notes ? <Row label="Notes">{reviewProof.notes}</Row> : null}
              {reviewProof.message ? <Row label="Message">{reviewProof.message}</Row> : null}
            </div>

            {reviewProof.mediaAssetId ? (
              <div className="rounded-xl border border-line/70 bg-ink/30 p-2">
                {shotUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={shotUrl} alt="Payment proof" className="max-h-72 w-full rounded-lg object-contain" />
                ) : shotError ? (
                  <p className="text-[11px] text-danger">{shotError}</p>
                ) : (
                  <div className="flex justify-center py-4">
                    <Spinner className="h-4 w-4 text-mint" />
                  </div>
                )}
              </div>
            ) : null}

            <Input
              label="Review note (optional)"
              value={reviewNote}
              onChange={(event) => setReviewNote(event.target.value)}
            />
            {reviewError ? <ErrorNote>{reviewError}</ErrorNote> : null}
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="danger"
                loading={reviewBusy === 'FAILED'}
                disabled={reviewBusy !== null}
                onClick={() => void submitReview('FAILED')}
              >
                Reject proof
              </Button>
              <Button
                variant="gold"
                loading={reviewBusy === 'VERIFIED'}
                disabled={reviewBusy !== null}
                onClick={() => void submitReview('VERIFIED')}
              >
                Verify & settle
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>
    </>
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
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedStaff | null>(null);
  const [accountTarget, setAccountTarget] = useState<Agent | null>(null);
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
      {canManage ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="max-w-xl text-[11px] text-muted">
            Players pay the account saved here — it appears the moment they pick a method.
          </p>
          <Button size="sm" variant="gold" onClick={() => setCreateOpen(true)}>
            Add agent
          </Button>
        </div>
      ) : null}
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
          <EmptyState
            title="No agents yet"
            body="An agent needs a login and a receiving account before players can deposit."
            action={
              canManage ? (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  Add the first agent
                </Button>
              ) : undefined
            }
          />
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

              {agent.paymentAccounts?.length ? (
                <p className="mt-2 truncate text-[10px] text-muted">
                  Pays to:{' '}
                  {agent.paymentAccounts
                    .map((entry) => `${entry.method.replaceAll('_', ' ')} ${entry.accountNumber}`)
                    .join(' · ')}
                </p>
              ) : (
                <p className="mt-2 rounded-lg border border-warn/30 bg-warn/10 px-2 py-1 text-[10px] text-warn">
                  No receiving account — players cannot pay this agent yet.
                </p>
              )}

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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setAccountTarget(agent);
                      setError(null);
                    }}
                  >
                    Add account
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
              label="Amount (ETB)"
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

      <CreateAgentSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(result) => {
          setCreateOpen(false);
          setCreated(result);
          void load();
        }}
      />

      <Sheet open={created !== null} title="Agent created" onClose={() => setCreated(null)}>
        {created ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              {created.user.displayName} · {created.agent?.agentCode ?? 'AGENT'}
            </p>
            <div className="rounded-xl border border-gold/30 bg-gold/5 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gold">
                Login password
              </p>
              <p className="mt-1 font-mono text-lg font-bold tracking-wider text-text">
                {created.temporaryPassword}
              </p>
              <div className="mt-2">
                <CopyButton value={created.temporaryPassword} label="Copy" />
              </div>
            </div>
            <p className="text-[11px] text-muted">
              Share this with the agent. They sign in at the agent portal with their phone or email
              and this password, then change it. Top up their float before they start accepting cash.
            </p>
          </div>
        ) : null}
      </Sheet>

      <AgentAccountSheet
        agent={accountTarget}
        onClose={() => setAccountTarget(null)}
        onSaved={() => {
          setAccountTarget(null);
          void load();
        }}
      />
    </>
  );
}

function CreateAgentSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: CreatedStaff) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [region, setRegion] = useState('Addis Ababa');
  const [city, setCity] = useState('');
  const [district, setDistrict] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('MOBILE_MONEY');
  const [accountName, setAccountName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!displayName.trim()) {
      setError('Enter the agent name.');
      return;
    }
    if (!phone.trim() && !email.trim()) {
      setError('Add a phone or email — the agent signs in with it.');
      return;
    }
    if (!region.trim()) {
      setError('Enter the region.');
      return;
    }
    if (!accountName.trim() || !accountNumber.trim()) {
      setError('Add the account that receives player deposits.');
      return;
    }
    setBusy(true);
    try {
      const result = await createStaffMember({
        role: 'AGENT',
        displayName: displayName.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        password: password.trim() || undefined,
        agent: {
          region: region.trim(),
          city: city.trim() || undefined,
          district: district.trim() || undefined,
          account: {
            method,
            accountName: accountName.trim(),
            accountNumber: accountNumber.trim(),
            instructions: instructions.trim() || undefined,
          },
        },
      });
      onCreated(result);
      setDisplayName('');
      setPhone('');
      setEmail('');
      setPassword('');
      setCity('');
      setDistrict('');
      setAccountName('');
      setAccountNumber('');
      setInstructions('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the agent.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title="Add agent" onClose={onClose}>
      <div className="space-y-3">
        <Input
          label="Agent name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Phone"
            placeholder="+2519…"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
          <Input
            label="Email (optional)"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Region" value={region} onChange={(event) => setRegion(event.target.value)} />
          <Input label="City" value={city} onChange={(event) => setCity(event.target.value)} />
          <Input label="District" value={district} onChange={(event) => setDistrict(event.target.value)} />
        </div>
        <Input
          label="Password (optional)"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint="Leave empty to generate a temporary password."
        />

        <div className="rounded-xl border border-line/70 bg-ink/40 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-mint">
            Receiving account
          </p>
          <p className="mt-1 text-[10px] text-muted">
            Players transfer here. Use the exact account the agent will check.
          </p>
          <div className="mt-2 space-y-3">
            <Select
              label="Method"
              value={method}
              onChange={(event) => setMethod(event.target.value as PaymentMethod)}
            >
              {PAYMENT_METHODS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <Input
              label="Account holder"
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
            />
            <Input
              label="Account number"
              inputMode="numeric"
              value={accountNumber}
              onChange={(event) => setAccountNumber(event.target.value)}
            />
            <Input
              label="Instructions (optional)"
              placeholder="Use the deposit code as the transfer reason"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </div>
        </div>

        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button className="w-full" loading={busy} onClick={() => void submit()}>
          Create agent
        </Button>
      </div>
    </Sheet>
  );
}

function AgentAccountSheet({
  agent,
  onClose,
  onSaved,
}: {
  agent: Agent | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>('MOBILE_MONEY');
  const [accountName, setAccountName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!agent) return;
    setError(null);
    if (!accountName.trim() || !accountNumber.trim()) {
      setError('Enter the account holder and number.');
      return;
    }
    setBusy(true);
    try {
      await createAgentPaymentAccount(agent.id, {
        method,
        accountName: accountName.trim(),
        accountNumber: accountNumber.trim(),
        instructions: instructions.trim() || undefined,
      });
      setAccountName('');
      setAccountNumber('');
      setInstructions('');
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the account.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={agent !== null} title="Add receiving account" onClose={onClose}>
      {agent ? (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            {agent.displayName ?? agent.agentCode} · {agent.agentCode}
          </p>
          <Select
            label="Method"
            value={method}
            onChange={(event) => setMethod(event.target.value as PaymentMethod)}
          >
            {PAYMENT_METHODS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Input
            label="Account holder"
            value={accountName}
            onChange={(event) => setAccountName(event.target.value)}
          />
          <Input
            label="Account number"
            inputMode="numeric"
            value={accountNumber}
            onChange={(event) => setAccountNumber(event.target.value)}
          />
          <Input
            label="Instructions (optional)"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button className="w-full" loading={busy} onClick={() => void submit()}>
            Save account
          </Button>
        </div>
      ) : null}
    </Sheet>
  );
}
