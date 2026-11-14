'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  fetchStaffUser,
  fetchStaffUsers,
  setUserStatus,
} from '@/lib/api';
import { formatCredits, formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type {
  PageMeta,
  Role,
  User,
  UserDetail,
  UserStatus,
} from '@/lib/types';
import {
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Select,
  Sheet,
  cn,
} from '@/components/ui';
import { FilterBar, LoadingBlock, Pager, Row, SectionTitle, StatusPill } from './shared';

const ROLES: Role[] = ['PLAYER', 'AGENT', 'SUPPORT', 'SUPER_ADMIN'];
const STATUSES: UserStatus[] = ['ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED'];

export function UsersTab({ canModerate }: { canModerate: boolean }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'ALL' | Role>('ALL');
  const [status, setStatus] = useState<'ALL' | UserStatus>('ALL');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<User[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchStaffUsers({
        query: query.trim() || undefined,
        role: role === 'ALL' ? undefined : role,
        status: status === 'ALL' ? undefined : status,
        page,
      });
      setRows(result.data);
      setMeta(result.page);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    }
  }, [query, role, status, page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetPage = () => setPage(0);

  return (
    <Panel className="overflow-hidden">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          resetPage();
          void load();
        }}
      >
        <FilterBar>
          <div className="min-w-[220px] flex-1">
            <Input
              label={t('common.search')}
              placeholder={t('staff.searchUsers')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="w-36">
            <Select
              label={t('common.role')}
              value={role}
              onChange={(event) => {
                setRole(event.target.value as 'ALL' | Role);
                resetPage();
              }}
            >
              <option value="ALL">{t('common.all')}</option>
              {ROLES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-36">
            <Select
              label={t('common.status')}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as 'ALL' | UserStatus);
                resetPage();
              }}
            >
              <option value="ALL">{t('common.all')}</option>
              {STATUSES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" size="md" variant="outline">
            {t('common.search')}
          </Button>
        </FilterBar>
      </form>

      {error ? (
        <div className="p-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}

      {rows === null ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title={t('staff.noUser')} />
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {rows.map((user) => (
            <li key={user.id}>
              <button
                type="button"
                onClick={() => setDetailId(user.id)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-raised/50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{user.displayName}</p>
                  <p className="truncate text-[11px] text-muted">
                    {user.phone ?? user.email ?? user.telegramUsername ?? user.id.slice(0, 8)}
                    {user.phoneVerified ? ' · verified' : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                    {user.role}
                  </span>
                  <StatusPill status={user.status} />
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="px-4 pb-3">
        <Pager page={meta} onPage={setPage} />
      </div>

      <UserSheet
        userId={detailId}
        canModerate={canModerate}
        onClose={() => setDetailId(null)}
        onChanged={() => void load()}
      />
    </Panel>
  );
}

function UserSheet({
  userId,
  canModerate,
  onClose,
  onChanged,
}: {
  userId: string | null;
  canModerate: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId) {
      setDetail(null);
      setError(null);
      return;
    }
    let live = true;
    setDetail(null);
    fetchStaffUser(userId)
      .then((result) => {
        if (live) setDetail(result);
      })
      .catch((caught) => {
        if (live) setError(caught instanceof ApiError ? caught.message : t('common.failed'));
      });
    return () => {
      live = false;
    };
  }, [userId, t]);

  const toggleStatus = async () => {
    if (!detail) return;
    const next = detail.user.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    setBusy(true);
    setError(null);
    try {
      await setUserStatus(detail.user.id, next);
      const refreshed = await fetchStaffUser(detail.user.id);
      setDetail(refreshed);
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={userId !== null} title={t('staff.userDetail')} onClose={onClose}>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!detail ? (
        <LoadingBlock />
      ) : (
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-display text-lg font-bold">{detail.user.displayName}</p>
              <p className="text-[11px] text-muted">
                {detail.user.role} · joined {formatDateTime(detail.user.createdAt)}
              </p>
              <p className="mt-1 text-[11px] text-muted">
                {detail.user.phone ?? 'no phone'}
                {detail.user.phoneVerified ? ' · verified' : ' · unverified'}
              </p>
              <p className="text-[11px] text-muted">
                {detail.user.email ?? detail.user.telegramUsername ?? ''}
              </p>
            </div>
            <StatusPill status={detail.user.status} />
          </div>

          {canModerate ? (
            <Button
              size="sm"
              variant={detail.user.status === 'ACTIVE' ? 'danger' : 'outline'}
              loading={busy}
              onClick={() => void toggleStatus()}
            >
              {detail.user.status === 'ACTIVE' ? t('staff.suspend') : t('staff.activate')}
            </Button>
          ) : null}

          <div>
            <SectionTitle>{t('staff.wallet')}</SectionTitle>
            <div className="mt-1 rounded-xl border border-line/70 bg-ink/40 px-3 py-2">
              <Row label={t('staff.available')}>
                <span className="text-gold">
                  {detail.wallet ? formatCredits(detail.wallet.available) : '—'}
                </span>
              </Row>
              <Row label={t('wallet.escrow')}>
                {detail.wallet ? formatCredits(detail.wallet.escrow) : '—'}
              </Row>
              <Row label={t('wallet.inPlay')}>
                {detail.wallet ? formatCredits(detail.wallet.locked) : '—'}
              </Row>
              <Row label={t('wallet.lifetimeWon')}>
                {detail.wallet ? formatCredits(detail.wallet.lifetimeWon) : '—'}
              </Row>
            </div>
          </div>

          <div>
            <SectionTitle>{t('staff.counts')}</SectionTitle>
            <div className="mt-1 grid grid-cols-4 gap-2 text-center">
              {[
                ['deposits', detail.counts.deposits],
                ['withdrawals', detail.counts.withdrawals],
                ['cards', detail.counts.cards],
                ['wins', detail.counts.wins],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg bg-ink/50 py-2">
                  <p className="font-display text-base font-bold">{String(value)}</p>
                  <p className="text-[9px] uppercase tracking-wide text-muted">{String(label)}</p>
                </div>
              ))}
            </div>
          </div>

          {detail.agent ? (
            <div>
              <SectionTitle>{t('staff.agent')}</SectionTitle>
              <div className="mt-1 rounded-xl border border-line/70 bg-ink/40 px-3 py-2">
                <Row label="Code">{detail.agent.agentCode}</Row>
                <Row label={t('staff.tier')}>{detail.agent.tier}</Row>
                <Row label={t('staff.myFloat')}>
                  {detail.agent.floatAvailable ? formatCredits(detail.agent.floatAvailable) : '—'}
                </Row>
              </div>
            </div>
          ) : null}

          <div>
            <SectionTitle>{t('staff.transactions')}</SectionTitle>
            {detail.transactions.length === 0 ? (
              <p className="mt-1 text-xs text-muted">{t('staff.noRows')}</p>
            ) : (
              <ul className="mt-1 divide-y divide-line/60">
                {detail.transactions.map((ledger) => {
                  const userEntry = ledger.entries.find((entry) => entry.ownerKind === 'USER');
                  return (
                    <li key={ledger.id} className="flex items-center justify-between gap-2 py-1.5">
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-semibold">
                          {ledger.kind.replaceAll('_', ' ').toLowerCase()}
                        </p>
                        <p className="text-[10px] text-muted">{formatDateTime(ledger.createdAt)}</p>
                      </div>
                      <span
                        className={cn(
                          'font-display text-xs font-bold tabular-nums',
                          userEntry?.amount?.startsWith('-') ? 'text-muted' : 'text-mint',
                        )}
                      >
                        {userEntry ? formatCredits(userEntry.amount) : '—'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <SectionTitle>{t('staff.recentDeposits')}</SectionTitle>
              {detail.deposits.length === 0 ? (
                <p className="mt-1 text-xs text-muted">{t('staff.noRows')}</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {detail.deposits.map((deposit) => (
                    <li key={deposit.id} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="font-semibold tracking-wider">{deposit.code}</span>
                      <span>{formatCredits(deposit.amount)}</span>
                      <StatusPill status={deposit.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <SectionTitle>{t('staff.recentWithdrawals')}</SectionTitle>
              {detail.withdrawals.length === 0 ? (
                <p className="mt-1 text-xs text-muted">{t('staff.noRows')}</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {detail.withdrawals.map((withdrawal) => (
                    <li key={withdrawal.id} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="font-semibold tracking-wider">{withdrawal.payoutCode}</span>
                      <span>{formatCredits(withdrawal.amount)}</span>
                      <StatusPill status={withdrawal.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </Sheet>
  );
}
