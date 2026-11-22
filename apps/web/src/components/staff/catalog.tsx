'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  deleteGameProvider,
  deleteGameProviderGame,
  fetchGameProviders,
  fetchProviderCallbacks,
  fetchProviderGameCatalogue,
  fetchProviderSettings,
  fetchProviderTransactions,
  testLaunchGameProviderGame,
  updateProviderSettings,
  upsertGameProvider,
  upsertGameProviderGame,
  uploadGameProviderThumbnail,
} from '@/lib/api';
import { creditsToMinor, formatCredits, formatDateTime, formatStake, minorToCreditsInput } from '@/lib/format';
import { getRuntimeConfig } from '@/lib/runtime-config';
import {
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Pill,
  Select,
  Sheet,
  Spinner,
} from '@/components/ui';
import type {
  GameProvider,
  GameProviderGame,
  PageMeta,
  ProviderCallbackLog,
  ProviderCatalogueGame,
  ProviderKind,
  ProviderTransaction,
} from '@/lib/types';
import { LoadingBlock, Pager, SectionTitle } from './shared';

interface ProviderDraft {
  code: string;
  name: string;
  kind: ProviderKind;
  apiBaseUrl: string;
  webhookSecret: string;
  currency: string;
  maxWin: string;
  enabled: boolean;
  sortOrder: string;
}

function emptyProvider(): ProviderDraft {
  return {
    code: '',
    name: '',
    kind: 'AGGREGATOR',
    apiBaseUrl: '',
    webhookSecret: '',
    currency: 'ETB',
    maxWin: '',
    enabled: false,
    sortOrder: '0',
  };
}

function toProviderDraft(provider: GameProvider): ProviderDraft {
  return {
    code: provider.code,
    name: provider.name,
    kind: provider.kind,
    apiBaseUrl: provider.apiBaseUrl ?? '',
    webhookSecret: '',
    currency: provider.currency,
    maxWin: provider.maxWin ? minorToCreditsInput(provider.maxWin) : '',
    enabled: provider.enabled,
    sortOrder: String(provider.sortOrder),
  };
}

