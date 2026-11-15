'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  claimSupportTicket,
  fetchMediaBlobUrl,
  fetchSupportTicket,
  fetchSupportTickets,
  replySupportTicket,
  resolveSupportTicket,
} from '@/lib/api';
import { formatCredits, formatDateTime, timeAgo } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/components/session';
import type {
  PageMeta,
  SupportMessage,
  SupportTicketDetail,
  SupportTicketRow,
  SupportTicketStatus,
} from '@/lib/types';
import { Button, EmptyState, ErrorNote, Input, Panel, Select, Sheet, Spinner, cn } from '@/components/ui';
import { FilterBar, LoadingBlock, Pager, Row, SectionTitle, StatusPill } from './shared';

const STATUSES: SupportTicketStatus[] = ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'];
const LIST_POLL_MS = 10_000;
const THREAD_POLL_MS = 5_000;

export function TicketsTab() {
  const { t } = useI18n();
  const { user } = useSession();
  const [status, setStatus] = useState<'ALL' | SupportTicketStatus>('ALL');
  const [assignee, setAssignee] = useState<'ALL' | 'me' | 'unassigned'>('ALL');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<SupportTicketRow[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchSupportTickets({
        status: status === 'ALL' ? undefined : status,
        assignee: assignee === 'ALL' ? undefined : assignee,
        query: query.trim() || undefined,
        page,
      });
      setRows(result.data);
      setMeta(result.page);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    }
  }, [status, assignee, query, page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => void load(), LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const resetPage = () => setPage(0);

  return (
    <Panel className="overflow-hidden">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <FilterBar>
          <div className="min-w-[200px] flex-1">
            <Input
              label={t('common.search')}
              placeholder={t('staff.searchTickets')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                resetPage();
              }}
            />
          </div>
          <div className="w-36">
            <Select
              label={t('common.status')}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as 'ALL' | SupportTicketStatus);
                resetPage();
              }}
            >
              <option value="ALL">{t('common.all')}</option>
              {STATUSES.map((option) => (
                <option key={option} value={option}>
                  {option.toLowerCase()}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-40">
            <Select
              label={t('staff.assignee')}
              value={assignee}
              onChange={(event) => {
                setAssignee(event.target.value as 'ALL' | 'me' | 'unassigned');
                resetPage();
              }}
            >
              <option value="ALL">{t('common.all')}</option>
              <option value="me">{t('staff.mine')}</option>
              <option value="unassigned">{t('staff.unassigned')}</option>
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
          <EmptyState title={t('staff.noTickets')} body={t('staff.ticketsBlurb')} />
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {rows.map((ticket) => (
            <li key={ticket.id}>
              <button
                type="button"
                onClick={() => setOpenId(ticket.id)}
                className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition hover:bg-raised/50"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[11px] font-semibold tracking-wide text-mint">
                      {ticket.code}
                    </span>
                    <StatusPill status={ticket.status} />
                    <span className="text-[10px] uppercase tracking-wide text-muted">
                      {ticket.topic.toLowerCase()}
                    </span>
                    {ticket.unreadForStaff > 0 ? (
                      <span className="rounded-full bg-danger/20 px-1.5 py-0.5 text-[10px] font-bold text-danger">
                        {ticket.unreadForStaff}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-sm font-semibold">{ticket.subject}</p>
                  <p className="truncate text-[11px] text-muted">
                    {ticket.player.displayName}
                    {ticket.player.phone ? ` · ${ticket.player.phone}` : ''}
                    {ticket.assignee ? ` · ${ticket.assignee.displayName}` : ''}
                  </p>
                  {ticket.preview ? (
                    <p className="mt-0.5 truncate text-[11px] text-text/70">
                      {ticket.preview.author === 'PLAYER' ? '▸ ' : '↩ '}
                      {ticket.preview.body || t('staff.attachment')}
                    </p>
                  ) : null}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[10px] text-muted">{timeAgo(ticket.lastMessageAt)}</p>
                  <p className="text-[10px] text-muted">{ticket.locale.toUpperCase()}</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="px-4 pb-3">
        <Pager page={meta} onPage={setPage} />
      </div>

      <TicketSheet
        ticketId={openId}
        viewerId={user?.id ?? null}
        onClose={() => setOpenId(null)}
        onChanged={() => void load()}
      />
    </Panel>
  );
}

function TicketSheet({
  ticketId,
  viewerId,
  onClose,
  onChanged,
}: {
  ticketId: string | null;
  viewerId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<SupportTicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'claim' | 'resolve' | 'send' | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  const loadDetail = useCallback(
    async (silent = false) => {
      if (!ticketId) return;
      try {
        const result = await fetchSupportTicket(ticketId);
        setDetail(result);
        setThreadError(null);
      } catch (caught) {
        const message = caught instanceof ApiError ? caught.message : t('staff.threadError');
        if (silent) setThreadError(message);
        else setError(message);
      }
    },
    [ticketId, t],
  );

  useEffect(() => {
    setDetail(null);
    setError(null);
    setThreadError(null);
    setDraft('');
    if (!ticketId) return;
    void loadDetail();
    const timer = setInterval(() => void loadDetail(true), THREAD_POLL_MS);
    return () => clearInterval(timer);
  }, [ticketId, loadDetail]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [detail?.messages.length]);

  const claim = async () => {
    if (!ticketId) return;
    setBusy('claim');
    setError(null);
    try {
      await claimSupportTicket(ticketId);
      await loadDetail();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setBusy(null);
    }
  };

  const resolve = async () => {
    if (!ticketId) return;
    setBusy('resolve');
    setError(null);
    try {
      await resolveSupportTicket(ticketId);
      await loadDetail();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!ticketId || !draft.trim()) return;
    setBusy('send');
    setError(null);
    try {
      await replySupportTicket(ticketId, draft.trim());
      setDraft('');
      await loadDetail();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('staff.sendFailed'));
    } finally {
      setBusy(null);
    }
  };

  const ticket = detail?.ticket;
  const closed = ticket?.status === 'CLOSED';
  const mine = Boolean(ticket && viewerId && ticket.assigneeId === viewerId);

  return (
    <Sheet open={ticketId !== null} title={ticket ? `${ticket.code}` : t('staff.tab.tickets')} onClose={onClose}>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!detail ? (
        <LoadingBlock />
      ) : (
        <div className="max-h-[72vh] space-y-3 overflow-y-auto pr-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-display text-base font-bold">{detail.ticket.player.displayName}</p>
              <p className="text-[11px] text-muted">
                {detail.ticket.player.phone ?? '—'}
                {detail.ticket.player.telegramUsername
                  ? ` · @${detail.ticket.player.telegramUsername}`
                  : ''}
              </p>
              <p className="text-[11px] text-muted">
                {t('staff.ticketOpened', { when: formatDateTime(detail.ticket.createdAt) })}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <StatusPill status={detail.ticket.status} />
              <span className="text-[10px] uppercase tracking-wide text-muted">
                {detail.ticket.assignee
                  ? `${t('staff.assignedTo')} ${detail.ticket.assignee.displayName}`
                  : t('staff.unassigned')}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {!detail.ticket.assigneeId && !closed ? (
              <Button size="sm" variant="outline" loading={busy === 'claim'} onClick={() => void claim()}>
                {t('staff.claim')}
              </Button>
            ) : null}
            {!closed && detail.ticket.status !== 'RESOLVED' ? (
              <Button size="sm" variant="outline" loading={busy === 'resolve'} onClick={() => void resolve()}>
                {t('staff.resolve')}
              </Button>
            ) : null}
            {mine ? (
              <span className="self-center text-[10px] uppercase tracking-wide text-mint">
                {t('staff.mine')}
              </span>
            ) : null}
          </div>

          {detail.wallet ? (
            <div>
              <SectionTitle>{t('staff.ticketContext')}</SectionTitle>
              <div className="mt-1 rounded-xl border border-line/70 bg-ink/40 px-3 py-2">
                <Row label={t('staff.available')}>
                  <span className="text-gold">{formatCredits(detail.wallet.available)}</span>
                </Row>
                <Row label={t('bonuses.balance')}>{formatCredits(detail.wallet.bonus)}</Row>
                <Row label={t('wallet.escrow')}>{formatCredits(detail.wallet.escrow)}</Row>
                <Row label={t('wallet.inPlay')}>{formatCredits(detail.wallet.locked)}</Row>
              </div>
              {detail.deposits.length || detail.withdrawals.length ? (
                <div className="mt-1 space-y-1">
                  {detail.deposits.map((deposit) => (
                    <div key={deposit.id} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-muted">↓ {deposit.code}</span>
                      <span>{formatCredits(deposit.amount)}</span>
                      <StatusPill status={deposit.status} />
                    </div>
                  ))}
                  {detail.withdrawals.map((withdrawal) => (
                    <div key={withdrawal.id} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-muted">↑ {formatDateTime(withdrawal.createdAt)}</span>
                      <span>{formatCredits(withdrawal.netAmount)}</span>
                      <StatusPill status={withdrawal.status} />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div>
            <SectionTitle>{t('staff.conversation')}</SectionTitle>
            {threadError ? <ErrorNote>{threadError}</ErrorNote> : null}
            {detail.messages.length === 0 ? (
              <p className="mt-1 text-xs text-muted">{t('staff.noMessages')}</p>
            ) : (
              <ul className="mt-1 space-y-2">
                {detail.messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
              </ul>
            )}
            <div ref={bottom} />
          </div>

          {closed ? (
            <p className="text-xs text-muted">{t('staff.ticketClosedHint')}</p>
          ) : (
            <div className="space-y-2 border-t border-line/60 pt-3">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                maxLength={4000}
                placeholder={t('staff.replyPlaceholder')}
                className="w-full rounded-xl border border-line bg-ink/60 px-3 py-2 text-sm text-text placeholder:text-muted/60 focus:border-mint/60 focus:outline-none"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted">{t('staff.replyDeliveryHint')}</span>
                <Button
                  size="sm"
                  loading={busy === 'send'}
                  disabled={!draft.trim()}
                  onClick={() => void send()}
                >
                  {t('staff.send')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

function MessageBubble({ message }: { message: SupportMessage }) {
  const { t } = useI18n();
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!message.mediaAssetId) return;
    let revoked: string | null = null;
    let cancelled = false;
    void fetchMediaBlobUrl(message.mediaAssetId)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        revoked = url;
        setPhotoUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [message.mediaAssetId]);

  if (message.author === 'SYSTEM') {
    return (
      <li className="text-center text-[10px] italic text-muted">
        {message.body} · {formatDateTime(message.createdAt)}
      </li>
    );
  }

  const staffSide = message.author !== 'PLAYER';
  return (
    <li className={cn('flex', staffSide ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2 text-xs',
          staffSide
            ? 'rounded-br-sm bg-mint/15 text-text'
            : 'rounded-bl-sm border border-line/70 bg-raised/70 text-text',
        )}
      >
        <div className={cn('flex items-center gap-1.5 text-[9px] uppercase tracking-wide', staffSide ? 'text-mint' : 'text-muted')}>
          <span>{message.author === 'PLAYER' ? t('staff.player') : message.author.toLowerCase()}</span>
          <span>·</span>
          <span>{formatDateTime(message.createdAt)}</span>
        </div>
        {message.body ? <p className="mt-0.5 whitespace-pre-wrap break-words">{message.body}</p> : null}
        {message.mediaAssetId ? (
          photoUrl ? (
            <a href={photoUrl} target="_blank" rel="noreferrer" className="mt-1 block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoUrl} alt={t('staff.attachment')} className="max-h-48 rounded-lg border border-line/60" />
            </a>
          ) : (
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted">
              <Spinner className="h-3 w-3" /> {t('staff.attachment')}
            </div>
          )
        ) : null}
        {message.author === 'STAFF' ? (
          <p className="mt-1 text-right text-[9px] text-muted">
            {message.deliveredAt
              ? `✓ ${t('staff.delivered')}`
              : message.deliveryError
                ? `⚠ ${message.deliveryError}`
                : t('staff.queued')}
          </p>
        ) : null}
      </div>
    </li>
  );
}
