'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, fetchPlayableGames, launchGame } from '@/lib/api';
import { formatStake } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import {
  Button,
  EmptyState,
  ErrorNote,
  Panel,
  Pill,
  Spinner,
} from '@/components/ui';
import type { GameProvider, GameProviderGame } from '@/lib/types';

function GameCard({
  provider,
  game,
  onLaunch,
  busy,
}: {
  provider: GameProvider;
  game: GameProviderGame;
  onLaunch: (game: GameProviderGame) => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="group overflow-hidden rounded-xl border border-line/70 bg-raised/50">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-gradient-to-br from-ink/70 to-raised">
        {game.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={game.thumbnailUrl}
            alt=""
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center font-display text-2xl font-black text-muted/40">
            {game.name.slice(0, 2).toUpperCase()}
          </div>
        )}
        <span className="absolute left-2 top-2">
          <Pill tone="blue">{provider.name}</Pill>
        </span>
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-semibold text-text">{game.name}</p>
        <p className="text-[11px] capitalize text-muted">
          {game.category ?? t('games.category')}
          {game.minStake ? ` · ${t('games.from')} ${formatStake(game.minStake)}` : ''}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2 w-full"
          loading={busy}
          onClick={() => onLaunch(game)}
        >
          {t('games.play')}
        </Button>
      </div>
    </div>
  );
}

export default function GamesPage() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const [providers, setProviders] = useState<GameProvider[] | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProviders(await fetchPlayableGames());
      setError(null);
    } catch {
      setError(t('games.loadError'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = useMemo(
    () => (providers ?? []).reduce((sum, provider) => sum + provider.games.length, 0),
    [providers],
  );

  const play = async (game: GameProviderGame) => {
    setLaunching(game.id);
    setError(null);
    try {
      const session = await launchGame(game.id, lang);
      if (!session.launchUrl) {
        setError(t('games.noLaunchUrl'));
        return;
      }
      router.push(`/games/play/${session.id}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('games.launchError'));
    } finally {
      setLaunching(null);
    }
  };

  return (
    <div className="space-y-4">
      <header className="pt-1">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-mint/80">
          {t('games.eyebrow')}
        </p>
        <h1 className="mt-1 font-display text-2xl font-black tracking-tight">{t('games.title')}</h1>
        <p className="mt-1 text-xs text-muted">{t('games.blurb')}</p>
      </header>

      <Link
        href="/"
        className="flex items-center justify-between rounded-2xl border border-mint/30 bg-mint/10 px-4 py-3"
      >
        <div>
          <p className="text-sm font-semibold text-text">{t('games.nativeTitle')}</p>
          <p className="text-[11px] text-muted">{t('games.nativeBlurb')}</p>
        </div>
        <span className="font-display text-lg font-bold text-mint">→</span>
      </Link>

      <div className="space-y-2">
        <ErrorNote>{error}</ErrorNote>
      </div>

      {providers === null ? (
        <div className="flex justify-center py-14">
          <Spinner className="h-6 w-6 text-mint" />
        </div>
      ) : total === 0 ? (
        <EmptyState
          title={t('games.empty')}
          body={t('games.emptyBody')}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
          }
        />
      ) : (
        providers.map((provider) => (
          <Panel key={provider.id} className="p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
                {provider.name}
              </h2>
              <Pill tone="neutral">{provider.games.length}</Pill>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {provider.games.map((game) => (
                <GameCard
                  key={game.id}
                  provider={provider}
                  game={game}
                  onLaunch={(target) => void play(target)}
                  busy={launching === game.id}
                />
              ))}
            </div>
          </Panel>
        ))
      )}
    </div>
  );
}