export function GameProvidersTab({ onOpenDashboard }: { onOpenDashboard: (code: string) => void }) {
  const [providers, setProviders] = useState<GameProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<GameProvider | null>(null);
  const [creating, setCreating] = useState(false);
  const [gameTarget, setGameTarget] = useState<GameProvider | null>(null);
  const [logsTarget, setLogsTarget] = useState<GameProvider | null>(null);
  const [testingGameId, setTestingGameId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProviders(await fetchGameProviders());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load game providers.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const removeProvider = async (provider: GameProvider) => {
    if (!window.confirm(`Delete provider ${provider.name} and its games?`)) return;
    try {
      await deleteGameProvider(provider.code);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete the provider.');
    }
  };

  const removeGame = async (provider: GameProvider, game: GameProviderGame) => {
    if (!window.confirm(`Remove ${game.name} from ${provider.name}?`)) return;
    try {
      await deleteGameProviderGame(provider.code, game.externalId);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove the game.');
    }
  };

  const testGame = async (game: GameProviderGame) => {
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      setError('Allow pop-ups for this dashboard to test a provider game.');
      return;
    }
    setTestingGameId(game.id);
    setError(null);
    try {
      const { launchUrl } = await testLaunchGameProviderGame(game.id);
      if (!launchUrl) throw new Error('The provider did not return a game URL.');
      const url = new URL(launchUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('The provider returned an unsupported game URL.');
      }
      popup.opener = null;
      popup.location.replace(url.toString());
    } catch (caught) {
      popup.close();
      setError(caught instanceof ApiError
        ? caught.message
        : caught instanceof Error ? caught.message : 'Could not test this provider game.');
    } finally {
      setTestingGameId(null);
    }
  };

  const apiBase = getRuntimeConfig().apiUrl;

  return (
    <div className="space-y-4">
      <ProviderSettingsPanel />
      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line/60 px-4 py-3">
          <div>
            <SectionTitle>External game providers</SectionTitle>
            <p className="mt-1 max-w-2xl text-[11px] text-muted">
              Aggregate third-party games into the same wallet. Players receive a signed session;
              the provider reports bets, wins and rollbacks to the callback below, authenticated
              with an HMAC of the raw body. Play opens a test session in a new tab using a test
              player&apos;s balance, not the admin&apos;s wallet.
            </p>
          </div>
          <Button size="sm" variant="gold" onClick={() => setCreating(true)}>
            Add provider
          </Button>
        </div>

        {error ? (
          <div className="px-4 pt-3">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}

        {providers === null ? (
          <LoadingBlock />
        ) : providers.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="No providers connected"
              body="Native bingo runs on its own engine. Add an aggregator when you are ready to launch third-party games."
            />
          </div>
        ) : (
          <ul className="divide-y divide-line/60">
            {providers.map((provider) => (
              <li key={provider.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-sm font-semibold">{provider.name}</p>
                      <Pill tone={provider.enabled ? 'mint' : 'neutral'}>
                        {provider.enabled ? 'enabled' : 'off'}
                      </Pill>
                      <Pill tone="blue">{provider.kind.toLowerCase()}</Pill>
                      <Pill tone={provider.hasSecret ? 'gold' : 'danger'}>
                        {provider.hasSecret ? 'signed' : 'no secret'}
                      </Pill>
                      <Pill tone="neutral">{provider.currency}</Pill>
                      {provider.maxWin ? (
                        <Pill tone="warn">cap {formatStake(provider.maxWin)}</Pill>
                      ) : null}
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-muted">{provider.code}</p>
                    {provider.apiBaseUrl && !provider.enabled && !provider.hasSecret && provider.games.length === 0 ? (
                      <p className="mt-1 text-[10px] text-muted">Games Provider deployment connection only; tenant callback and secret are created per operator in Provider dashboard.</p>
                    ) : (
                      <p className="mt-1 break-all text-[10px] text-muted">POST {apiBase}/games/callback/{provider.code}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="gold"
                      disabled={!provider.apiBaseUrl}
                      title={provider.apiBaseUrl ? undefined : 'Set a provider API base URL first.'}
                      onClick={() => onOpenDashboard(provider.code)}
                    >
                      Dashboard
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(provider)}>
                      Configure
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setLogsTarget(provider)}>
                      Logs
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setGameTarget(provider)}>
                      Add game
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => void removeProvider(provider)}>
                      Delete
                    </Button>
                  </div>
                </div>

                {provider.games.length === 0 ? (
                  <p className="mt-2 rounded-lg border border-dashed border-line px-3 py-2 text-[11px] text-muted">
                    No games yet — add the provider&apos;s external games to publish them in the
                    player lobby.
                  </p>
                ) : (
                  <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                    {provider.games.map((game) => (
                      <li
                        key={game.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-line/60 bg-raised/40 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold">{game.name}</p>
                          <p className="truncate text-[10px] text-muted">
                            {game.externalId}
                            {game.minStake ? ` · from ${formatStake(game.minStake)}` : ''}
                            {game.enabled ? '' : ' · hidden'}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            loading={testingGameId === game.id}
                            disabled={!provider.enabled || testingGameId !== null}
                            title={!provider.enabled ? 'Enable the provider before testing games.' : 'Open a test session in a new tab.'}
                            onClick={() => void testGame(game)}
                          >
                            Play
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void removeGame(provider, game)}
                          >
                            ✕
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <ProviderSheet
        open={creating || editing !== null}
        provider={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          void load();
        }}
      />

      <GameSheet
        provider={gameTarget}
        onClose={() => setGameTarget(null)}
        onSaved={() => {
          setGameTarget(null);
          void load();
        }}
      />

      <ProviderLogSheet provider={logsTarget} onClose={() => setLogsTarget(null)} />
    </div>
  );
}

function ProviderSettingsPanel() {
  const [draft, setDraft] = useState('');
  const [defaultMaxWin, setDefaultMaxWin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetchProviderSettings()
      .then((settings) => {
        setDraft(minorToCreditsInput(settings.maxWin));
        setDefaultMaxWin(settings.defaultMaxWin);
      })
      .catch(() => setError('Could not load provider payout settings.'));
  }, []);

  const save = async () => {
    const minor = creditsToMinor(draft);
    if (minor === null) {
      setError('Enter a cap like 30000 or 12500.50.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await updateProviderSettings(minor);
      setDraft(minorToCreditsInput(saved.maxWin));
      setNotice(`Platform win cap set to ${formatCredits(saved.maxWin)} ETB.`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the win cap.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="p-4">
      <SectionTitle>Provider payout limits</SectionTitle>
      <p className="mt-1 max-w-2xl text-[11px] text-muted">
        Every provider callback is checked against the game cap, then the provider cap, then this
        platform-wide fallback. Single wins above the applicable cap are rejected and logged.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="w-44">
          <Input
            label="Platform max win (ETB)"
            inputMode="decimal"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            hint={
              defaultMaxWin ? `Default ${formatCredits(defaultMaxWin)} ETB` : undefined
            }
          />
        </div>
        <Button loading={busy} onClick={() => void save()}>
          Save cap
        </Button>
      </div>
      {notice ? <p className="mt-2 text-[11px] text-mint">{notice}</p> : null}
      {error ? (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
    </Panel>
  );
}

function ProviderSheet({
  open,
  provider,
  onClose,
  onSaved,
}: {
  open: boolean;
  provider: GameProvider | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ProviderDraft>(emptyProvider());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(provider ? toProviderDraft(provider) : emptyProvider());
    setError(null);
  }, [open, provider]);

  if (!open) return null;
  const patch = (next: Partial<ProviderDraft>) => setDraft({ ...draft, ...next });

  const save = async () => {
    setError(null);
    const code = draft.code.trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,32}$/.test(code)) {
      setError('The code must be 2–32 lowercase letters, digits, - or _.');
      return;
    }
    if (!draft.name.trim()) {
      setError('A display name is required.');
      return;
    }
    if (draft.webhookSecret.trim() && draft.webhookSecret.trim().length < 16) {
      setError('The signing secret must be at least 16 characters.');
      return;
    }
    const currency = draft.currency.trim().toUpperCase();
    if (!/^[A-Z]{3,8}$/.test(currency)) {
      setError('Use a currency code like ETB or USD.');
      return;
    }
    const maxWin = draft.maxWin.trim() ? creditsToMinor(draft.maxWin) : null;
    if (draft.maxWin.trim() && maxWin === null) {
      setError('The provider win cap must look like 30000 or 12500.50.');
      return;
    }
    const order = Number(draft.sortOrder || '0');
    if (!Number.isInteger(order) || order < 0) {
      setError('Sort order must be zero or a positive whole number.');
      return;
    }
    setBusy(true);
    try {
      await upsertGameProvider(code, {
        name: draft.name.trim(),
        kind: draft.kind,
        apiBaseUrl: draft.apiBaseUrl.trim() || null,
        webhookSecret: draft.webhookSecret.trim() || undefined,
        currency,
        maxWin,
        enabled: draft.enabled,
        sortOrder: order,
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the provider.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open title={provider ? `Configure ${provider.name}` : 'Add a game provider'} onClose={onClose}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Code"
            value={draft.code}
            onChange={(event) => patch({ code: event.target.value.toLowerCase() })}
            disabled={Boolean(provider)}
            hint="This is the tenant/operator code; it must match the Games Provider operator and is used in the callback and launch URLs."
          />
          <Input label="Name" value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
          <Select
            label="Integration"
            value={draft.kind}
            onChange={(event) => patch({ kind: event.target.value as ProviderKind })}
          >
            <option value="AGGREGATOR">Aggregator</option>
            <option value="NATIVE">Native</option>
          </Select>
          <Select
            label="Enabled"
            value={draft.enabled ? 'ON' : 'OFF'}
            onChange={(event) => patch({ enabled: event.target.value === 'ON' })}
          >
            <option value="ON">Live</option>
            <option value="OFF">Off</option>
          </Select>
        </div>
        <Input
          label="API base URL"
          value={draft.apiBaseUrl}
          onChange={(event) => patch({ apiBaseUrl: event.target.value })}
          placeholder="https://api.provider.example"
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Currency"
            value={draft.currency}
            onChange={(event) => patch({ currency: event.target.value.toUpperCase() })}
            placeholder="ETB"
            hint="Callbacks in another currency are rejected."
          />
          <Input
            label="Max win (ETB)"
            inputMode="decimal"
            value={draft.maxWin}
            onChange={(event) => patch({ maxWin: event.target.value })}
            hint="Falls back to the platform cap when blank."
          />
        </div>
        <Input
          label="Webhook secret"
          type="password"
          value={draft.webhookSecret}
          onChange={(event) => patch({ webhookSecret: event.target.value })}
          hint={
            provider?.hasSecret
              ? 'A secret is configured. Leave blank to keep it; enter a new one to rotate.'
              : 'For Games Provider V2, leave this blank on the deployment row and create operators in Provider dashboard; their secret is generated and linked automatically. Other providers may require their supplied HMAC secret here.'
          }
        />
        <Input
          label="Sort order"
          inputMode="numeric"
          value={draft.sortOrder}
          onChange={(event) => patch({ sortOrder: event.target.value })}
        />
        <div className="rounded-xl border border-gold/25 bg-gold/5 px-3 py-2 text-[11px] text-muted">
          Callback:{' '}
          <span className="break-all font-mono text-text">
            {getRuntimeConfig().apiUrl}/games/callback/{draft.code || '<code>'}
          </span>
          <p className="mt-1">
            Send the HMAC-SHA256 hex digest of the raw JSON body in <code>x-provider-signature</code>.
            The secret is write-only and never returned.
          </p>
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button className="w-full" loading={busy} onClick={() => void save()}>
          {provider ? 'Save provider' : 'Add provider'}
        </Button>
      </div>
    </Sheet>
  );
}

interface GameDraft {
  externalId: string;
  name: string;
  category: string;
  thumbnailUrl: string;
  launchUrlTemplate: string;
  minStake: string;
  maxStake: string;
  maxWin: string;
  enabled: boolean;
  sortOrder: string;
}

function emptyGame(): GameDraft {
  return {
    externalId: '',
    name: '',
    category: '',
    thumbnailUrl: '',
    launchUrlTemplate: '',
    minStake: '',
    maxStake: '',
    maxWin: '',
    enabled: true,
    sortOrder: '0',
  };
}

function GameSheet({
  provider,
  onClose,
  onSaved,
}: {
  provider: GameProvider | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<GameDraft>(emptyGame());
  const [catalogue, setCatalogue] = useState<ProviderCatalogueGame[]>([]);
  const [loadingCatalogue, setLoadingCatalogue] = useState(false);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!provider) return;
    setDraft(emptyGame());
    setError(null);
    setCatalogue([]);
    setCatalogueError(null);
    if (!provider.apiBaseUrl) return;
    let cancelled = false;
    setLoadingCatalogue(true);
    void fetchProviderGameCatalogue(provider.code)
      .then((games) => {
        if (!cancelled) setCatalogue(games);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setCatalogue([]);
          const reason = caught instanceof ApiError
            ? caught.message
            : caught instanceof Error ? caught.message : 'Could not load provider games.';
          setCatalogueError(reason);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCatalogue(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  if (!provider) return null;
  const patch = (next: Partial<GameDraft>) => setDraft((current) => ({ ...current, ...next }));
  const selectProviderGame = (id: string) => {
    const game = catalogue.find((entry) => entry.id === id);
    if (!game) {
      patch({ externalId: '' });
      return;
    }
    patch({
      externalId: game.id,
      name: game.name,
      category: game.category,
      thumbnailUrl: game.thumbnailUrl,
    });
  };

  const uploadThumbnail = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const uploaded = await uploadGameProviderThumbnail(file);
      patch({ thumbnailUrl: uploaded.url });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : caught instanceof Error
        ? caught.message
        : 'Could not upload the thumbnail.');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setError(null);
    if (!draft.externalId.trim() || !draft.name.trim()) {
      setError('The external id and name are required.');
      return;
    }
    if (!provider.apiBaseUrl && !draft.launchUrlTemplate.trim()) {
      setError('Set the provider API base URL to generate this game’s launch URL.');
      return;
    }
    const minStake = draft.minStake.trim() ? creditsToMinor(draft.minStake) : null;
    const maxStake = draft.maxStake.trim() ? creditsToMinor(draft.maxStake) : null;
    const maxWin = draft.maxWin.trim() ? creditsToMinor(draft.maxWin) : null;
    if (draft.minStake.trim() && minStake === null) {
      setError('The minimum stake must look like 1 or 0.50.');
      return;
    }
    if (draft.maxStake.trim() && maxStake === null) {
      setError('The maximum stake must look like 100 or 99.50.');
      return;
    }
    if (draft.maxWin.trim() && maxWin === null) {
      setError('The game win cap must look like 30000 or 12500.50.');
      return;
    }
    const order = Number(draft.sortOrder || '0');
    if (!Number.isInteger(order) || order < 0) {
      setError('Sort order must be zero or a positive whole number.');
      return;
    }
    setBusy(true);
    try {
      await upsertGameProviderGame(provider.code, {
        externalId: draft.externalId.trim(),
        name: draft.name.trim(),
        category: draft.category.trim() || null,
        thumbnailUrl: draft.thumbnailUrl.trim() || null,
        launchUrlTemplate: draft.launchUrlTemplate.trim() || null,
        minStake,
        maxStake,
        maxWin,
        enabled: draft.enabled,
        sortOrder: order,
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the game.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open title={`Add a game to ${provider.name}`} onClose={onClose}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        {provider.apiBaseUrl ? (
          <Select
            label="Available provider game"
            value={catalogue.some((game) => game.id === draft.externalId) ? draft.externalId : ''}
            onChange={(event) => selectProviderGame(event.target.value)}
            disabled={loadingCatalogue || catalogue.length === 0}
          >
            <option value="">
              {loadingCatalogue
                ? 'Loading provider games…'
                : catalogueError
                  ? 'Provider catalogue unavailable'
                  : catalogue.length
                    ? 'Select a provider game'
                    : `No supported games enabled for ${provider.code}`}
            </option>
            {catalogue.map((game) => (
              <option key={game.id} value={game.id}>{game.name} ({game.id})</option>
            ))}
          </Select>
        ) : null}
        {catalogueError ? <ErrorNote>{catalogueError}</ErrorNote> : null}
        {!loadingCatalogue && !catalogueError && provider.apiBaseUrl && catalogue.length === 0 ? (
          <ErrorNote>
            Enable Crash or Coin Flip for this operator in the Games Provider owner dashboard, then try again.
          </ErrorNote>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="External id"
            value={draft.externalId}
            onChange={(event) => patch({ externalId: event.target.value })}
          />
          <Input label="Name" value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
          <Input
            label="Category"
            value={draft.category}
            onChange={(event) => patch({ category: event.target.value })}
            placeholder="slots, crash, table"
          />
          <Select
            label="Enabled"
            value={draft.enabled ? 'ON' : 'OFF'}
            onChange={(event) => patch({ enabled: event.target.value === 'ON' })}
          >
            <option value="ON">Visible</option>
            <option value="OFF">Hidden</option>
          </Select>
        </div>
        <Input
          label="Thumbnail URL"
          value={draft.thumbnailUrl}
          onChange={(event) => patch({ thumbnailUrl: event.target.value })}
        />
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted">Or upload a thumbnail</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(event) => {
              void uploadThumbnail(event.target.files?.[0]);
              event.currentTarget.value = '';
            }}
            className="block w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-raised file:px-3 file:py-2 file:text-xs file:font-semibold file:text-text"
          />
        </label>
        <p className="rounded-xl border border-line bg-raised/50 px-3 py-2 text-[11px] leading-relaxed text-muted">
          The launch URL is generated from the Games Provider API base URL, this Bingo
          integration’s code (which must match the Games Provider operator), the external
          game ID, and the session details.
        </p>
        <details className="rounded-xl border border-line px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-text">
            Advanced: custom launch URL
          </summary>
          <div className="pt-3">
            <Input
              label="Launch URL template override"
              value={draft.launchUrlTemplate}
              onChange={(event) => patch({ launchUrlTemplate: event.target.value })}
              placeholder="https://provider.example/play?token={token}&game={game}"
              hint="Only needed when a provider does not use the standard /play?operator=&game= launch route."
            />
          </div>
        </details>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Min stake (ETB)"
            inputMode="decimal"
            value={draft.minStake}
            onChange={(event) => patch({ minStake: event.target.value })}
          />
          <Input
            label="Max stake (ETB)"
            inputMode="decimal"
            value={draft.maxStake}
            onChange={(event) => patch({ maxStake: event.target.value })}
          />
          <Input
            label="Max win (ETB)"
            inputMode="decimal"
            value={draft.maxWin}
            onChange={(event) => patch({ maxWin: event.target.value })}
            hint="Overrides the provider cap for this game."
          />
          <Input
            label="Sort order"
            inputMode="numeric"
            value={draft.sortOrder}
            onChange={(event) => patch({ sortOrder: event.target.value })}
          />
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button className="w-full" loading={busy} onClick={() => void save()}>
          Save game
        </Button>
      </div>
    </Sheet>
  );
}

function ProviderLogSheet({
  provider,
  onClose,
}: {
  provider: GameProvider | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'callbacks' | 'transactions'>('callbacks');
  const [callbacks, setCallbacks] = useState<ProviderCallbackLog[] | null>(null);
  const [transactions, setTransactions] = useState<ProviderTransaction[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const code = provider?.code ?? null;

  useEffect(() => {
    setPage(0);
  }, [code, mode]);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    setError(null);
    const request =
      mode === 'callbacks'
        ? fetchProviderCallbacks(code, { page }).then((result) => {
            if (cancelled) return;
            setCallbacks(result.data);
            setMeta(result.page);
          })
        : fetchProviderTransactions(code, { page }).then((result) => {
            if (cancelled) return;
            setTransactions(result.data);
            setMeta(result.page);
          });
    request.catch((caught) => {
      if (!cancelled) {
        setError(caught instanceof ApiError ? caught.message : 'Could not load provider logs.');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, mode, page]);

  const rows = mode === 'callbacks' ? callbacks : transactions;

  return (
    <Sheet open={provider !== null} title={`${provider?.name ?? 'Provider'} activity`} onClose={onClose}>
      {provider ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-line/70 bg-ink/40 p-1">
            {(
              [
                { value: 'callbacks' as const, label: 'Callbacks' },
                { value: 'transactions' as const, label: 'Transactions' },
              ]
            ).map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={mode === item.value}
                onClick={() => setMode(item.value)}
                className={
                  mode === item.value
                    ? 'h-9 rounded-lg bg-mint/15 text-xs font-semibold text-mint'
                    : 'h-9 rounded-lg text-xs font-semibold text-muted hover:text-text'
                }
              >
                {item.label}
              </button>
            ))}
          </div>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          {rows === null ? (
            <div className="flex justify-center py-6">
              <Spinner className="h-5 w-5 text-mint" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title="Nothing logged yet" body="Provider traffic appears here as it happens." />
          ) : mode === 'callbacks' ? (
            <ul className="divide-y divide-line/60">
              {(callbacks ?? []).map((log) => (
                <li key={log.id} className="py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold">{log.type}</span>
                    <Pill tone={log.httpStatus < 300 ? 'mint' : 'danger'}>{log.httpStatus}</Pill>
                  </div>
                  <p className="text-[10px] text-muted">
                    {log.externalTxnId ?? '—'}
                    {log.amount ? ` · ${formatCredits(log.amount)}` : ''}
                    {log.currency ? ` ${log.currency}` : ''}
                    {log.signatureValid === false ? ' · bad signature' : ''}
                  </p>
                  <p className="text-[10px] text-muted">
                    {formatDateTime(log.createdAt)}
                    {log.error ? ` · ${log.error}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="divide-y divide-line/60">
              {(transactions ?? []).map((transaction) => (
                <li key={transaction.id} className="py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold">
                      {transaction.type} · {formatCredits(transaction.amount)} {transaction.currency}
                    </span>
                    <Pill tone={transaction.status === 'ROLLED_BACK' ? 'neutral' : 'mint'}>
                      {transaction.status.toLowerCase()}
                    </Pill>
                  </div>
                  <p className="text-[10px] text-muted">
                    {transaction.externalTxnId}
                    {transaction.user ? ` · ${transaction.user.displayName}` : ''}
                  </p>
                  <p className="text-[10px] text-muted">{formatDateTime(transaction.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}

          <Pager page={meta} onPage={setPage} />
        </div>
      ) : null}
    </Sheet>
  );
}
