'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  addPreviewCards,
  buyCards,
  newIdempotencyKey,
  registerCards,
  removePreviewCards,
  submitClaim,
} from '@/lib/api';
import { ballTone, claimablePatterns, phaseDeadline } from '@/lib/bingo';
import { formatCredits, formatCountdown, formatStake } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useNow } from '@/lib/useNow';
import { useRoomLive } from '@/lib/useRoom';
import {
  confirmAction,
  getFullscreenState,
  getTelegramWebApp,
  haptic,
  hapticImpact,
  hapticSelection,
  subscribeFullscreen,
  supportsFullscreen,
  toggleFullscreen,
} from '@/lib/telegram';
import { useTelegramClosingConfirmation, useTelegramMainButton } from '@/lib/telegram-hooks';
import { useSession } from '@/components/session';
import { CardBoard } from '@/components/game/board';
import { Button, EmptyState, ErrorNote, Panel, Pill, Spinner, cn } from '@/components/ui';
import type { Card, Room, Round, RoundStatus, WinPattern } from '@/lib/types';

type DaubMode = 'manual' | 'auto';
type Notice = { tone: 'mint' | 'danger'; text: string } | null;

function statusTone(status: RoundStatus) {
  if (status === 'WAITING') return 'gold' as const;
  if (status === 'LOCKED') return 'warn' as const;
  if (status === 'COMPLETED' || status === 'CLAIM_VERIFICATION') return 'mint' as const;
  if (status === 'RUNNER_UP') return 'gold' as const;
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
  maxCards,
  onBought,
}: {
  round: Round;
  roomCode: string;
  maxCards: number;
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
  const options = Array.from(
    { length: Math.max(1, Math.min(4, maxCards)) },
    (_, index) => index + 1,
  );

  const purchase = async () => {
    if (!selling || !affordable) return;
    setError(null);
    const confirmed = await confirmAction({
      title: t('room.buyConfirmTitle'),
      message: t('room.buyConfirmBody', {
        count: quantity,
        amount: formatCredits(cost.toString()),
      }),
      confirmText: t('room.buyConfirmAction'),
      cancelText: t('common.cancel'),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await buyCards({
        roomCode,
        quantity,
        clientSeed: clientSeed.trim() || undefined,
        idempotencyKey: idempotency.current,
      });
      idempotency.current = newIdempotencyKey('buy');
      haptic('success');
      onBought(result.cards);
      void refreshWallet();
    } catch (cause) {
      haptic('error');
      setError(cause instanceof ApiError ? cause.message : t('room.purchaseFailed'));
    } finally {
      setBusy(false);
    }
  };

  const [nativeButton, setNativeButton] = useState(false);
  useEffect(() => {
    setNativeButton(Boolean(getTelegramWebApp()));
  }, []);

  const buyLabel = selling
    ? quantity === 1
      ? t('room.buyOne')
      : t('room.buyMany', { count: quantity })
    : t('room.salesClosedButton');

  useTelegramMainButton({
    text: buyLabel,
    onClick: () => void purchase(),
    visible: nativeButton && selling,
    enabled: selling && affordable && !busy,
    progress: busy,
  });

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

      <div
        className="mt-3 grid gap-2"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((value) => (
          <button
            key={value}
            type="button"
            disabled={!selling}
            onClick={() => {
              hapticSelection();
              setQuantity(value);
            }}
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
        <p className="mt-1.5 text-[11px] text-danger">{t('room.notEnough')}</p>
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

      {nativeButton ? null : (
        <Button
          className="mt-3 w-full"
          size="lg"
          loading={busy}
          disabled={!selling || !affordable}
          onClick={() => void purchase()}
        >
          {buyLabel}
        </Button>
      )}
    </Panel>
  );
}

function MainCardsPanel({
  room,
  cards,
  quantity,
  onQuantityChange,
  onAdd,
  adding,
  onRegisterAll,
  registering,
  seed,
  onSeedChange,
  seedOpen,
  onToggleSeed,
  autoPress,
  onAutoPressChange,
  notice,
}: {
  room: Room;
  cards: Card[];
  quantity: number;
  onQuantityChange: (value: number) => void;
  onAdd: () => void;
  adding: boolean;
  onRegisterAll: () => void;
  registering: boolean;
  seed: string;
  onSeedChange: (value: string) => void;
  seedOpen: boolean;
  onToggleSeed: () => void;
  autoPress: boolean;
  onAutoPressChange: (value: boolean) => void;
  notice: Notice;
}) {
  const { t } = useI18n();
  const pending = cards.filter((card) => card.status === 'PENDING');
  const remaining = Math.max(0, room.maxCardsPerPlayer - cards.length);
  const tiers = Array.isArray(room.bonusTiers) ? room.bonusTiers : [];

  return (
    <Panel className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-bold">{t('room.addCards')}</h2>
          <p className="mt-0.5 text-xs text-muted">{t('room.addCardsHelp')}</p>
        </div>
        <Pill tone="neutral">
          {formatStake(room.stakePerCard)} {t('room.perCard')}
        </Pill>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={Math.max(1, remaining)}
          value={quantity}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) {
              onQuantityChange(Math.max(1, Math.min(Math.max(1, remaining), Math.trunc(next))));
            }
          }}
          className="h-11 w-20 rounded-xl border border-line bg-ink/60 px-3 text-center font-display text-base font-bold focus:border-mint/60 focus:outline-none"
        />
        <Button
          className="flex-1"
          variant="outline"
          loading={adding}
          disabled={remaining === 0}
          onClick={onAdd}
        >
          {t('room.addCardsButton', { count: quantity })}
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted">
        {t('room.maxCards', { count: room.maxCardsPerPlayer })} ·{' '}
        {t('room.cards')}: {cards.length}
      </p>

      {tiers.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tiers.map((tier) => (
            <Pill key={`${tier.minCards}-${tier.bonusCards}`} tone="blue">
              {t('room.bonusTier', { min: tier.minCards, bonus: tier.bonusCards })}
            </Pill>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onToggleSeed}
        className="mt-3 text-[11px] font-semibold text-muted underline-offset-2 hover:text-text hover:underline"
      >
        {seedOpen ? t('room.seedHide') : t('room.seedAdd')}
      </button>
      {seedOpen ? (
        <input
          value={seed}
          onChange={(event) => onSeedChange(event.target.value.slice(0, 64))}
          placeholder="e.g. lucky-cat-42"
          className="mt-2 h-10 w-full rounded-xl border border-line bg-ink/60 px-3 text-xs focus:border-mint/60 focus:outline-none"
        />
      ) : null}

      {room.allowAutoBingoPress ? (
        <label className="mt-3 flex items-start gap-2 rounded-xl bg-ink/50 px-3 py-2">
          <input
            type="checkbox"
            checked={autoPress}
            onChange={(event) => onAutoPressChange(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-mint"
          />
          <span>
            <span className="block text-xs font-semibold">{t('room.autoPress')}</span>
            <span className="block text-[11px] text-muted">{t('room.autoPressHelp')}</span>
          </span>
        </label>
      ) : null}

      <div className="mt-3 rounded-xl border border-line/70 bg-ink/40 px-3 py-2">
        <p className="text-[11px] text-muted">{t('room.registerHelp')}</p>
        <Button
          className="mt-2 w-full"
          size="lg"
          loading={registering}
          disabled={pending.length === 0}
          onClick={onRegisterAll}
        >
          {pending.length === 0
            ? t('room.registered')
            : t('room.register', { count: pending.length })}
        </Button>
      </div>

      {notice ? (
        notice.tone === 'danger' ? (
          <div className="mt-3">
            <ErrorNote>{notice.text}</ErrorNote>
          </div>
        ) : (
          <p className="mt-3 rounded-xl border border-mint/30 bg-mint/10 px-3 py-2 text-xs text-mint">
            {notice.text}
          </p>
        )
      ) : null}
    </Panel>
  );
}

function CardTile({
  card,
  round,
  mainMode,
  daubMode,
  daubed,
  onDaubModeChange,
  onToggleMark,
  onPress,
  pressing,
  canPress,
  pressLabel,
  onClaim,
  claiming,
  onRegister,
  onRemove,
}: {
  card: Card;
  round: Round;
  mainMode: boolean;
  daubMode: DaubMode;
  daubed: readonly number[];
  onDaubModeChange: (mode: DaubMode) => void;
  onToggleMark: (value: number) => void;
  onPress: () => void;
  pressing: boolean;
  canPress: boolean;
  pressLabel: string;
  onClaim: (pattern: WinPattern) => void;
  claiming: string | null;
  onRegister: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const claimPatterns =
    !mainMode && card.status === 'ACTIVE' && round.status === 'CLAIM_VERIFICATION'
      ? claimablePatterns(card, round)
      : [];
  const inPlay =
    mainMode &&
    card.status === 'ACTIVE' &&
    (round.status === 'PLAYING' ||
      round.status === 'CLAIM_VERIFICATION' ||
      round.status === 'RUNNER_UP');

  return (
    <Panel className={cn('min-w-0 p-2.5', card.status === 'WON' && 'border-gold/50')}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-text">
          {t('room.card', { number: card.cardIndex + 1 })}
          <span className="ml-1.5 font-normal text-muted">
            {card.isBonus ? t('room.freeCard') : `${formatStake(card.stake)} ${t('common.credits')}`}
          </span>
        </p>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {card.status === 'PENDING' ? (
            <Pill tone="neutral">{t('room.notRegistered')}</Pill>
          ) : null}
          {card.status === 'BLOCKED' ? (
            <Pill tone="danger">{t('room.blocked')}</Pill>
          ) : null}
          {card.autoPress ? <Pill tone="gold">{t('room.autoPress')}</Pill> : null}
          {!mainMode && card.autoDaub ? <Pill tone="blue">{t('room.auto')}</Pill> : null}
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

      <CardBoard
        card={card}
        drawnBalls={round.drawnBalls}
        currentBall={round.currentBall}
        daubed={mainMode ? daubed : undefined}
        onToggle={mainMode && inPlay ? onToggleMark : undefined}
      />

      {mainMode && inPlay ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex rounded-lg border border-line/70 p-0.5 text-[10px] font-semibold uppercase tracking-wide">
            <button
              type="button"
              onClick={() => onDaubModeChange('manual')}
              className={cn(
                'rounded-md px-2 py-1 transition',
                daubMode === 'manual' ? 'bg-mint/15 text-mint' : 'text-muted',
              )}
            >
              {t('room.daubManual')}
            </button>
            <button
              type="button"
              onClick={() => onDaubModeChange('auto')}
              className={cn(
                'rounded-md px-2 py-1 transition',
                daubMode === 'auto' ? 'bg-mint/15 text-mint' : 'text-muted',
              )}
            >
              {t('room.daubAuto')}
            </button>
          </div>
        </div>
      ) : null}

      {canPress ? (
        <Button
          className="mt-2 w-full"
          size="lg"
          variant="gold"
          loading={pressing}
          onClick={onPress}
        >
          {pressLabel}
        </Button>
      ) : null}

      {card.status === 'PENDING' ? (
        <div className="mt-2 flex items-center gap-2">
          <Button className="flex-1" size="sm" onClick={onRegister}>
            {t('room.registerOne')}
          </Button>
          <button
            type="button"
            onClick={onRemove}
            className="text-[11px] font-semibold text-muted underline-offset-2 hover:text-danger hover:underline"
          >
            {t('room.remove')}
          </button>
        </div>
      ) : null}

      {claimPatterns.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {claimPatterns.map((pattern) => (
            <Button
              key={pattern}
              size="sm"
              variant="gold"
              loading={claiming === `${card.id}:${pattern}`}
              onClick={() => onClaim(pattern)}
            >
              {t('room.claim', { pattern: t(`pattern.${pattern}`) })}
            </Button>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function RunnerUpBanner({ round }: { round: Round }) {
  const { t } = useI18n();
  return (
    <Panel className="border-gold/50 p-4">
      <div className="flex items-center gap-3">
        <Ball value={round.runnerUpNumber} />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gold">
            {t('room.runnerUp')}
          </p>
          <h2 className="mt-0.5 font-display text-lg font-bold">
            {t('room.runnerUpBody', { number: round.runnerUpNumber ?? '—' })}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {t('room.runnerUpPrize')}: {formatCredits(round.runnerUpPrize ?? '0')}{' '}
            {t('common.credits')}
          </p>
        </div>
      </div>
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

function RunnerUpResultBanner({
  round,
  settlement,
}: {
  round: Round;
  settlement: ReturnType<typeof useRoomLive>['runnerUpSettlement'];
}) {
  const { user } = useSession();
  const { t } = useI18n();
  const mine = settlement?.winners.find((winner) => winner.userId === user?.id);
  return (
    <Panel className={cn('p-4', mine ? 'border-gold/60' : 'border-line/70')}>
      <div className="flex items-center gap-3">
        <Ball value={round.runnerUpNumber} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gold">
            {t('room.runnerUpResult')}
          </p>
          <h2 className="mt-0.5 font-display text-base font-bold">
            {mine
              ? t('room.youWon', { amount: formatCredits(mine.payout) })
              : t('room.runnerUpResultBody')}
          </h2>
        </div>
        <span className="text-xs text-muted">
          {formatCredits(round.runnerUpPrize ?? '0')} {t('common.credits')}
        </span>
      </div>
      {settlement && settlement.winners.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {settlement.winners.map((winner) => (
            <li
              key={winner.cardId}
              className="flex items-center justify-between rounded-lg bg-ink/50 px-3 py-2 text-xs"
            >
              <span>{winner.userId === user?.id ? t('room.you') : t('room.player')}</span>
              <span className="font-semibold text-gold">+{formatCredits(winner.payout)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[11px] text-muted">{t('room.runnerUpNoPresses')}</p>
      )}
    </Panel>
  );
}

function hasNumber(card: Card, value: number | null): boolean {
  if (value === null) return false;
  return card.cells.grid.some((row) => row.some((cell) => cell === value));
}

export default function RoomPage() {
  const params = useParams<{ code: string }>();
  const roomCode = params.code;
  const { user, wallet, setWallet, refreshWallet } = useSession();
  const { t } = useI18n();
  const {
    room,
    round,
    cards,
    connected,
    error,
    settlement,
    runnerUpSettlement,
    cancelledReason,
    refreshRoom,
    setCards,
    requestRoundView,
  } = useRoomLive(roomCode, { onWalletUpdate: (patch) => setWallet(patch) });
  const now = useNow();
  const [pressing, setPressing] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimNotice, setClaimNotice] = useState<Notice>(null);
  const [mainNotice, setMainNotice] = useState<Notice>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [addQuantity, setAddQuantity] = useState(1);
  const [adding, setAdding] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [seed, setSeed] = useState('');
  const [seedOpen, setSeedOpen] = useState(false);
  const [autoPress, setAutoPress] = useState(false);
  const [daubModes, setDaubModes] = useState<Record<string, DaubMode>>({});
  const [manualMarks, setManualMarks] = useState<Record<string, number[]>>({});

  useEffect(() => {
    setFullscreen(getFullscreenState());
    return subscribeFullscreen(() => setFullscreen(getFullscreenState()));
  }, []);

  useTelegramClosingConfirmation(
    round?.status === 'LOCKED' ||
      round?.status === 'PLAYING' ||
      round?.status === 'CLAIM_VERIFICATION' ||
      round?.status === 'RUNNER_UP',
  );

  const deadline = useMemo(
    () => phaseDeadline(round, { lockWindowSecs: room?.timings.lockWindowSecs }),
    [round, room?.timings.lockWindowSecs],
  );

  const mainMode = room?.mode === 'MAIN';

  const claim = async (card: Card, pattern: WinPattern) => {
    if (!round) return;
    const key = `${card.id}:${pattern}`;
    setClaiming(key);
    setClaimNotice(null);
    try {
      const result = await submitClaim({ roundId: round.id, cardId: card.id, pattern });
      const rejected = result.status === 'INVALID';
      haptic(rejected ? 'warning' : 'success');
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
      haptic('error');
      setClaimNotice({
        tone: 'danger',
        text: cause instanceof ApiError ? cause.message : t('room.claimFailed'),
      });
    } finally {
      setClaiming(null);
    }
  };

  const toggleMark = (card: Card, value: number) => {
    hapticSelection();
    setManualMarks((current) => {
      const marks = current[card.id] ?? [];
      return {
        ...current,
        [card.id]: marks.includes(value)
          ? marks.filter((mark) => mark !== value)
          : [...marks, value],
      };
    });
  };

  const press = async (card: Card) => {
    if (!round) return;
    hapticImpact('heavy');
    setPressing(card.id);
    setClaimNotice(null);
    try {
      const result = await submitClaim({ roundId: round.id, cardId: card.id });
      haptic(result.status === 'INVALID' ? 'warning' : 'success');
      setClaimNotice({
        tone: result.status === 'INVALID' ? 'danger' : 'mint',
        text:
          result.status === 'INVALID'
            ? t('room.pressInvalid')
            : round.status === 'RUNNER_UP'
              ? t('room.runnerUpAccepted')
              : t('room.pressed'),
      });
      await requestRoundView(round.id);
      void refreshRoom();
    } catch (cause) {
      haptic('error');
      setClaimNotice({
        tone: 'danger',
        text: cause instanceof ApiError ? cause.message : t('room.pressFailed'),
      });
    } finally {
      setPressing(null);
    }
  };

  const addCards = async () => {
    if (!room) return;
    setAdding(true);
    setMainNotice(null);
    try {
      const added = await addPreviewCards({ roomCode, quantity: addQuantity });
      setCards((current) => [...current, ...added]);
      setMainNotice({
        tone: 'mint',
        text: t('room.cardsAdded', { count: added.length }),
      });
      setAddQuantity(1);
      haptic('success');
      void refreshRoom();
    } catch (cause) {
      haptic('error');
      setMainNotice({
        tone: 'danger',
        text: cause instanceof ApiError ? cause.message : t('room.addFailed'),
      });
    } finally {
      setAdding(false);
    }
  };

  const register = async (cardIds: string[]) => {
    if (!room || !round || cardIds.length === 0) return;
    setRegistering(true);
    setMainNotice(null);
    try {
      const result = await registerCards({
        roundId: round.id,
        cardIds,
        clientSeed: seed.trim() || undefined,
        autoPress: room.allowAutoBingoPress ? autoPress : undefined,
      });
      const updated = new Map(result.cards.map((card) => [card.id, card]));
      setCards((current) => current.map((card) => updated.get(card.id) ?? card));
      setMainNotice({ tone: 'mint', text: t('room.registered') });
      haptic('success');
      void refreshWallet();
      void refreshRoom();
    } catch (cause) {
      haptic('error');
      setMainNotice({
        tone: 'danger',
        text: cause instanceof ApiError ? cause.message : t('room.registerFailed'),
      });
    } finally {
      setRegistering(false);
    }
  };

  const removePending = async (cardId: string) => {
    if (!round) return;
    try {
      await removePreviewCards({ roundId: round.id, cardIds: [cardId] });
      setCards((current) => current.filter((card) => card.id !== cardId));
    } catch {
      void refreshRoom();
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
  const ballMax = room.variant === 'US_75' ? 75 : 90;
  const myCards = cards;
  const pendingCards = cards.filter((card) => card.status === 'PENDING');

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="text-xs text-muted hover:text-text">
          {t('room.lobby')}
        </Link>
        <div className="flex items-center gap-2">
          {supportsFullscreen() ? (
            <button
              type="button"
              onClick={() => setFullscreen(toggleFullscreen())}
              className="flex h-7 items-center gap-1 rounded-full border border-line px-2.5 text-[10px] font-semibold uppercase tracking-wide text-muted transition hover:text-text"
              aria-label={fullscreen ? t('room.exitFullscreen') : t('room.fullscreen')}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                {fullscreen ? (
                  <path d="M9 3v6H3V7h4V3zm6 0h2v4h4v2h-6zM3 15h2v4h4v2H3zm16 0h2v6h-6v-2h4z" />
                ) : (
                  <path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z" />
                )}
              </svg>
              {fullscreen ? t('room.exitFullscreen') : t('room.fullscreen')}
            </button>
          ) : null}
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
          <Pill tone={mainMode ? 'gold' : 'blue'}>
            {mainMode ? t('lobby.modeMain') : t('lobby.modeFast')}
          </Pill>
          <Pill tone={room.variant === 'US_75' ? 'blue' : 'gold'}>
            {room.variant === 'US_75' ? t('lobby.v75') : t('lobby.v90')}
          </Pill>
          <Pill tone="neutral">
            {formatStake(room.stakePerCard)} {t('room.perCard')}
          </Pill>
          <Pill tone="neutral">{t('room.maxCards', { count: room.maxCardsPerPlayer })}</Pill>
          {!mainMode ? (
            <Pill tone="neutral">{t('room.rake', { percent: room.rakeBps / 100 })}</Pill>
          ) : null}
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
                  {['PLAYING', 'CLAIM_VERIFICATION', 'RUNNER_UP'].includes(round.status) ? (
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
                          : round.status === 'RUNNER_UP'
                            ? 'phase.runnerUpClose'
                            : 'phase.salesClose',
                    )}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="text-right">
                <p className="text-[9px] uppercase tracking-widest text-muted">
                  {mainMode ? t('room.fixedPrize') : t('lobby.prizePool')}
                </p>
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
                  {t('room.ballProgress', {
                    count: round.drawnBalls.length,
                    total: round.ballOrder?.length ?? ballMax,
                  })}
                </span>
              </p>
              {round.status === 'COMPLETED' && round.drawnBalls.length > 0 ? (
                <p className="mt-1 text-[10px] text-muted">
                  {t('room.endedOn', { count: round.drawnBalls.length })}
                </p>
              ) : null}
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

      {round?.status === 'RUNNER_UP' ? <RunnerUpBanner round={round} /> : null}

      {round?.status === 'COMPLETED' && round.runnerUpNumber !== null ? (
        <RunnerUpResultBanner round={round} settlement={runnerUpSettlement} />
      ) : null}

      {round && settlement && round.status === 'COMPLETED' ? (
        <SettlementBanner round={round} settlement={settlement} />
      ) : null}

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
          <p className="text-xs text-muted">{t('room.finished')}</p>
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

      {round && round.status === 'WAITING' && !mainMode ? (
        <BuyPanel
          round={round}
          roomCode={roomCode}
          maxCards={room.maxCardsPerPlayer}
          onBought={(bought) => {
            setCards((current) => {
              const known = new Set(current.map((card) => card.id));
              return [...current, ...bought.filter((card) => !known.has(card.id))];
            });
            void refreshRoom();
          }}
        />
      ) : null}

      {round && round.status === 'WAITING' && mainMode ? (
        <MainCardsPanel
          room={room}
          cards={cards}
          quantity={addQuantity}
          onQuantityChange={setAddQuantity}
          onAdd={() => void addCards()}
          adding={adding}
          onRegisterAll={() => void register(pendingCards.map((card) => card.id))}
          registering={registering}
          seed={seed}
          onSeedChange={setSeed}
          seedOpen={seedOpen}
          onToggleSeed={() => setSeedOpen((open) => !open)}
          autoPress={autoPress}
          onAutoPressChange={setAutoPress}
          notice={mainNotice}
        />
      ) : null}

      {round && mainMode && (round.status === 'PLAYING' || round.status === 'CLAIM_VERIFICATION') ? (
        <p className="rounded-xl border border-gold/30 bg-gold/10 px-3 py-2 text-[11px] text-gold">
          {t('room.pressHint')}
        </p>
      ) : null}

      {round && myCards.length > 0 ? (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
              {t('room.yourCards')}
            </h2>
            <span className="text-[11px] text-muted">
              {t('room.balance')} {wallet ? formatCredits(wallet.available) : '—'}{' '}
              {t('common.credits')}
            </span>
          </div>
          <div
            className={cn(
              'grid gap-2.5 sm:gap-3',
              myCards.length === 1
                ? 'mx-auto w-full max-w-[17rem]'
                : 'grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4',
            )}
          >
            {myCards.map((card) => {
              const daubMode = mainMode ? (daubModes[card.id] ?? 'manual') : 'auto';
              const daubed =
                daubMode === 'auto' ? round.drawnBalls : (manualMarks[card.id] ?? []);
              const runnerUpMatch = hasNumber(card, round.runnerUpNumber);
              const canPress =
                mainMode &&
                card.status === 'ACTIVE' &&
                (round.status === 'PLAYING' || round.status === 'CLAIM_VERIFICATION'
                  ? true
                  : round.status === 'RUNNER_UP'
                    ? runnerUpMatch
                    : false);
              return (
                <CardTile
                  key={card.id}
                  card={card}
                  round={round}
                  mainMode={mainMode}
                  daubMode={daubMode}
                  daubed={daubed}
                  onDaubModeChange={(mode) =>
                    setDaubModes((current) => ({ ...current, [card.id]: mode }))
                  }
                  onToggleMark={(value) => toggleMark(card, value)}
                  onPress={() => void press(card)}
                  pressing={pressing === card.id}
                  canPress={canPress}
                  pressLabel={
                    round.status === 'RUNNER_UP'
                      ? t('room.runnerUpPress')
                      : t('room.pressBingo')
                  }
                  onClaim={(pattern) => void claim(card, pattern)}
                  claiming={claiming}
                  onRegister={() => void register([card.id])}
                  onRemove={() => void removePending(card.id)}
                />
              );
            })}
          </div>
        </div>
      ) : null}

      {round && myCards.length === 0 && round.status !== 'WAITING' ? (
        <Panel className="p-4 text-center">
          <p className="text-xs text-muted">{t('room.noCards', { number: round.roundNumber })}</p>
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

      {error ? <p className="text-center text-[11px] text-warn">{error}</p> : null}

      {user ? (
        <p className="text-center text-[10px] text-muted">
          {t('room.signedInAs', { name: user.displayName })}
        </p>
      ) : null}
    </div>
  );
}
