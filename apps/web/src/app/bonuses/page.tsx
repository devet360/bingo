'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, fetchBonuses, redeemPromoCode } from '@/lib/api';
import { formatCredits, formatDateTime, formatStake } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/components/session';
import {
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Pill,
  Spinner,
  Stat,
} from '@/components/ui';
import type { Bonus } from '@/lib/types';

const TONE: Record<string, 'mint' | 'gold' | 'danger' | 'neutral'> = {
  ACTIVE: 'gold',
  COMPLETED: 'mint',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
};

function Progress({ wagered, target }: { wagered: string; target: string }) {
  const done = BigInt(wagered);
  const goal = BigInt(target);
  const percent = goal > 0n ? Math.min(100, Number((done * 10_000n) / goal) / 100) : 0;
  return (
    <div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-ink/60">
        <div
          className="h-full rounded-full bg-gradient-to-r from-mint to-gold transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted">
        <span>{formatStake(wagered)} / {formatStake(target)}</span>
        <span className="font-semibold text-mint">{percent.toFixed(0)}%</span>
      </div>
    </div>
  );
}

function BonusRow({ bonus }: { bonus: Bonus }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/50 py-2.5 last:border-0">
      <div>
        <p className="text-sm font-semibold text-text">
          +{formatCredits(bonus.amount)} <span className="text-xs text-muted">{t('common.credits')}</span>
        </p>
        <p className="text-[11px] text-muted">
          {bonus.kind === 'PROMO_CODE' ? t('bonuses.kind.promo') : t('bonuses.kind.grant')} ·{' '}
          {formatDateTime(bonus.createdAt)}
        </p>
      </div>
      <Pill tone={TONE[bonus.status] ?? 'neutral'}>{bonus.status.toLowerCase()}</Pill>
    </div>
  );
}

export default function BonusesPage() {
  const { t } = useI18n();
  const { setWallet } = useSession();
  const [active, setActive] = useState<Bonus | null>(null);
  const [history, setHistory] = useState<Bonus[]>([]);
  const [bonusBalance, setBonusBalance] = useState('0');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchBonuses();
      setActive(data.active);
      setHistory(data.history);
      setBonusBalance(data.wallet.bonus);
      setWallet({ bonus: data.wallet.bonus });
      setError(null);
    } catch {
      setError(t('bonuses.loadError'));
    } finally {
      setLoading(false);
    }
  }, [setWallet, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await redeemPromoCode(code.trim());
      setWallet({ bonus: result.wallet.bonus });
      setCode('');
      setNotice(t('bonuses.redeemed', { amount: formatCredits(result.bonus.amount) }));
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-14">
        <Spinner className="h-6 w-6 text-mint" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="pt-1">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gold/80">
          {t('bonuses.eyebrow')}
        </p>
        <h1 className="mt-1 font-display text-2xl font-black tracking-tight">{t('bonuses.title')}</h1>
        <p className="mt-1 text-xs text-muted">{t('bonuses.blurb')}</p>
      </header>

      <div className="grid grid-cols-2 gap-2">
        <Stat label={t('bonuses.balance')} value={`${formatCredits(bonusBalance)}`} hint={t('common.credits')} />
        <Stat label={t('bonuses.historyCount')} value={history.length} />
      </div>

      {active ? (
        <Panel className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-mint">
                {t('bonuses.active')}
              </p>
              <p className="font-display text-2xl font-black text-gold">
                {formatCredits(active.amount)}{' '}
                <span className="text-xs font-semibold text-muted">{t('common.credits')}</span>
              </p>
            </div>
            <Pill tone="gold">
              {active.multiplier}× {t('bonuses.wagering')}
            </Pill>
          </div>
          <div className="mt-4">
            <Progress wagered={active.wagered} target={active.target} />
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-muted">
            <span>{t('bonuses.expiresAt', { when: formatDateTime(active.expiresAt) })}</span>
            <span>
              {t('bonuses.remaining', {
                amount: formatStake((BigInt(active.target) - BigInt(active.wagered)).toString()),
              })}
            </span>
          </div>
          <p className="mt-3 text-[11px] text-muted">{t('bonuses.activeHint')}</p>
        </Panel>
      ) : null}

      <Panel className="p-4">
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
          {t('bonuses.redeemTitle')}
        </h2>
        <p className="mt-1 text-xs text-muted">{t('bonuses.redeemBlurb')}</p>
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex-1">
            <Input
              label={t('bonuses.code')}
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="BINGO251"
              autoCapitalize="characters"
            />
          </div>
          <Button type="submit" loading={busy} disabled={code.trim().length < 3}>
            {t('bonuses.redeem')}
          </Button>
        </form>
        <div className="mt-2 space-y-2">
          <ErrorNote>{error}</ErrorNote>
          {notice ? (
            <p className="rounded-xl border border-mint/30 bg-mint/10 px-3 py-2 text-xs text-mint">
              {notice}
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel className="p-4">
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
          {t('bonuses.history')}
        </h2>
        {history.length === 0 ? (
          <div className="mt-3">
            <EmptyState title={t('bonuses.none')} body={t('bonuses.noneBody')} />
          </div>
        ) : (
          <div className="mt-2">
            {history.map((bonus) => (
              <BonusRow key={bonus.id} bonus={bonus} />
            ))}
          </div>
        )}
      </Panel>

      <Link
        href="/referrals"
        className="flex items-center justify-between rounded-2xl border border-mint/25 bg-mint/5 px-4 py-3 text-xs text-mint transition hover:border-mint/50"
      >
        <span>{t('bonuses.inviteTeaser')}</span>
        <span className="font-bold">→</span>
      </Link>
    </div>
  );
}
