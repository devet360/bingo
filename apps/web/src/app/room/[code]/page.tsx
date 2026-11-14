'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { ApiError, buyCards, newIdempotencyKey, submitClaim } from '@/lib/api';
import { ballTone, claimablePatterns, phaseDeadline } from '@/lib/bingo';
import { formatCredits, formatCountdown, formatStake } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useNow } from '@/lib/useNow';
import { useRoomLive } from '@/lib/useRoom';
import { useSession } from '@/components/session';
import { CardBoard } from '@/components/game/board';
import { Button, EmptyState, ErrorNote, Panel, Pill, Spinner, cn } from '@/components/ui';
import type { Card, Round, RoundStatus, WinPattern } from '@/lib/types';

const LIVE_STATUSES: RoundStatus[] = ['PLAYING', 'CLAIM_VERIFICATION'];

function statusTone(status: RoundStatus) {
  if (status === 'WAITING') return 'gold' as const;
  if (status === 'LOCKED') return 'warn' as const;
  if (status === 'COMPLETED' || status === 'CLAIM_VERIFICATION') return 'mint' as const;
  if (status === 'CANCELLED') return 'danger' as const;
  return 'mint' as const;
}

function Ball({ value, size = 'md' }: { value: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'h-8 w-8 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-20 w-20 text-3xl' };
  if (value === null) {
    return (
      <span
        className={cn(
          'flex items-center justify-center rounded-full border border-dashed border-line text-muted',
          sizes[size],
        )}
      >
        ?
      </span>
    );
  }
  return (
    <span
      className={cn(
        'flex items-center justify-center rounded-full font-display font-black text-white shadow-lg',
        ballTone(value),
        sizes[size],
      )}
    >
      {value}
    </span>
  );
}

