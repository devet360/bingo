'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useSession } from '@/components/session';
import { cn, EmptyState, ErrorNote, Panel, Tabs } from '@/components/ui';
import { ApiError, fetchAdminOverview } from '@/lib/api';
import { initials } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { AdminOverview } from '@/lib/types';
import { AuditTab, OverviewTab, StaffTab } from './admin';
import { BingoRoomsTab } from './bingo';
import { BonusesTab } from './bonuses';
import { GameProvidersTab } from './catalog';
import { MarketingTab } from './marketing';
import { ProvidersTab } from './providers';
import { AgentsTab, DepositsTab, TransactionsTab, WithdrawalsTab } from './queues';
import { ReceiptsTab } from './receipts';
import { LoadingBlock } from './shared';
import { TicketsTab } from './tickets';
import { UsersTab } from './users';

type SupportTab =
  | 'tickets'
  | 'users'
  | 'transactions'
  | 'deposits'
  | 'withdrawals'
  | 'agents'
  | 'receipts';
type AdminTab =
  | 'overview'
  | SupportTab
  | 'staff'
  | 'audit'
  | 'providers'
  | 'bingo'
  | 'marketing'
  | 'bonuses'
  | 'games';

type QueueKey = keyof AdminOverview['queues'];

interface AdminNavItem {
  value: AdminTab;
  labelKey: string;
  icon: ReactNode;
  queue?: QueueKey;
}

function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-4 w-4 shrink-0', className)}
      aria-hidden
    >
      {children}
    </svg>
  );
}

const ADMIN_GROUPS: Array<{ labelKey: string; items: AdminNavItem[] }> = [
  {
    labelKey: 'staff.group.overview',
    items: [
      {
        value: 'overview',
        labelKey: 'staff.tab.overview',
        icon: (
          <>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </>
        ),
      },
    ],
  },
  {
    labelKey: 'staff.group.money',
    items: [
      {
        value: 'deposits',
        labelKey: 'staff.tab.deposits',
        queue: 'pendingDeposits',
        icon: (
          <>
            <path d="M12 4v10" />
            <path d="m8 10 4 4 4-4" />
            <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
          </>
        ),
      },
      {
        value: 'withdrawals',
        labelKey: 'staff.tab.withdrawals',
        queue: 'openWithdrawals',
        icon: (
          <>
            <path d="M12 20V10" />
            <path d="m8 14 4-4 4 4" />
            <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" />
          </>
        ),
      },
      {
        value: 'transactions',
        labelKey: 'staff.tab.transactions',
        icon: (
          <>
            <path d="M4 7h16M4 12h10M4 17h13" />
          </>
        ),
      },
      {
        value: 'receipts',
        labelKey: 'staff.tab.receipts',
        queue: 'manualReceipts',
        icon: (
          <>
            <path d="M6 3h9l4 4v14H6z" />
            <path d="M15 3v4h4" />
            <path d="M9 12h6M9 16h4" />
          </>
        ),
      },
    ],
  },
  {
    labelKey: 'staff.group.players',
    items: [
      {
        value: 'users',
        labelKey: 'staff.tab.users',
        icon: (
          <>
            <circle cx="9" cy="8" r="3" />
            <path d="M3 20c0-3 2.7-5 6-5s6 2 6 5" />
            <path d="M16 6.5a3 3 0 0 1 0 5.8M18 15.5c2 .7 3 2.2 3 4.5" />
          </>
        ),
      },
      {
        value: 'agents',
        labelKey: 'staff.tab.agents',
        icon: (
          <>
            <path d="M12 3 4 7v5c0 5 3.4 8.2 8 9 4.6-.8 8-4 8-9V7z" />
            <circle cx="12" cy="10.5" r="2" />
            <path d="M8.5 17c.6-1.8 1.9-2.7 3.5-2.7s2.9.9 3.5 2.7" />
          </>
        ),
      },
    ],
  },
  {
    labelKey: 'staff.group.game',
    items: [
      {
        value: 'bingo',
        labelKey: 'staff.tab.bingo',
        icon: (
          <>
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="3" />
            <path d="M12 4v2M12 18v2M4 12h2M18 12h2" />
          </>
        ),
      },
      {
        value: 'providers',
        labelKey: 'staff.tab.providers',
        icon: (
          <>
            <path d="M4 7h16M4 17h16" />
            <circle cx="8" cy="7" r="2" />
            <circle cx="16" cy="17" r="2" />
          </>
        ),
      },
      {
        value: 'games',
        labelKey: 'staff.tab.games',
        icon: (
          <>
            <rect x="3" y="6" width="18" height="12" rx="4" />
            <path d="M8 10v4M6 12h4" />
            <path d="M15.5 11h.01M18 13.5h.01" />
          </>
        ),
      },
    ],
  },
  {
    labelKey: 'staff.group.growth',
    items: [
      {
        value: 'marketing',
        labelKey: 'staff.tab.marketing',
        icon: (
          <>
            <path d="M4 10v4a1 1 0 0 0 1 1h2l7 4V5L7 9H5a1 1 0 0 0-1 1z" />
            <path d="M17 9a4 4 0 0 1 0 6" />
          </>
        ),
      },
      {
        value: 'bonuses',
        labelKey: 'staff.tab.bonuses',
        icon: (
          <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
        ),
      },
    ],
  },
  {
    labelKey: 'staff.group.support',
    items: [
      {
        value: 'tickets',
        labelKey: 'staff.tab.tickets',
        queue: 'openTickets',
        icon: (
          <>
            <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z" />
            <path d="M9 8v8" strokeDasharray="2 2" />
          </>
        ),
      },
    ],
  },
  {
    labelKey: 'staff.group.system',
    items: [
      {
        value: 'staff',
        labelKey: 'staff.tab.staff',
        icon: (
          <>
            <circle cx="9" cy="8" r="3" />
            <path d="M3 20c0-3 2.7-5 6-5" />
            <rect x="14" y="12" width="7" height="9" rx="1.5" />
            <path d="M16 15h3" />
          </>
        ),
      },
      {
        value: 'audit',
        labelKey: 'staff.tab.audit',
        icon: (
          <>
            <circle cx="12" cy="12" r="8" />
            <path d="M12 8v4l3 2" />
          </>
        ),
      },
    ],
  },
];

