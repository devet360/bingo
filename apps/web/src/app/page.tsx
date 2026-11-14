'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { fetchRooms } from '@/lib/api';
import { formatCredits, formatCountdown, formatStake } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/components/session';
import { Button, EmptyState, Panel, Pill, Spinner, cn } from '@/components/ui';
import type { LobbyRoom, RoundStatus } from '@/lib/types';

function statusTone(status: RoundStatus) {
  if (status === 'WAITING') return 'gold' as const;
  if (status === 'LOCKED') return 'warn' as const;
  if (status === 'PLAYING' || status === 'CLAIM_VERIFICATION') return 'mint' as const;
  return 'neutral' as const;
}

function RoomCard({ entry, now }: { entry: LobbyRoom; now: number }) {
  const { t } = useI18n();
  const { room, round } = entry;
  const variant =
    room.variant === 'US_75'
      ? { label: t('lobby.v75'), blurb: t('lobby.v75Blurb') }
      : room.variant === 'UK_90'
        ? { label: t('lobby.v90'), blurb: t('lobby.v90Blurb') }
        : { label: room.variant, blurb: '' };
  const status = round?.status ?? 'WAITING';
  const live = status === 'PLAYING' || status === 'CLAIM_VERIFICATION';
  const deadline =
    round?.status === 'WAITING' && round.purchaseClosesAt
      ? { label: t('phase.salesClose'), at: round.purchaseClosesAt }
      : null;

  return (
    <Link href={`/room/${room.code}`} className="group block">
      <Panel
        className={cn(
          'relative overflow-hidden p-4 transition group-hover:border-mint/40',
          live && 'border-mint/30',
        )}
      >
        <div className="absolute -right-8 -top-8 h-28 w-28 rounded-full bg-gold/10 blur-2xl" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Pill tone={room.variant === 'US_75' ? 'blue' : 'gold'}>{variant.label}</Pill>
              <Pill tone={statusTone(status)}>
                {live ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
                {t(`round.${status}`)}
              </Pill>
            </div>
            <h2 className="mt-2 font-display text-lg font-bold tracking-tight">{room.name}</h2>
            <p className="mt-0.5 text-[11px] text-muted">{variant.blurb}</p>
          </div>
          <div className="text-right">
            <p className="font-display text-3xl font-black leading-none text-gold">
              {formatStake(room.stakePerCard)}
            </p>
            <p className="text-[10px] uppercase tracking-widest text-muted">{t('lobby.perCard')}</p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-ink/50 px-2 py-1.5">
            <p className="text-[9px] uppercase tracking-widest text-muted">{t('lobby.prizePool')}</p>
            <p className="font-display text-sm font-semibold text-mint">
              {round ? formatCredits(round.prizePool) : '—'}
            </p>
          </div>
          <div className="rounded-lg bg-ink/50 px-2 py-1.5">
            <p className="text-[9px] uppercase tracking-widest text-muted">{t('lobby.players')}</p>
            <p className="font-display text-sm font-semibold">{round?.uniquePlayers ?? 0}</p>
          </div>
          <div className="rounded-lg bg-ink/50 px-2 py-1.5">
            <p className="text-[9px] uppercase tracking-widest text-muted">
              {deadline ? deadline.label : t('lobby.cardsSold')}
            </p>
            <p className="font-display text-sm font-semibold tabular-nums">
              {deadline ? formatCountdown(deadline.at, now) : round?.cardsSold ?? 0}
            </p>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between text-xs">
          <span className="text-muted">
            {round ? t('lobby.round', { number: round.roundNumber }) : t('lobby.newRound')} ·{' '}
            {round?.cardsSold ?? 0} {t('lobby.cardsSold').toLowerCase()}
          </span>
          <span className="font-semibold text-mint transition group-hover:translate-x-0.5">
            {live ? t('lobby.watch') : t('lobby.join')}
          </span>
        </div>
      </Panel>
    </Link>
  );
}

export default function LobbyPage() {
  const { user, wallet } = useSession();
  const { t } = useI18n();
  const router = useRouter();
  const [rooms, setRooms] = useState<LobbyRoom[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  // Staff arrive through the same Mini App; send them to their console.
  const staffHome =
    user?.role === 'SUPER_ADMIN' ? '/admin' : user?.role === 'SUPPORT' ? '/support' : null;

  useEffect(() => {
    if (staffHome) router.replace(staffHome);
  }, [staffHome, router]);

  const load = useCallback(async () => {
    try {
      const next = await fetchRooms();
      setRooms(next);
      setError(null);
    } catch {
      setError(t('lobby.loadError'));
    }
  }, []);

  useEffect(() => {
    if (staffHome) return;
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [load, staffHome]);

  if (staffHome) {
    return (
      <div className="flex justify-center py-14">
        <Spinner className="h-6 w-6 text-mint" />
      </div>
    );
  }

  const sorted = rooms
    ? [...rooms].sort((a, b) => Number(a.room.stakePerCard) - Number(b.room.stakePerCard))
    : null;

  return (
    <div className="space-y-4">
      <div className="pt-1">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-mint/80">{t('lobby.eyebrow')}</p>
        <h1 className="mt-1 font-display text-2xl font-black tracking-tight">
          {t('lobby.greeting', { name: user?.displayName?.split(' ')[0] ?? t('lobby.player') })}
        </h1>
        <p className="mt-1 text-xs text-muted">
          {t('lobby.blurb')}
        </p>
      </div>

      {wallet ? (
        <Panel className="flex items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted">{t('lobby.playable')}</p>
            <p className="font-display text-xl font-bold text-gold">
              {formatCredits(wallet.available)}{' '}
              <span className="text-xs font-semibold text-muted">{t('common.credits')}</span>
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/wallet?tab=deposit">
              <Button variant="outline" size="sm">
                {t('lobby.deposit')}
              </Button>
            </Link>
            <Link href="/wallet?tab=withdraw">
              <Button variant="gold" size="sm">
                {t('lobby.withdraw')}
              </Button>
            </Link>
          </div>
        </Panel>
      ) : null}
      {wallet && (wallet.locked !== '0' || wallet.escrow !== '0') ? (
        <p className="-mt-2 px-1 text-[11px] text-muted">
          {t('lobby.inPlay', {
            locked: formatCredits(wallet.locked),
            escrow: formatCredits(wallet.escrow),
          })}
        </p>
      ) : null}

      {sorted === null ? (
        <div className="flex justify-center py-14">
          <Spinner className="h-6 w-6 text-mint" />
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          title={t('lobby.noTables')}
          body={t('lobby.noTablesBody')}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {sorted.map((entry) => (
            <RoomCard key={entry.room.id} entry={entry} now={now} />
          ))}
        </div>
      )}

      {error ? <p className="text-center text-xs text-danger">{error}</p> : null}

      <Panel className="p-4">
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
          {t('lobby.howTitle')}
        </h2>
        <ol className="mt-2 grid gap-2 text-xs text-muted sm:grid-cols-3">
          <li className="rounded-lg bg-ink/50 p-3">
            <span className="font-display text-base font-bold text-gold">01</span> {t('lobby.how1')}
          </li>
          <li className="rounded-lg bg-ink/50 p-3">
            <span className="font-display text-base font-bold text-gold">02</span> {t('lobby.how2')}
          </li>
          <li className="rounded-lg bg-ink/50 p-3">
            <span className="font-display text-base font-bold text-gold">03</span> {t('lobby.how3')}
          </li>
        </ol>
        <p className="mt-3 text-[11px] text-muted">
          {t('lobby.fairness')}
        </p>
      </Panel>
    </div>
  );
}
