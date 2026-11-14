'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  createStaffMember,
  fetchAdminOverview,
  fetchAuditLog,
  fetchStaffMembers,
  resetStaffPassword,
  setStaffMemberStatus,
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
  CopyButton,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Select,
  Sheet,
  Stat,
} from '@/components/ui';
import { FilterBar, LoadingBlock, Pager, SectionTitle, StatusPill } from './shared';

const STAFF_ROLES: StaffRole[] = ['SUPPORT', 'AGENT', 'SUPER_ADMIN'];

export function OverviewTab() {
  const { t } = useI18n();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAdminOverview()
      .then(setData)
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : t('common.failed')));
  }, [t]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) {
    return (
      <Panel>
        <LoadingBlock />
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t('staff.totalUsers')} value={data.users} hint={`${data.players} ${t('staff.players').toLowerCase()}`} />
        <Stat label={t('staff.activeAgents')} value={data.activeAgents} />
        <Stat label={t('staff.pendingDeposits')} value={data.pendingDeposits} />
        <Stat label={t('staff.openWithdrawals')} value={data.openWithdrawals} />
      </div>
      <Panel className="p-4">
        <SectionTitle>{t('staff.liabilities')}</SectionTitle>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Stat label={t('staff.available')} value={formatCredits(data.liabilities.available)} />
          <Stat label={t('wallet.escrow')} value={formatCredits(data.liabilities.escrow)} />
          <Stat label={t('wallet.inPlay')} value={formatCredits(data.liabilities.locked)} />
        </div>
        <p className="mt-3 text-[11px] text-muted">
          {t('staff.todayLedgers')}: {data.todayLedgers}
        </p>
      </Panel>
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
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill status={member.status} />
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
