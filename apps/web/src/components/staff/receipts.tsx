'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, fetchStaffReceipts } from '@/lib/api';
import { formatCredits, formatDateTime } from '@/lib/format';
import { EmptyState, ErrorNote, Input, Panel, Select } from '@/components/ui';
import type { PageMeta, ReceiptVerificationView, VerificationStatus } from '@/lib/types';
import { FilterBar, LoadingBlock, Pager, StatusPill } from './shared';

const STATUSES: VerificationStatus[] = ['PENDING', 'VERIFIED', 'FAILED', 'MANUAL', 'NOT_REQUIRED'];

export function ReceiptsTab() {
  const [status, setStatus] = useState<'ALL' | VerificationStatus>('ALL');
  const [providerCode, setProviderCode] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<ReceiptVerificationView[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchStaffReceipts({
        status: status === 'ALL' ? undefined : status,
        providerCode: providerCode.trim() || undefined,
        page,
      });
      setRows(result.data);
      setMeta(result.page);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load receipt checks.');
    }
  }, [status, providerCode, page]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel className="overflow-hidden">
      <FilterBar>
        <div className="w-44">
          <Select
            label="Status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as 'ALL' | VerificationStatus);
              setPage(0);
            }}
          >
            <option value="ALL">All</option>
            {STATUSES.map((item) => (
              <option key={item} value={item}>
                {item.toLowerCase().replaceAll('_', ' ')}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <Input
            label="Provider code"
            placeholder="telebirr"
            value={providerCode}
            onChange={(event) => {
              setProviderCode(event.target.value);
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
          <EmptyState title="No receipt checks" body="Verification attempts appear here." />
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {rows.map((receipt) => (
            <li key={receipt.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-sm font-semibold">{receipt.providerName}</p>
                    <StatusPill status={receipt.status} />
                    {receipt.source ? (
                      <span className="text-[10px] uppercase tracking-wide text-muted">
                        {receipt.source.toLowerCase()}
                      </span>
                    ) : null}
                    {receipt.deposit?.autoVerified ? (
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-mint">
                        auto-credited
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 break-all font-mono text-[11px] text-muted">{receipt.reference}</p>
                  {receipt.message ? (
                    <p className="mt-1 text-[11px] text-text/80">{receipt.message}</p>
                  ) : null}
                </div>
                <div className="text-right">
                  <p className="font-display text-sm font-bold">
                    {receipt.amount ? `${formatCredits(receipt.amount)} ${receipt.currency ?? 'ETB'}` : '—'}
                  </p>
                  <p className="text-[10px] text-muted">
                    {receipt.attempts} {receipt.attempts === 1 ? 'attempt' : 'attempts'} ·{' '}
                    {formatDateTime(receipt.createdAt)}
                  </p>
                </div>
              </div>

              {receipt.deposit ? (
                <p className="mt-1 text-[11px] text-muted">
                  Deposit <span className="font-semibold text-text">{receipt.deposit.code}</span> ·{' '}
                  {formatCredits(receipt.deposit.amount)} ETB · {receipt.deposit.status.toLowerCase()} ·{' '}
                  {receipt.deposit.player.displayName}
                  {receipt.deposit.player.phone ? ` (${receipt.deposit.player.phone})` : ''}
                </p>
              ) : (
                <p className="mt-1 text-[11px] text-muted">Not linked to a deposit.</p>
              )}
              {receipt.receiverAccount || receipt.senderAccount ? (
                <p className="mt-0.5 text-[10px] text-muted">
                  From {receipt.senderAccount ?? receipt.senderName ?? '—'} →{' '}
                  {receipt.receiverAccount ?? receipt.receiverName ?? '—'}
                  {receipt.transactionDate ? ` · bank ${receipt.transactionDate}` : ''}
                </p>
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