function BuyPanel({
  round,
  roomCode,
  onBought,
}: {
  round: Round;
  roomCode: string;
  onBought: (cards: Card[]) => void;
}) {
  const { wallet, refreshWallet } = useSession();
  const { t } = useI18n();
  const [quantity, setQuantity] = useState(1);
  const [clientSeed, setClientSeed] = useState('');
  const [seedOpen, setSeedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotency = useRef(newIdempotencyKey('buy'));

  const stake = BigInt(round.stakePerCard);
  const cost = stake * BigInt(quantity);
  const affordable = wallet ? BigInt(wallet.available) >= cost : false;
  const selling = round.status === 'WAITING';

  const purchase = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await buyCards({
        roomCode,
        quantity,
        clientSeed: clientSeed.trim() || undefined,
        idempotencyKey: idempotency.current,
      });
      idempotency.current = newIdempotencyKey('buy');
      onBought(result.cards);
      void refreshWallet();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('room.purchaseFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-bold">{t('room.getCards')}</h2>
          <p className="mt-0.5 text-xs text-muted">
            {selling
              ? t('room.salesClose')
              : t('room.salesClosed', { status: t(`round.${round.status}`) })}
          </p>
        </div>
        <Pill tone={selling ? 'gold' : 'neutral'}>
          {formatStake(round.stakePerCard)} {t('room.perCard')}
        </Pill>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2">
        {[1, 2, 3, 4].map((value) => (
          <button
            key={value}
            type="button"
            disabled={!selling}
            onClick={() => setQuantity(value)}
            className={cn(
              'rounded-xl border py-2.5 font-display text-base font-bold transition disabled:opacity-40',
              quantity === value
                ? 'border-mint bg-mint/15 text-mint'
                : 'border-line bg-ink/50 text-muted hover:text-text',
            )}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between rounded-xl bg-ink/50 px-3 py-2 text-sm">
        <span className="text-muted">{t('room.total')}</span>
        <span className="font-display font-bold text-gold">
          {formatCredits(cost.toString())} {t('common.credits')}
        </span>
      </div>
      {wallet && !affordable ? (
        <p className="mt-1.5 text-[11px] text-danger">
          {t('room.notEnough')}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => setSeedOpen((open) => !open)}
        className="mt-3 text-[11px] font-semibold text-muted underline-offset-2 hover:text-text hover:underline"
      >
        {seedOpen ? t('room.seedHide') : t('room.seedAdd')}
      </button>
      {seedOpen ? (
        <input
          value={clientSeed}
          onChange={(event) => setClientSeed(event.target.value.slice(0, 64))}
          placeholder="e.g. lucky-cat-42"
          className="mt-2 h-10 w-full rounded-xl border border-line bg-ink/60 px-3 text-xs focus:border-mint/60 focus:outline-none"
        />
      ) : null}

      {error ? (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}

      <Button
        className="mt-3 w-full"
        size="lg"
        loading={busy}
        disabled={!selling || !affordable}
        onClick={() => void purchase()}
      >
        {selling
          ? quantity === 1
            ? t('room.buyOne')
            : t('room.buyMany', { count: quantity })
          : t('room.salesClosedButton')}
      </Button>
    </Panel>
  );
}

function CardTile({
  card,
  round,
  onClaim,
  claiming,
}: {
  card: Card;
  round: Round;
  onClaim: (card: Card, pattern: WinPattern) => void;
  claiming: string | null;
}) {
  const { t } = useI18n();
  const patterns =
    card.status === 'ACTIVE' && LIVE_STATUSES.includes(round.status)
      ? claimablePatterns(card, round)
      : [];

  return (
    <Panel className={cn('p-3', card.status === 'WON' && 'border-gold/50')}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-text">
          {t('room.card', { number: card.cardIndex + 1 })}
          <span className="ml-1.5 font-normal text-muted">
            {formatStake(card.stake)} {t('common.credits')}
          </span>
        </p>
        <div className="flex items-center gap-1.5">
          {card.autoDaub ? <Pill tone="blue">{t('room.auto')}</Pill> : null}
          {card.status === 'WON' ? (
            <Pill tone="gold">
              {t('room.won', {
                pattern: card.wonPattern ? t(`pattern.${card.wonPattern}`) : '',
              })}
            </Pill>
          ) : card.status === 'REFUNDED' ? (
            <Pill tone="neutral">{t('room.refunded')}</Pill>
          ) : null}
        </div>
      </div>
      <CardBoard card={card} drawnBalls={round.drawnBalls} currentBall={round.currentBall} />
      {patterns.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {patterns.map((pattern) => {
            const key = `${card.id}:${pattern}`;
            return (
              <Button
                key={pattern}
                size="sm"
                variant="gold"
                loading={claiming === key}
                onClick={() => onClaim(card, pattern)}
              >
                {t('room.claim', { pattern: t(`pattern.${pattern}`) })}
              </Button>
            );
          })}
        </div>
      ) : null}
    </Panel>
  );
}

function SettlementBanner({
  round,
  settlement,
}: {
  round: Round;
  settlement: ReturnType<typeof useRoomLive>['settlement'];
}) {
  const { user } = useSession();
  const { t } = useI18n();
  const mine = settlement?.winners.find((winner) => winner.userId === user?.id);
  return (
    <Panel className={cn('p-4', mine ? 'border-gold/60' : 'border-mint/40')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">
            {t('room.settled', { number: round.roundNumber })}
          </p>
          <h2 className="mt-1 font-display text-lg font-bold">
            {mine
              ? t('room.youWon', { amount: formatCredits(mine.payout) })
              : t('room.complete')}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {t('room.prizeRake', {
              pool: formatCredits(round.prizePool),
              rake: formatCredits(round.rakeAmount),
            })}
          </p>
        </div>
        <Link href={`/verify/${round.id}`}>
          <Button variant="outline" size="sm">
            {t('room.verifyDraw')}
          </Button>
        </Link>
      </div>
      {settlement && settlement.winners.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {settlement.winners.map((winner) => (
            <li
              key={`${winner.cardId}:${winner.pattern}`}
              className="flex items-center justify-between rounded-lg bg-ink/50 px-3 py-2 text-xs"
            >
              <span>
                {winner.userId === user?.id ? t('room.you') : t('room.player')} ·{' '}
                {t(`pattern.${winner.pattern}`)}
              </span>
              <span className="font-semibold text-gold">+{formatCredits(winner.payout)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 rounded-lg bg-ink/50 px-3 py-2 text-xs text-muted">
          {t('room.noWinner')}
        </p>
      )}
    </Panel>
  );
}

export default function RoomPage() {
  const params = useParams<{ code: string }>();
  const roomCode = params.code;
  const { user, wallet, setWallet, refreshWallet } = useSession();
  const { t } = useI18n();
  const { room, round, cards, connected, error, settlement, cancelledReason, refreshRoom, setCards } =
    useRoomLive(roomCode, { onWalletUpdate: (patch) => setWallet(patch) });
  const now = useNow();
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimNotice, setClaimNotice] = useState<{ tone: 'mint' | 'danger'; text: string } | null>(
    null,
  );

  const deadline = useMemo(
    () =>
      phaseDeadline(round, {
        drawIntervalMs: room?.timings.drawIntervalMs,
        lockWindowSecs: room?.timings.lockWindowSecs,
      }),
    [round, room?.timings.drawIntervalMs, room?.timings.lockWindowSecs],
  );

  const claim = async (card: Card, pattern: WinPattern) => {
    if (!round) return;
    const key = `${card.id}:${pattern}`;
    setClaiming(key);
    setClaimNotice(null);
    try {
      const result = await submitClaim({ roundId: round.id, cardId: card.id, pattern });
      setClaimNotice({
        tone: 'mint',
        text:
          result.status === 'INVALID'
            ? t('room.claimRejected', {
                reason: result.rejectionReason ?? t('room.patternIncomplete'),
              })
            : t('room.claimSubmitted'),
      });
    } catch (cause) {
      setClaimNotice({
        tone: 'danger',
        text: cause instanceof ApiError ? cause.message : t('room.claimFailed'),
      });
    } finally {
      setClaiming(null);
    }
  };

  if (!room) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted">
        {error ? (
          <>
            <p className="text-sm">{error}</p>
            <Link href="/">
              <Button variant="outline" size="sm">
                {t('room.backLobby')}
              </Button>
            </Link>
          </>
        ) : (
          <>
            <Spinner className="h-6 w-6 text-mint" />
            <p className="text-xs uppercase tracking-widest">{t('room.opening')}</p>
          </>
        )}
      </div>
    );
  }

  const recent = round ? [...round.drawnBalls].slice(-12).reverse() : [];
  const myCards = cards;

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="text-xs text-muted hover:text-text">
          {t('room.lobby')}
        </Link>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              connected ? 'bg-mint' : 'animate-pulse bg-warn',
            )}
          />
          <span className="text-[10px] uppercase tracking-widest text-muted">
            {connected ? t('room.live') : t('room.reconnecting')}
          </span>
        </div>
      </div>

      <div>
        <h1 className="font-display text-xl font-black tracking-tight">{room.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Pill tone={room.variant === 'US_75' ? 'blue' : 'gold'}>
            {room.variant === 'US_75' ? t('lobby.v75') : t('lobby.v90')}
          </Pill>
          <Pill tone="neutral">
            {formatStake(room.stakePerCard)} {t('room.perCard')}
          </Pill>
          <Pill tone="neutral">{t('room.maxCards', { count: room.maxCardsPerPlayer })}</Pill>
          <Pill tone="neutral">{t('room.rake', { percent: room.rakeBps / 100 })}</Pill>
        </div>
      </div>

      {round ? (
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-3">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted">
                {t('lobby.round', { number: round.roundNumber })}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <Pill tone={statusTone(round.status)}>
                  {LIVE_STATUSES.includes(round.status) ? (
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                  ) : null}
                  {t(`round.${round.status}`)}
                </Pill>
                {deadline ? (
                  <span className="font-display text-sm font-semibold tabular-nums text-text">
                    {formatCountdown(deadline.at, now)}
                  </span>
                ) : null}
                {deadline ? (
                  <span className="text-[10px] text-muted">
                    {t(
                      round.status === 'LOCKED'
                        ? 'phase.firstBall'
                        : round.status === 'CLAIM_VERIFICATION'
                          ? 'phase.claimsClose'
                          : round.status === 'PLAYING'
                            ? 'phase.nextBall'
                            : 'phase.salesClose',
                    )}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="text-right">
                <p className="text-[9px] uppercase tracking-widest text-muted">{t('lobby.prizePool')}</p>
                <p className="font-display text-lg font-bold text-mint">
                  {formatCredits(round.prizePool)}
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 px-4 py-4">
            <Ball value={round.currentBall} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-widest text-muted">
                {round.drawnBalls.length > 0 ? t('room.lastBall') : t('room.waitingFirst')}
              </p>
              <p className="font-display text-xl font-bold">
                {round.currentBall ?? '—'}
                <span className="ml-2 text-xs font-normal text-muted">
                  {t('room.drawn', { count: round.drawnBalls.length })}
                </span>
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                {recent.map((ball, index) => (
                  <Ball key={`${ball}-${index}`} value={ball} size="sm" />
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 border-t border-line/70 text-center">
            <div className="px-2 py-2">
              <p className="text-[9px] uppercase tracking-widest text-muted">{t('room.cards')}</p>
              <p className="font-display text-sm font-semibold">{round.cardsSold}</p>
            </div>
            <div className="border-x border-line/70 px-2 py-2">
              <p className="text-[9px] uppercase tracking-widest text-muted">{t('lobby.players')}</p>
              <p className="font-display text-sm font-semibold">{round.uniquePlayers}</p>
            </div>
            <div className="px-2 py-2">
              <p className="text-[9px] uppercase tracking-widest text-muted">{t('room.yourCards')}</p>
              <p className="font-display text-sm font-semibold text-gold">{myCards.length}</p>
            </div>
          </div>
        </Panel>
      ) : (
        <EmptyState title={t('room.nextRound')} body={t('room.nextRoundBody')} />
      )}

      {round && settlement ? <SettlementBanner round={round} settlement={settlement} /> : null}

      {round?.status === 'CANCELLED' ? (
        <Panel className="border-danger/40 p-4">
          <h2 className="font-display text-sm font-bold text-danger">{t('room.cancelled')}</h2>
          <p className="mt-1 text-xs text-muted">
            {cancelledReason === 'INSUFFICIENT_PLAYERS'
              ? t('room.insufficient')
              : t('room.cancelledRefund')}
          </p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => void refreshWallet()}>
            {t('room.refreshBalance')}
          </Button>
        </Panel>
      ) : null}

      {round?.status === 'COMPLETED' && !settlement ? (
        <Panel className="flex items-center gap-3 p-4">
          <Spinner className="h-4 w-4 text-mint" />
          <p className="text-xs text-muted">
            {t('room.finished')}
          </p>
        </Panel>
      ) : null}

      {claimNotice ? (
        claimNotice.tone === 'danger' ? (
          <ErrorNote>{claimNotice.text}</ErrorNote>
        ) : (
          <p className="rounded-xl border border-mint/30 bg-mint/10 px-3 py-2 text-xs text-mint">
            {claimNotice.text}
          </p>
        )
      ) : null}

      {round && round.status === 'WAITING' ? (
        <BuyPanel
          round={round}
          roomCode={roomCode}
          onBought={(bought) => {
            setCards((current) => {
              const known = new Set(current.map((card) => card.id));
              return [...current, ...bought.filter((card) => !known.has(card.id))];
            });
            void refreshRoom();
          }}
        />
      ) : null}

      {round && myCards.length > 0 ? (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
              {t('room.yourCards')}
            </h2>
            <span className="text-[11px] text-muted">
              {t('room.balance')} {wallet ? formatCredits(wallet.available) : '—'}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {myCards.map((card) => (
              <CardTile
                key={card.id}
                card={card}
                round={round}
                claiming={claiming}
                onClaim={(target, pattern) => void claim(target, pattern)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {round && myCards.length === 0 && round.status !== 'WAITING' ? (
        <Panel className="p-4 text-center">
          <p className="text-xs text-muted">
            {t('room.noCards', { number: round.roundNumber })}
          </p>
        </Panel>
      ) : null}

      {round && (round.serverSeed || round.status === 'COMPLETED') ? (
        <div className="text-center">
          <Link
            href={`/verify/${round.id}`}
            className="text-[11px] font-semibold text-mint underline-offset-2 hover:underline"
          >
            {t('room.verifyRound')}
          </Link>
        </div>
      ) : null}

      {error ? (
        <p className="text-center text-[11px] text-warn">{error}</p>
      ) : null}

      {user ? (
        <p className="text-center text-[10px] text-muted">
          {t('room.signedInAs', { name: user.displayName })}
        </p>
      ) : null}
    </div>
  );
}
