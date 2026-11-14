'use client';

import type { ReactNode } from 'react';
import { Button, Pill, Spinner } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { PageMeta } from '@/lib/types';

export const STATUS_TONE: Record<string, 'mint' | 'gold' | 'warn' | 'danger' | 'neutral' | 'blue'> = {
  ACTIVE: 'mint',
  PENDING: 'warn',
  PROCESSING: 'gold',
  ESCROWED: 'gold',
  CREDITED: 'mint',
  PAID: 'mint',
  SETTLED: 'mint',
  VERIFIED: 'mint',
  MANUAL: 'blue',
  NOT_REQUIRED: 'neutral',
  FAILED: 'danger',
  VALID: 'mint',
  INVALID: 'danger',
  REJECTED: 'danger',
  SUSPENDED: 'danger',
  BANNED: 'danger',
  TERMINATED: 'danger',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
  REFUNDED: 'neutral',
  OFFLINE: 'neutral',
};

export function StatusPill({ status }: { status: string }) {
  return <Pill tone={STATUS_TONE[status] ?? 'neutral'}>{status.toLowerCase().replaceAll('_', ' ')}</Pill>;
}

export function LoadingBlock() {
  return (
    <div className="flex justify-center py-10">
      <Spinner className="h-5 w-5 text-mint" />
    </div>
  );
}

export function Pager({ page, onPage }: { page: PageMeta | null; onPage: (page: number) => void }) {
  const { t } = useI18n();
  if (!page) return null;
  const last = Math.max(0, Math.ceil(page.total / page.size) - 1);
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-muted">
      <span>{t('staff.total', { count: page.total })}</span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={page.index <= 0}
          onClick={() => onPage(page.index - 1)}
        >
          {t('common.prev')}
        </Button>
        <span className="tabular-nums">
          {page.index + 1} / {last + 1}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={page.index >= last}
          onClick={() => onPage(page.index + 1)}
        >
          {t('common.next')}
        </Button>
      </div>
    </div>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-end gap-2 border-b border-line/60 px-4 py-3">{children}</div>;
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-xs">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium text-text">{children}</span>
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="font-display text-xs font-bold uppercase tracking-wider text-muted">{children}</h3>
  );
}

export const LEDGER_KINDS = [
  'AGENT_FLOAT_TOP_UP',
  'AGENT_FLOAT_CASH_OUT',
  'AGENT_FLOAT_ADJUSTMENT',
  'DEPOSIT',
  'DEPOSIT_COMMISSION',
  'WITHDRAWAL_ESCROW',
  'WITHDRAWAL_SETTLEMENT',
  'WITHDRAWAL_COMMISSION',
  'WITHDRAWAL_REFUND',
  'WITHDRAWAL_FEE',
  'CARD_PURCHASE',
  'ROUND_PAYOUT',
  'ROUND_REFUND',
  'MANUAL_ADJUSTMENT',
] as const;

export const DEPOSIT_STATUSES = ['PENDING', 'PROCESSING', 'CREDITED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'DISPUTED'] as const;
export const WITHDRAWAL_STATUSES = ['ESCROWED', 'PROCESSING', 'PAID', 'SETTLED', 'CANCELLED', 'EXPIRED', 'DISPUTED'] as const;
