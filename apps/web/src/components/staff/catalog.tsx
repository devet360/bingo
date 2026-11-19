'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  deleteGameProvider,
  deleteGameProviderGame,
  fetchGameProviders,
  fetchProviderCallbacks,
  fetchProviderSettings,
  fetchProviderTransactions,
  issueGameProviderConsoleToken,
  updateProviderSettings,
  upsertGameProvider,
  upsertGameProviderGame,
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

export function GameProvidersTab() {
  const [providers, setProviders] = useState<GameProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<GameProvider | null>(null);
  const [creating, setCreating] = useState(false);
  const [gameTarget, setGameTarget] = useState<GameProvider | null>(null);
  const [logsTarget, setLogsTarget] = useState<GameProvider | null>(null);

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

  const openConsole = async (provider: GameProvider) => {
    try {
      const issued = await issueGameProviderConsoleToken(provider.code);
      const callback = provider.apiBaseUrl ? new URL(provider.apiBaseUrl) : null;
      if (!callback) {
        setError('Configure a provider callback URL before opening the console.');
        return;
      }
      callback.pathname = '/provider-console';
      callback.search = '';
      callback.hash = '';
      callback.searchParams.set('token', issued.token);
      window.open(callback.toString(), '_blank', 'noopener,noreferrer');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not open the provider console.');
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
              with an HMAC of the raw body.
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
                    <p className="mt-1 break-all text-[10px] text-muted">
                      POST {apiBase}/games/callback/{provider.code}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button size="sm" variant="gold" onClick={() => void openConsole(provider)}>
                      Console
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
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void removeGame(provider, game)}
                        >
                          ✕
                        </Button>
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
            hint="Used in the callback URL."
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
              : 'At least 16 characters. Shared with the provider for HMAC signing.'
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!provider) return;
    setDraft(emptyGame());
    setError(null);
  }, [provider]);

  if (!provider) return null;
  const patch = (next: Partial<GameDraft>) => setDraft({ ...draft, ...next });

  const save = async () => {
    setError(null);
    if (!draft.externalId.trim() || !draft.name.trim()) {
      setError('The external id and name are required.');
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
        <Input
          label="Launch URL template"
          value={draft.launchUrlTemplate}
          onChange={(event) => patch({ launchUrlTemplate: event.target.value })}
          placeholder="https://provider.example/play/{sessionId}?lang={lang}"
          hint="Placeholders: {sessionId}, {token}, {lang}, {currency}."
        />
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
