'use client';

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import {
  ApiError,
  createStaffMember,
  createStaffTelegramLink,
  fetchAuditLog,
  fetchStaffMembers,
  resetStaffPassword,
  setStaffMemberStatus,
  setStaffTelegram,
} from '@/lib/api';
import { formatCredits, formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type {
  AdminOverview,
  AuditEntry,
  CreatedStaff,
  PageMeta,
  StaffMember,
  StaffRole,
  UserStatus,
} from '@/lib/types';
import {
  Button,
  cn,
  CopyButton,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Select,
  Sheet,
  Stat,
} from '@/components/ui';
import { FilterBar, LoadingBlock, Pager, Row, SectionTitle, StatusPill } from './shared';

const STAFF_ROLES: StaffRole[] = ['SUPPORT', 'AGENT', 'SUPER_ADMIN'];

type AttentionTarget = 'tickets' | 'receipts' | 'deposits' | 'withdrawals';

function toMinor(value: string | bigint | number): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function compactMinor(minorValue: bigint): string {
  const value = Number(minorValue) / 100;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return value.toFixed(0);
}

function Spark({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? 100 / (values.length - 1) : 100;
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(26 - (value / max) * 22).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      className={cn('h-7 w-full', className)}
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Metric({
  label,
  value,
  hint,
  unit,
  spark,
}: {
  label: string;
  value: string;
  hint: string;
  unit?: string;
  spark?: ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line/70 bg-panel/85 p-3.5 shadow-card">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className="mt-1 flex items-baseline gap-1 font-display text-[21px] font-bold leading-tight tabular-nums tracking-tight text-text">
        {value}
        {unit ? (
          <span className="text-[9px] font-semibold uppercase tracking-wide text-muted">{unit}</span>
        ) : null}
      </p>
      <p className="truncate text-[10px] text-muted">{hint}</p>
      {spark ? <div className="mt-1 opacity-80">{spark}</div> : null}
    </div>
  );
}

function CashFlowPanel({ series }: { series: AdminOverview['series'] }) {
  const { t, lang } = useI18n();
  const gradientId = `flow-${useId().replace(/:/g, '')}`;
  const width = 720;
  const height = 210;
  const padX = 22;
  const padTop = 18;
  const padBottom = 28;
  const deposits = series.map((point) => Number(toMinor(point.deposits)) / 100);
  const withdrawals = series.map((point) => Number(toMinor(point.withdrawals)) / 100);
  const max = Math.max(...deposits, ...withdrawals, 1);
  const x = (index: number) =>
    padX +
    (series.length > 1
      ? (index / (series.length - 1)) * (width - padX * 2)
      : (width - padX * 2) / 2);
  const y = (amount: number) => height - padBottom - (amount / max) * (height - padTop - padBottom);
  const line = (values: number[]) =>
    values
      .map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)}`)
      .join(' ');
  const area = `${line(deposits)} L${x(series.length - 1).toFixed(1)},${height - padBottom} L${x(0).toFixed(1)},${height - padBottom} Z`;
  const totalDeposits = series.reduce((sum, point) => sum + toMinor(point.deposits), 0n);
  const totalWithdrawals = series.reduce((sum, point) => sum + toMinor(point.withdrawals), 0n);
  const net = totalDeposits - totalWithdrawals;
  const empty = totalDeposits === 0n && totalWithdrawals === 0n;
  const locale = lang === 'am' ? 'am-ET' : undefined;
  const weekday = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString(locale, { weekday: 'short' });

  return (
    <Panel className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <SectionTitle>{t('staff.dashboard.cashFlow')}</SectionTitle>
          <p className="mt-1 flex items-baseline gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
              {t('staff.dashboard.netFlow')}
            </span>
            <span
              className={cn(
                'font-display text-lg font-bold tabular-nums',
                net >= 0n ? 'text-mint' : 'text-danger',
              )}
            >
              {formatCredits(net)}
            </span>
            <span className="text-[9px] font-semibold uppercase text-muted">ETB</span>
          </p>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wide text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-gold" />
            {t('staff.tab.deposits')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-mint" />
            {t('staff.tab.withdrawals')}
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-2 h-44 w-full sm:h-52"
        role="img"
        aria-label={t('staff.dashboard.cashFlow')}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--c-gold))" stopOpacity="0.26" />
            <stop offset="100%" stopColor="rgb(var(--c-gold))" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((fraction) => (
          <line
            key={fraction}
            x1={padX}
            x2={width - padX}
            y1={y(max * fraction)}
            y2={y(max * fraction)}
            className="text-line/60"
            stroke="currentColor"
            strokeDasharray={fraction === 0 ? undefined : '3 5'}
          />
        ))}
        <text x={padX} y={y(max) - 5} className="fill-muted text-[9px]">
          {compactMinor(toMinor(Math.round(max * 100)))}
        </text>
        <text x={padX} y={y(0) - 5} className="fill-muted text-[9px]">
          0
        </text>
        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={line(deposits)}
          fill="none"
          className="text-gold"
          stroke="currentColor"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={line(withdrawals)}
          fill="none"
          className="text-mint"
          stroke="currentColor"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {series.map((point, index) => (
          <g key={point.date}>
            <circle cx={x(index)} cy={y(deposits[index]!)} r="2.6" className="text-gold" fill="currentColor">
              <title>{`${point.date} · ${formatCredits(point.deposits)} ETB`}</title>
            </circle>
            <circle cx={x(index)} cy={y(withdrawals[index]!)} r="2.2" className="text-mint" fill="currentColor">
              <title>{`${point.date} · ${formatCredits(point.withdrawals)} ETB`}</title>
            </circle>
            <text x={x(index)} y={height - 9} textAnchor="middle" className="fill-muted text-[9px]">
              {weekday(point.date)}
            </text>
          </g>
        ))}
        {empty ? (
          <text x={width / 2} y={height / 2} textAnchor="middle" className="fill-muted text-[11px]">
            {t('staff.dashboard.noFlow')}
          </text>
        ) : null}
      </svg>
    </Panel>
  );
}

function LiabilitiesPanel({ liabilities }: { liabilities: AdminOverview['liabilities'] }) {
  const { t } = useI18n();
  const parts = [
    { label: t('staff.available'), value: liabilities.available, bar: 'bg-gold' },
    { label: t('wallet.escrow'), value: liabilities.escrow, bar: 'bg-blue' },
    { label: t('wallet.inPlay'), value: liabilities.locked, bar: 'bg-mint' },
  ];
  const total = parts.reduce((sum, part) => sum + toMinor(part.value), 0n);

  return (
    <Panel className="p-4">
      <div className="flex items-baseline justify-between gap-2">
        <SectionTitle>{t('staff.liabilities')}</SectionTitle>
        <span className="text-[9px] font-semibold uppercase tracking-wide text-muted">
          {t('staff.dashboard.totalLiability')}
        </span>
      </div>
      <p className="mt-1 flex items-baseline gap-1 font-display text-xl font-bold tabular-nums">
        {formatCredits(total)}
        <span className="text-[9px] font-semibold uppercase text-muted">ETB</span>
      </p>
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-raised">
        {total === 0n
          ? null
          : parts.map((part) => {
              const share = Number((toMinor(part.value) * 10_000n) / total) / 100;
              return share > 0 ? (
                <span key={part.label} className={part.bar} style={{ width: `${share}%` }} />
              ) : null;
            })}
      </div>
      <ul className="mt-3 space-y-1.5">
        {parts.map((part) => (
          <li key={part.label} className="flex items-center gap-2 text-[11px]">
            <span className={cn('h-1.5 w-1.5 rounded-full', part.bar)} />
            <span className="flex-1 text-muted">{part.label}</span>
            <span className="font-semibold tabular-nums text-text">{formatCredits(part.value)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function BingoPanel({ data }: { data: AdminOverview }) {
  const { t } = useI18n();
  const live = data.bingo.liveRounds > 0;
  return (
    <Panel className="p-4">
      <SectionTitle>{t('staff.dashboard.bingoActivity')}</SectionTitle>
      <div className="mt-1.5 space-y-0.5">
        <Row label={t('staff.dashboard.openRooms')}>{data.bingo.openRooms}</Row>
        <Row label={t('staff.dashboard.liveRounds')}>
          <span className="inline-flex items-center gap-1.5">
            <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'animate-pulse bg-mint' : 'bg-line')} />
            {data.bingo.liveRounds}
          </span>
        </Row>
        <Row label={t('staff.dashboard.cardsSold')}>{data.today.cardsSold}</Row>
        <Row label={t('staff.dashboard.stakedToday')}>
          {formatCredits(data.today.cardsStaked)} ETB
        </Row>
      </div>
    </Panel>
  );
}

function AttentionRow({
  label,
  hint,
  count,
  onClick,
}: {
  label: string;
  hint: string;
  count: number;
  onClick: () => void;
}) {
  const clear = count === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition',
        clear
          ? 'border-line/50 bg-raised/20 hover:border-line'
          : 'border-gold/25 bg-gold/[0.06] hover:border-gold/45',
      )}
    >
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold tabular-nums',
          clear ? 'bg-raised text-muted' : 'bg-gold/15 text-gold',
        )}
      >
        {clear ? (
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m5 13 4 4L19 7" />
          </svg>
        ) : count > 99 ? (
          '99+'
        ) : (
          count
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold text-text">{label}</span>
        <span className="block truncate text-[10px] text-muted">{hint}</span>
      </span>
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-muted/70" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
  );
}

export function OverviewTab({
  data,
  updatedAt,
  refreshing,
  onRefresh,
  onNavigate,
}: {
  data: AdminOverview;
  updatedAt: Date | null;
  refreshing: boolean;
  onRefresh: () => void;
  onNavigate: (tab: AttentionTarget) => void;
}) {
  const { t } = useI18n();
  const depositsSpark = data.series.map((point) => Number(toMinor(point.deposits)) / 100);
  const withdrawalsSpark = data.series.map((point) => Number(toMinor(point.withdrawals)) / 100);
  const attention: Array<{ target: AttentionTarget; label: string; hint: string; count: number }> = [
    {
      target: 'tickets',
      label: t('staff.dashboard.openTickets'),
      hint: t('staff.dashboard.ticketsHint'),
      count: data.queues.openTickets,
    },
    {
      target: 'receipts',
      label: t('staff.dashboard.manualReceipts'),
      hint: t('staff.dashboard.manualReceiptsHint'),
      count: data.queues.manualReceipts,
    },
    {
      target: 'deposits',
      label: t('staff.pendingDeposits'),
      hint: t('staff.dashboard.pendingDepositsHint'),
      count: data.queues.pendingDeposits,
    },
    {
      target: 'withdrawals',
      label: t('staff.openWithdrawals'),
      hint: t('staff.dashboard.openWithdrawalsHint'),
      count: data.queues.openWithdrawals,
    },
  ];
  const attentionTotal = attention.reduce((sum, item) => sum + item.count, 0);

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gold/80">
            Bingo 251 · {t('staff.dashboard.eyebrow')}
          </p>
          <h1 className="mt-0.5 font-display text-2xl font-black tracking-tight">
            {t('staff.tab.overview')}
          </h1>
          <p className="text-[11px] text-muted">
            {updatedAt
              ? `${t('staff.dashboard.updated')} ${updatedAt.toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
              : '…'}
          </p>
        </div>
        <Button size="sm" variant="outline" loading={refreshing} onClick={onRefresh}>
          {t('staff.dashboard.refresh')}
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Metric
          label={t('staff.dashboard.depositsToday')}
          value={formatCredits(data.today.deposits.amount)}
          unit="ETB"
          hint={`${data.today.deposits.count} ${t('staff.dashboard.payments')}`}
          spark={<Spark values={depositsSpark} className="text-gold" />}
        />
        <Metric
          label={t('staff.dashboard.withdrawalsToday')}
          value={formatCredits(data.today.withdrawals.amount)}
          unit="ETB"
          hint={`${data.today.withdrawals.count} ${t('staff.dashboard.payouts')}`}
          spark={<Spark values={withdrawalsSpark} className="text-mint" />}
        />
        <Metric
          label={t('staff.dashboard.newPlayers')}
          value={String(data.today.newPlayers)}
          hint={`${data.players} ${t('staff.dashboard.totalPlayers')}`}
        />
        <Metric
          label={t('staff.dashboard.cardsSold')}
          value={String(data.today.cardsSold)}
          hint={`${formatCredits(data.today.cardsStaked)} ETB ${t('staff.dashboard.staked')}`}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_308px]">
        <div className="min-w-0 space-y-3">
          <CashFlowPanel series={data.series} />
          <div className="grid gap-3 md:grid-cols-2">
            <LiabilitiesPanel liabilities={data.liabilities} />
            <BingoPanel data={data} />
          </div>
        </div>

        <div className="space-y-3">
          <Panel className="p-4">
            <div className="flex items-center justify-between gap-2">
              <SectionTitle>{t('staff.dashboard.needsAttention')}</SectionTitle>
              {attentionTotal > 0 ? (
                <span className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wide text-gold">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gold" />
                  {attentionTotal}
                </span>
              ) : null}
            </div>
            <div className="mt-2 space-y-1.5">
              {attention.map((item) => (
                <AttentionRow
                  key={item.target}
                  label={item.label}
                  hint={item.hint}
                  count={item.count}
                  onClick={() => onNavigate(item.target)}
                />
              ))}
            </div>
            {attentionTotal === 0 ? (
              <p className="mt-2 text-[10px] text-muted">{t('staff.dashboard.allClear')}</p>
            ) : null}
          </Panel>

          <Panel className="p-4">
            <SectionTitle>{t('staff.dashboard.today')}</SectionTitle>
            <div className="mt-1.5 space-y-0.5">
              <Row label={t('staff.activeAgents')}>{data.activeAgents}</Row>
              <Row label={t('staff.dashboard.roundsSettled')}>{data.today.rounds}</Row>
              <Row label={t('staff.dashboard.rake')}>{formatCredits(data.today.rake)} ETB</Row>
              <Row label={t('staff.todayLedgers')}>{data.todayLedgers}</Row>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

export function StaffTab() {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'ALL' | UserStatus>('ALL');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<StaffMember[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedStaff | null>(null);
  const [resetResult, setResetResult] = useState<{ name: string; password: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [telegramTarget, setTelegramTarget] = useState<StaffMember | null>(null);
  const [telegramId, setTelegramId] = useState('');
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const [telegramLink, setTelegramLink] = useState<{ url: string; expiresAt: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchStaffMembers({
        query: query.trim() || undefined,
        status: status === 'ALL' ? undefined : status,
        page,
      });
      setRows(result.data);
      setMeta(result.page);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    }
  }, [query, status, page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (member: StaffMember) => {
    setBusy(member.id);
    setNotice(null);
    try {
      await setStaffMemberStatus(member.id, member.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setBusy(null);
    }
  };

  const reset = async (member: StaffMember) => {
    setBusy(member.id);
    try {
      const result = await resetStaffPassword(member.id);
      setResetResult({ name: member.displayName, password: result.temporaryPassword });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setBusy(null);
    }
  };

  const openTelegram = (member: StaffMember) => {
    setTelegramTarget(member);
    setTelegramId(member.telegramId ?? '');
    setTelegramError(null);
    setTelegramLink(null);
  };

  const saveTelegram = async () => {
    if (!telegramTarget) return;
    const value = telegramId.trim();
    if (value && !/^\d{1,20}$/.test(value)) {
      setTelegramError('Telegram ids are digits only.');
      return;
    }
    setTelegramBusy(true);
    setTelegramError(null);
    try {
      const result = await setStaffTelegram(telegramTarget.id, value || null);
      setTelegramTarget({ ...telegramTarget, ...result.user });
      setTelegramId(result.user.telegramId ?? '');
      setNotice(`Telegram id updated for ${telegramTarget.displayName}.`);
      await load();
    } catch (caught) {
      setTelegramError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setTelegramBusy(false);
    }
  };

  const generateTelegramLink = async () => {
    if (!telegramTarget) return;
    setTelegramBusy(true);
    setTelegramError(null);
    try {
      const result = await createStaffTelegramLink(telegramTarget.id);
      setTelegramLink({ url: result.url, expiresAt: result.expiresAt });
    } catch (caught) {
      setTelegramError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setTelegramBusy(false);
    }
  };

  const unlinkTelegram = async () => {
    if (!telegramTarget) return;
    setTelegramBusy(true);
    setTelegramError(null);
    try {
      const result = await setStaffTelegram(telegramTarget.id, null);
      setTelegramTarget({ ...telegramTarget, ...result.user });
      setTelegramId('');
      setNotice(`Telegram unlinked for ${telegramTarget.displayName}.`);
      await load();
    } catch (caught) {
      setTelegramError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setTelegramBusy(false);
    }
  };

  return (
    <Panel className="overflow-hidden">
      <FilterBar>
        <div className="min-w-[220px] flex-1">
          <Input
            label={t('common.search')}
            placeholder={t('staff.searchStaff')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <div className="w-36">
          <Select
            label={t('common.status')}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as 'ALL' | UserStatus);
              setPage(0);
            }}
          >
            <option value="ALL">{t('common.all')}</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="SUSPENDED">SUSPENDED</option>
          </Select>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          {t('staff.createStaff')}
        </Button>
      </FilterBar>

      {error ? (
        <div className="p-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {notice ? (
        <p className="mx-4 mt-3 rounded-xl border border-mint/30 bg-mint/10 px-3 py-2 text-xs text-mint">
          {notice}
        </p>
      ) : null}

      {rows === null ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title={t('staff.noRows')} />
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {rows.map((member) => (
            <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm font-semibold">{member.displayName}</p>
                <p className="text-[11px] text-muted">
                  {member.role}
                  {member.agentProfile ? ` · ${member.agentProfile.agentCode}` : ''} ·{' '}
                  {member.email ?? member.phone ?? '—'}
                  {member.telegramId ? ` · TG ${member.telegramId}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill status={member.status} />
                <Button size="sm" variant="ghost" onClick={() => openTelegram(member)}>
                  Telegram
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  loading={busy === member.id}
                  onClick={() => void reset(member)}
                >
                  {t('staff.resetPassword')}
                </Button>
                <Button
                  size="sm"
                  variant={member.status === 'ACTIVE' ? 'danger' : 'ghost'}
                  loading={busy === member.id}
                  onClick={() => void toggle(member)}
                >
                  {member.status === 'ACTIVE' ? t('staff.suspendStaff') : t('staff.reactivateStaff')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="px-4 pb-3">
        <Pager page={meta} onPage={setPage} />
      </div>

      <CreateStaffSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(result) => {
          setCreated(result);
          setCreateOpen(false);
          void load();
        }}
      />

      <Sheet
        open={created !== null}
        title={t('staff.tempPassword')}
        onClose={() => setCreated(null)}
      >
        {created ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              {created.user.displayName} · {created.user.role}
              {created.agent ? ` · ${created.agent.agentCode}` : ''}
            </p>
            <div className="rounded-xl border border-gold/30 bg-gold/5 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gold">
                {t('staff.tempPassword')}
              </p>
              <p className="mt-1 font-mono text-lg font-bold tracking-wider text-text">
                {created.temporaryPassword}
              </p>
              <div className="mt-2">
                <CopyButton value={created.temporaryPassword} label={t('common.copy')} />
              </div>
              <p className="mt-2 text-[11px] text-muted">{t('staff.tempPasswordHint')}</p>
            </div>
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={resetResult !== null}
        title={t('staff.tempPassword')}
        onClose={() => setResetResult(null)}
      >
        {resetResult ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">{resetResult.name}</p>
            <div className="rounded-xl border border-gold/30 bg-gold/5 p-3">
              <p className="font-mono text-lg font-bold tracking-wider text-text">
                {resetResult.password}
              </p>
              <div className="mt-2">
                <CopyButton value={resetResult.password} label={t('common.copy')} />
              </div>
              <p className="mt-2 text-[11px] text-muted">{t('staff.tempPasswordHint')}</p>
            </div>
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={telegramTarget !== null}
        title="Telegram access"
        onClose={() => setTelegramTarget(null)}
      >
        {telegramTarget ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              {telegramTarget.displayName} · {telegramTarget.role}
              {telegramTarget.telegramUsername ? ` · @${telegramTarget.telegramUsername}` : ''}
            </p>
            <Input
              label="Telegram numeric id"
              inputMode="numeric"
              placeholder="123456789"
              value={telegramId}
              onChange={(event) => setTelegramId(event.target.value.replace(/\D/g, ''))}
              hint="Send /start to @userinfobot to read the id. Staff can also prove ownership with the link below."
            />
            <Button className="w-full" loading={telegramBusy} onClick={() => void saveTelegram()}>
              Save id
            </Button>
            <div className="rounded-xl border border-line/70 bg-ink/40 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                One-time sign-in link
              </p>
              <p className="mt-1 text-[11px] text-muted">
                Send this to the staff member. Opening it links their Telegram account to this login
                and opens their dashboard inside the Mini App.
              </p>
              <Button
                className="mt-2 w-full"
                variant="gold"
                loading={telegramBusy}
                onClick={() => void generateTelegramLink()}
              >
                Generate link
              </Button>
              {telegramLink ? (
                <div className="mt-2 rounded-lg border border-gold/30 bg-gold/5 p-2">
                  <p className="break-all font-mono text-[11px] text-text">{telegramLink.url}</p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[10px] text-muted">
                      expires {formatDateTime(telegramLink.expiresAt)}
                    </span>
                    <CopyButton value={telegramLink.url} label={t('common.copy')} />
                  </div>
                </div>
              ) : null}
            </div>
            {telegramError ? <ErrorNote>{telegramError}</ErrorNote> : null}
            {telegramTarget.telegramId ? (
              <Button
                variant="danger"
                className="w-full"
                loading={telegramBusy}
                onClick={() => void unlinkTelegram()}
              >
                Unlink Telegram
              </Button>
            ) : null}
          </div>
        ) : null}
      </Sheet>
    </Panel>
  );
}

function CreateStaffSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: CreatedStaff) => void;
}) {
  const { t } = useI18n();
  const [role, setRole] = useState<StaffRole>('SUPPORT');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [region, setRegion] = useState('');
  const [city, setCity] = useState('');
  const [district, setDistrict] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!displayName.trim()) {
      setError(t('staff.displayName'));
      return;
    }
    if (!email.trim() && !phone.trim()) {
      setError('Provide an email or phone.');
      return;
    }
    if (role === 'AGENT' && !region.trim()) {
      setError('Agent region is required.');
      return;
    }
    setBusy(true);
    try {
      const result = await createStaffMember({
        role,
        displayName: displayName.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        password: password.trim() || undefined,
        agent: role === 'AGENT' ? { region: region.trim(), city: city.trim() || undefined, district: district.trim() || undefined } : undefined,
      });
      onCreated(result);
      setDisplayName('');
      setEmail('');
      setPhone('');
      setPassword('');
      setRegion('');
      setCity('');
      setDistrict('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} title={t('staff.createStaff')} onClose={onClose}>
      <div className="space-y-3">
        <Select
          label={t('common.role')}
          value={role}
          onChange={(event) => setRole(event.target.value as StaffRole)}
        >
          {STAFF_ROLES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
        <Input
          label={t('staff.displayName')}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label={t('staff.email')}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            hint="Required if no phone"
          />
          <Input
            label={t('staff.phone')}
            placeholder="+2519…"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            hint="E.164, required if no email"
          />
        </div>
        <Input
          label="Password (optional)"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint="Leave empty to generate a temporary password."
        />
        {role === 'AGENT' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input label={t('staff.region')} value={region} onChange={(event) => setRegion(event.target.value)} />
            <Input label={t('staff.city')} value={city} onChange={(event) => setCity(event.target.value)} />
            <Input label={t('staff.district')} value={district} onChange={(event) => setDistrict(event.target.value)} />
          </div>
        ) : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button className="w-full" loading={busy} onClick={() => void submit()}>
          {t('staff.createStaff')}
        </Button>
      </div>
    </Sheet>
  );
}

export function AuditTab() {
  const { t } = useI18n();
  const [action, setAction] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchAuditLog({ action: action.trim() || undefined, page });
      setRows(result.data);
      setMeta(result.page);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    }
  }, [action, page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel className="overflow-hidden">
      <FilterBar>
        <div className="w-56">
          <Input
            label={t('staff.auditAction')}
            placeholder="staff.create"
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
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
          {rows.map((entry) => (
            <li key={entry.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold">{entry.action}</p>
                <span className="text-[10px] text-muted">{formatDateTime(entry.createdAt)}</span>
              </div>
              <p className="mt-0.5 text-[10px] text-muted">
                {entry.actorName ?? entry.actorId ?? 'system'} · {entry.actorRole ?? '—'} ·{' '}
                {entry.entityType}
                {entry.entityId ? ` ${entry.entityId.slice(0, 8)}` : ''}
              </p>
              {entry.before || entry.after ? (
                <pre className="mt-1 overflow-x-auto rounded-lg bg-ink/50 p-2 text-[9px] text-muted">
                  {JSON.stringify({ before: entry.before, after: entry.after })}
                </pre>
              ) : null}
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
