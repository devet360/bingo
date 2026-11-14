'use client';

import { useState } from 'react';
import { useSession } from '@/components/session';
import { EmptyState, Panel, Tabs } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { AuditTab, OverviewTab, StaffTab } from './admin';
import { ProvidersTab } from './providers';
import { AgentsTab, DepositsTab, TransactionsTab, WithdrawalsTab } from './queues';
import { ReceiptsTab } from './receipts';
import { UsersTab } from './users';

type SupportTab = 'users' | 'transactions' | 'deposits' | 'withdrawals' | 'agents' | 'receipts';
type AdminTab = 'overview' | SupportTab | 'staff' | 'audit' | 'providers';

export function StaffConsole({ mode }: { mode: 'support' | 'admin' }) {
  const { user } = useSession();
  const { t } = useI18n();
  const [supportTab, setSupportTab] = useState<SupportTab>('users');
  const [adminTab, setAdminTab] = useState<AdminTab>('overview');

  const allowed =
    user?.role === 'SUPER_ADMIN' || (mode === 'support' && user?.role === 'SUPPORT');

  if (!allowed) {
    return (
      <EmptyState
        title={t('staff.denied')}
        body="Players and agents sign in through Telegram; staff consoles are restricted to support and super admin accounts."
      />
    );
  }

  if (mode === 'support') {
    return (
      <div className="space-y-4">
        <header>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-mint/80">
            Bingo Hall · Staff
          </p>
          <h1 className="mt-0.5 font-display text-2xl font-black tracking-tight">
            {t('staff.supportTitle')}
          </h1>
          <p className="text-xs text-muted">{t('staff.supportBlurb')}</p>
        </header>

        <Tabs<SupportTab>
          value={supportTab}
          onChange={setSupportTab}
          tabs={[
            { value: 'users', label: t('staff.tab.users') },
            { value: 'transactions', label: t('staff.tab.transactions') },
            { value: 'deposits', label: t('staff.tab.deposits') },
            { value: 'withdrawals', label: t('staff.tab.withdrawals') },
            { value: 'agents', label: t('staff.tab.agents') },
            { value: 'receipts', label: t('staff.tab.receipts') },
          ]}
        />

        {supportTab === 'users' ? <UsersTab canModerate /> : null}
        {supportTab === 'transactions' ? <TransactionsTab /> : null}
        {supportTab === 'deposits' ? <DepositsTab /> : null}
        {supportTab === 'withdrawals' ? <WithdrawalsTab /> : null}
        {supportTab === 'agents' ? <AgentsTab canManage={false} /> : null}
        {supportTab === 'receipts' ? <ReceiptsTab /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gold/80">
            Bingo Hall · Back office
          </p>
          <h1 className="mt-0.5 font-display text-2xl font-black tracking-tight">
            {t('staff.adminTitle')}
          </h1>
          <p className="text-xs text-muted">{t('staff.adminBlurb')}</p>
        </div>
        <Panel className="hidden items-center gap-2 px-3 py-2 sm:flex">
          <span className="h-2 w-2 rounded-full bg-mint" />
          <span className="text-[10px] uppercase tracking-widest text-muted">super admin</span>
        </Panel>
      </header>

      <div className="-mx-1 overflow-x-auto px-1">
        <Tabs<AdminTab>
          value={adminTab}
          onChange={setAdminTab}
          tabs={[
            { value: 'overview', label: t('staff.tab.overview') },
            { value: 'users', label: t('staff.tab.users') },
            { value: 'transactions', label: t('staff.tab.transactions') },
            { value: 'deposits', label: t('staff.tab.deposits') },
            { value: 'withdrawals', label: t('staff.tab.withdrawals') },
            { value: 'agents', label: t('staff.tab.agents') },
            { value: 'receipts', label: t('staff.tab.receipts') },
            { value: 'providers', label: t('staff.tab.providers') },
            { value: 'staff', label: t('staff.tab.staff') },
            { value: 'audit', label: t('staff.tab.audit') },
          ]}
        />
      </div>

      {adminTab === 'overview' ? <OverviewTab /> : null}
      {adminTab === 'users' ? <UsersTab canModerate /> : null}
      {adminTab === 'transactions' ? <TransactionsTab /> : null}
      {adminTab === 'deposits' ? <DepositsTab /> : null}
      {adminTab === 'withdrawals' ? <WithdrawalsTab /> : null}
      {adminTab === 'agents' ? <AgentsTab canManage /> : null}
      {adminTab === 'receipts' ? <ReceiptsTab /> : null}
      {adminTab === 'providers' ? <ProvidersTab /> : null}
      {adminTab === 'staff' ? <StaffTab /> : null}
      {adminTab === 'audit' ? <AuditTab /> : null}
    </div>
  );
}