const ADMIN_ITEMS = ADMIN_GROUPS.flatMap((group) => group.items);

function Sidebar({
  tab,
  onSelect,
  overview,
  user,
}: {
  tab: AdminTab;
  onSelect: (tab: AdminTab) => void;
  overview: AdminOverview | null;
  user: { displayName: string; role: string } | null | undefined;
}) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2.5 px-1.5 pb-4 pt-1">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-gold via-[#f7d98a] to-gold text-[10px] font-black tracking-tight text-[#1a1204] shadow-glow">
          251
        </span>
        <span className="min-w-0">
          <span className="block truncate font-display text-sm font-bold leading-tight">
            Bingo 251
          </span>
          <span className="block text-[9px] font-bold uppercase tracking-[0.18em] text-gold/80">
            {t('staff.backOffice')}
          </span>
        </span>
      </div>

      <nav className="min-h-0 flex-1 space-y-3.5 overflow-y-auto pb-3" aria-label={t('staff.backOffice')}>
        {ADMIN_GROUPS.map((group) => (
          <div key={group.labelKey}>
            <p className="px-2 pb-1 text-[9px] font-bold uppercase tracking-[0.16em] text-muted/70">
              {t(group.labelKey)}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = item.value === tab;
                const count = item.queue ? overview?.queues[item.queue] ?? 0 : 0;
                return (
                  <li key={item.value}>
                    <button
                      type="button"
                      onClick={() => onSelect(item.value)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'group flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left text-xs font-semibold transition',
                        active
                          ? 'bg-raised text-text shadow-sm ring-1 ring-line/80'
                          : 'text-muted hover:bg-raised/60 hover:text-text',
                      )}
                    >
                      <Glyph className={active ? 'text-mint' : 'text-muted/80 group-hover:text-muted'}>
                        {item.icon}
                      </Glyph>
                      <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
                      {count > 0 ? (
                        <span className="rounded-full bg-gold/15 px-1.5 py-px text-[9px] font-bold tabular-nums text-gold">
                          {count > 99 ? '99+' : count}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="mt-auto flex items-center gap-2.5 rounded-xl border border-line/60 bg-raised/30 px-2.5 py-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-panel text-[10px] font-bold">
          {initials(user?.displayName)}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[11px] font-semibold text-text">
            {user?.displayName}
          </span>
          <span className="block text-[9px] uppercase tracking-wider text-muted">{user?.role}</span>
        </span>
      </div>
    </div>
  );
}

export function StaffConsole({ mode }: { mode: 'support' | 'admin' }) {
  const { user } = useSession();
  const { t } = useI18n();
  const [supportTab, setSupportTab] = useState<SupportTab>('tickets');
  const [adminTab, setAdminTab] = useState<AdminTab>('overview');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const allowed =
    user?.role === 'SUPER_ADMIN' || (mode === 'support' && user?.role === 'SUPPORT');

  const loadOverview = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await fetchAdminOverview();
      setOverview(data);
      setOverviewError(null);
      setUpdatedAt(new Date());
    } catch (caught) {
      setOverviewError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    if (mode !== 'admin' || !allowed) return;
    void loadOverview();
    const timer = setInterval(() => void loadOverview(), 60_000);
    return () => clearInterval(timer);
  }, [mode, allowed, loadOverview]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

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
            Bingo 251 · Staff
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
            { value: 'tickets', label: t('staff.tab.tickets') },
            { value: 'users', label: t('staff.tab.users') },
            { value: 'transactions', label: t('staff.tab.transactions') },
            { value: 'deposits', label: t('staff.tab.deposits') },
            { value: 'withdrawals', label: t('staff.tab.withdrawals') },
            { value: 'agents', label: t('staff.tab.agents') },
            { value: 'receipts', label: t('staff.tab.receipts') },
          ]}
        />

        {supportTab === 'tickets' ? <TicketsTab /> : null}
        {supportTab === 'transactions' ? <TransactionsTab /> : null}
        {supportTab === 'deposits' ? <DepositsTab /> : null}
        {supportTab === 'withdrawals' ? <WithdrawalsTab /> : null}
        {supportTab === 'agents' ? <AgentsTab canManage={false} /> : null}
        {supportTab === 'receipts' ? <ReceiptsTab /> : null}
      </div>
    );
  }

  const activeItem = ADMIN_ITEMS.find((item) => item.value === adminTab) ?? ADMIN_ITEMS[0]!;

  const select = (tab: AdminTab) => {
    setAdminTab(tab);
    setDrawerOpen(false);
  };

  const sidebar = (
    <Sidebar
      tab={adminTab}
      onSelect={select}
      overview={overview}
      user={user ? { displayName: user.displayName, role: user.role } : null}
    />
  );

  return (
    <div className="lg:grid lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-6">
      <aside className="hidden self-start overflow-hidden rounded-2xl border border-line/70 bg-panel/75 p-2.5 shadow-card backdrop-blur lg:sticky lg:top-[76px] lg:flex lg:h-[calc(100dvh-96px)] lg:flex-col">
        {sidebar}
      </aside>

      <div className="min-w-0 space-y-4">
        <div className="flex items-center gap-2 lg:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex h-9 items-center gap-2 rounded-xl border border-line bg-panel/80 px-3 text-xs font-semibold text-text"
            aria-label={t('staff.menu')}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
            {t('staff.menu')}
          </button>
          <span className="truncate text-xs font-semibold text-muted">{t(activeItem.labelKey)}</span>
        </div>

        {adminTab === 'overview' ? (
          overviewError && !overview ? (
            <ErrorNote>{overviewError}</ErrorNote>
          ) : overview ? (
            <OverviewTab
              data={overview}
              updatedAt={updatedAt}
              refreshing={refreshing}
              onRefresh={() => void loadOverview()}
              onNavigate={select}
            />
          ) : (
            <Panel>
              <LoadingBlock />
            </Panel>
          )
        ) : (
          <div className="space-y-4">
            <header className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gold/80">
                  Bingo 251 · {t('staff.backOffice')}
                </p>
                <h1 className="mt-0.5 font-display text-xl font-black tracking-tight">
                  {t(activeItem.labelKey)}
                </h1>
              </div>
            </header>

            {adminTab === 'tickets' ? <TicketsTab /> : null}
            {adminTab === 'users' ? <UsersTab canModerate /> : null}
            {adminTab === 'transactions' ? <TransactionsTab /> : null}
            {adminTab === 'deposits' ? <DepositsTab /> : null}
            {adminTab === 'withdrawals' ? <WithdrawalsTab /> : null}
            {adminTab === 'agents' ? <AgentsTab canManage /> : null}
            {adminTab === 'receipts' ? <ReceiptsTab /> : null}
            {adminTab === 'providers' ? <ProvidersTab /> : null}
            {adminTab === 'bingo' ? <BingoRoomsTab /> : null}
            {adminTab === 'marketing' ? <MarketingTab /> : null}
            {adminTab === 'bonuses' ? <BonusesTab /> : null}
            {adminTab === 'games' ? <GameProvidersTab /> : null}
            {adminTab === 'staff' ? <StaffTab /> : null}
            {adminTab === 'audit' ? <AuditTab /> : null}
          </div>
        )}
      </div>

      {drawerOpen ? (
        <div className="fixed inset-0 z-[90] lg:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('staff.menu')}
            className="absolute inset-y-0 left-0 flex w-[270px] max-w-[85vw] flex-col overflow-y-auto border-r border-line bg-panel p-2.5 shadow-float"
          >
            {sidebar}
          </div>
        </div>
      ) : null}
    </div>
  );
}
