'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchReferralOverview } from '@/lib/api';
import { formatCredits, formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { getTelegramWebApp } from '@/lib/telegram';
import {
  Button,
  CopyButton,
  EmptyState,
  Panel,
  Pill,
  Spinner,
  Stat,
} from '@/components/ui';
import type { ReferralOverview } from '@/lib/types';

export default function ReferralsPage() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<ReferralOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await fetchReferralOverview());
      setError(null);
    } catch {
      setError(t('referrals.loadError'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!overview) {
    return (
      <div className="flex justify-center py-14">
        {error ? <p className="text-xs text-danger">{error}</p> : <Spinner className="h-6 w-6 text-mint" />}
      </div>
    );
  }

  const shareText = t('referrals.shareText', { code: overview.code });
  const share = () => {
    if (!overview.inviteLink) return;
    const url = `https://t.me/share/url?url=${encodeURIComponent(overview.inviteLink)}&text=${encodeURIComponent(shareText)}`;
    const app = getTelegramWebApp();
    if (app?.openTelegramLink) app.openTelegramLink(url);
    else window.open(url, '_blank', 'noreferrer');
  };

  return (
    <div className="space-y-4">
      <header className="pt-1">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-mint/80">
          {t('referrals.eyebrow')}
        </p>
        <h1 className="mt-1 font-display text-2xl font-black tracking-tight">{t('referrals.title')}</h1>
        <p className="mt-1 text-xs text-muted">
          {t('referrals.blurb', { percent: (overview.commissionBps / 100).toFixed(1) })}
        </p>
      </header>

      <div className="grid grid-cols-3 gap-2">
        <Stat label={t('referrals.invited')} value={overview.referredCount} />
        <Stat label={t('referrals.active')} value={overview.activeReferrals} />
        <Stat
          label={t('referrals.earned')}
          value={formatCredits(overview.totalEarned)}
          hint={t('common.credits')}
        />
      </div>

      <Panel className="overflow-hidden">
        <div className="bg-gradient-to-br from-gold/20 via-panel to-panel px-4 py-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gold">
            {t('referrals.yourCode')}
          </p>
          <p className="mt-1 font-display text-3xl font-black tracking-[0.12em] text-text">
            {overview.code || '—'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <CopyButton value={overview.code} label={t('referrals.copyCode')} />
            {overview.inviteLink ? (
              <>
                <CopyButton value={overview.inviteLink} label={t('referrals.copyLink')} />
                <Button size="sm" variant="gold" onClick={share}>
                  {t('referrals.share')}
                </Button>
              </>
            ) : null}
          </div>
        </div>
        <div className="px-4 py-3">
          <p className="text-[11px] text-muted">{t('referrals.howItWorks')}</p>
        </div>
      </Panel>

      <Panel className="p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
            {t('referrals.recent')}
          </h2>
          <Pill tone="mint">{(overview.commissionBps / 100).toFixed(1)}% {t('referrals.ofRake')}</Pill>
        </div>
        {overview.recent.length === 0 ? (
          <div className="mt-3">
            <EmptyState title={t('referrals.none')} body={t('referrals.noneBody')} />
          </div>
        ) : (
          <div className="mt-2">
            {overview.recent.map((row) => (
              <div
                key={row.id}
                className="flex items-center justify-between gap-3 border-b border-line/50 py-2.5 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text">
                    {row.playerName ?? t('referrals.player')}
                  </p>
                  <p className="text-[11px] text-muted">
                    {t('referrals.rakeBase', { amount: formatCredits(row.rakeBase) })} ·{' '}
                    {formatDateTime(row.createdAt)}
                  </p>
                </div>
                <p className="shrink-0 font-display text-sm font-bold text-mint">
                  +{formatCredits(row.amount)}
                </p>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
