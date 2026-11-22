'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ApiError,
  createTestPlayer,
  createGamesProviderOperator,
  deleteGamesProviderOperator,
  fetchGameProviders,
  fetchGamesProviderDashboard,
  fetchGamesProviderOperator,
  fetchGamesProviderOperators,
  fetchGamesProviderRuntimeSettings,
  probeGamesProviderOperator,
  retirePreviousGamesProviderSecret,
  rotateGamesProviderOperatorSecret,
  setGamesProviderOperatorStatus,
  updateGamesProviderOperator,
  updateGamesProviderRuntimeSettings,
} from '@/lib/api';
import type {
  GamesProviderDashboard,
  GamesProviderOperatorInput,
  GamesProviderOperatorPatch,
  GamesProviderOperator,
  GamesProviderRuntimeSettings,
} from '@/lib/api';
import type { GameProvider } from '@/lib/types';
import { getRuntimeConfig } from '@/lib/runtime-config';
import { Button, EmptyState, ErrorNote, Input, Panel, Pill, Select, Spinner } from '@/components/ui';

type ProviderPage = 'overview' | 'operators' | 'settings' | 'test-player' | 'operator-new' | 'operator-detail';

function providerPage(pathname: string): { page: ProviderPage; operatorCode?: string } {
  const parts = pathname.split('/').filter(Boolean).slice(2);
  if (parts[0] === 'operators' && parts[1] === 'new') return { page: 'operator-new' };
  if (parts[0] === 'operators' && parts[1]) {
    return { page: 'operator-detail', operatorCode: decodeURIComponent(parts[1]!) };
  }
  if (parts[0] === 'operators') return { page: 'operators' };
  if (parts[0] === 'settings') return { page: 'settings' };
  if (parts[0] === 'test-player') return { page: 'test-player' };
  return { page: 'overview' };
}

function formatAmount(value: string): string {
  try {
    const minor = BigInt(value);
    return `${(minor / 100n).toLocaleString()}.${String(minor % 100n).padStart(2, '0')}`;
  } catch {
    return '—';
  }
}

function messageOf(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : error instanceof Error ? error.message : 'The provider request failed.';
}

function OperatorStatus({ status }: { status: GamesProviderOperator['status'] }) {
  return <Pill tone={status === 'ACTIVE' ? 'mint' : status === 'PENDING' ? 'warn' : 'danger'}>{status}</Pill>;
}

export function ProviderManagement({ preferredProviderCode }: { preferredProviderCode?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const route = useMemo(() => providerPage(pathname), [pathname]);
  const [providers, setProviders] = useState<GameProvider[] | null>(null);
  const [hostCode, setHostCode] = useState('');
  const [dashboard, setDashboard] = useState<GamesProviderDashboard | null>(null);
  const [operators, setOperators] = useState<GamesProviderOperator[] | null>(null);
  const [operator, setOperator] = useState<GamesProviderOperator | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<GamesProviderRuntimeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchGameProviders().then((items) => {
      if (cancelled) return;
      const configured = items.filter((item) => item.apiBaseUrl !== null);
      setProviders(configured);
      const preferred = new URLSearchParams(window.location.search).get('host') ?? preferredProviderCode;
      const selected = configured.find((item) => item.code === preferred) ?? configured[0];
      setHostCode(selected?.code ?? '');
    }).catch((caught: unknown) => {
      if (!cancelled) {
        setProviders([]);
        setError(messageOf(caught));
      }
    });
    return () => { cancelled = true; };
  }, [preferredProviderCode]);

  const host = providers?.find((item) => item.code === hostCode) ?? null;
  const href = useCallback((path: string) => {
    const query = hostCode ? `?host=${encodeURIComponent(hostCode)}` : '';
    return `/admin/provider/${path}${query}`;
  }, [hostCode]);

  const loadPageData = useCallback(async () => {
    if (!hostCode) return;
    setError(null);
    try {
      if (route.page === 'overview') {
        setDashboard(await fetchGamesProviderDashboard(hostCode));
      } else if (route.page === 'operators') {
        setOperators(await fetchGamesProviderOperators(hostCode));
      } else if (route.page === 'settings') {
        setRuntimeSettings(await fetchGamesProviderRuntimeSettings(hostCode));
      } else if (route.page === 'operator-detail' && route.operatorCode) {
        setOperator(await fetchGamesProviderOperator(hostCode, route.operatorCode));
      }
    } catch (caught) {
      setError(messageOf(caught));
    }
  }, [hostCode, route]);

  useEffect(() => { void loadPageData(); }, [loadPageData]);

  const changeHost = (code: string) => {
    setHostCode(code);
    router.replace(`${pathname}?host=${encodeURIComponent(code)}`);
  };

  const perform = async (action: () => Promise<unknown>, success: string, refresh = true) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      if (refresh) await loadPageData();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  if (providers === null) return <Panel className="flex justify-center p-8"><Spinner /></Panel>;
  if (providers.length === 0) {
    return <EmptyState title="No Games Provider API configured" body={error ?? 'Add a Games Provider connection in Super Admin → Games before managing operators.'} />;
  }

  return (
    <div className="space-y-4">
      <Panel className="flex flex-wrap items-end justify-between gap-3 p-4">
        <div className="min-w-[220px] flex-1">
          <Select label="Games Provider deployment" value={hostCode} onChange={(event) => changeHost(event.target.value)}>
            {providers.map((item) => <option key={item.code} value={item.code}>{item.name} ({item.code})</option>)}
          </Select>
          <p className="mt-1 text-[11px] text-muted">
            This selects the Games Provider deployment, not its operator code. Create or choose the tenant code separately (for example, deployment <code>stratos</code> can host operator <code>bingo251</code>). Requests use short-lived, server-side scoped tokens.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="rounded-xl border border-line px-3 py-2 text-xs font-semibold hover:bg-raised" href={href('overview')}>Overview</Link>
          <Link className="rounded-xl border border-line px-3 py-2 text-xs font-semibold hover:bg-raised" href={href('operators')}>Operators</Link>
          <Link className="rounded-xl border border-line px-3 py-2 text-xs font-semibold hover:bg-raised" href={href('settings')}>Runtime settings</Link>
          <Link className="rounded-xl border border-line px-3 py-2 text-xs font-semibold hover:bg-raised" href={href('test-player')}>Test player</Link>
          {host?.apiBaseUrl ? <a className="rounded-xl border border-line px-3 py-2 text-xs font-semibold hover:bg-raised" href={`${host.apiBaseUrl.replace(/\/+$/, '')}/api/docs`} target="_blank" rel="noopener noreferrer">API docs</a> : null}
        </div>
      </Panel>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? <p className="rounded-xl border border-mint/30 bg-mint/10 px-3 py-2 text-xs text-mint">{notice}</p> : null}

      {route.page === 'overview' ? (
        dashboard ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <Metric label="Operators" value={dashboard.operators.length} hint={`${dashboard.operators.filter((item) => item.status === 'ACTIVE').length} active`} />
              <Metric label="Active sessions" value={dashboard.metrics.sessions.active} hint={`${dashboard.metrics.sessions.total} total`} />
              <Metric label="Rounds · 24h" value={dashboard.metrics.rounds.last24Hours} hint={`${dashboard.metrics.rounds.total} total`} />
              <Metric label="Unsettled bets" value={dashboard.metrics.bets.unsettled} hint={`${dashboard.metrics.bets.total} total`} />
              <Metric label="Pending wallet delivery" value={dashboard.metrics.outbox.pending} hint={`${dashboard.metrics.outbox.dead} failed`} />
            </div>
            <OperatorTable operators={dashboard.operators} href={href} />
          </div>
        ) : <Panel className="p-5 text-sm text-muted">Loading provider metrics…</Panel>
      ) : null}

      {route.page === 'operators' ? (
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line/60 px-4 py-3">
            <div><h2 className="font-display font-bold">Operators</h2><p className="text-xs text-muted">Connected operators, game access and lifecycle status.</p></div>
            <Button size="sm" variant="gold" onClick={() => router.push(href('operators/new'))}>Add operator</Button>
          </div>
          {operators ? <OperatorTable operators={operators} href={href} /> : <p className="p-4 text-sm text-muted">Loading operators…</p>}
        </Panel>
      ) : null}

      {route.page === 'operator-new' ? (
        <OperatorCreateForm hostCode={hostCode} onCancel={() => router.push(href('operators'))} onCreated={(code) => router.push(href(`operators/${encodeURIComponent(code)}`))} />
      ) : null}

      {route.page === 'operator-detail' ? (
        operator ? (
          <OperatorDetail
            operator={operator}
            hostCode={hostCode}
            busy={busy}
            onUpdate={(patch) => void perform(() => updateGamesProviderOperator(hostCode, operator.code, patch), 'Operator configuration saved.')}
            onProbe={() => void perform(() => probeGamesProviderOperator(hostCode, operator.code), 'Probe succeeded.')}
            onStatus={(status) => void perform(() => setGamesProviderOperatorStatus(hostCode, operator.code, status), `Operator status updated: ${status}.`)}
            onRotate={() => void perform(() => rotateGamesProviderOperatorSecret(hostCode, operator.code), 'Webhook secret rotated and synchronized with Bingo. Keep the previous secret until the new probe succeeds.')}
            onRetire={() => void perform(() => retirePreviousGamesProviderSecret(hostCode, operator.code), 'Previous Bingo callback secret retired.')}
            onDelete={() => {
              if (!window.confirm(`Permanently delete suspended operator "${operator.code}"? This is allowed only if it has no sessions or financial history.`)) return;
              void perform(async () => {
                await deleteGamesProviderOperator(hostCode, operator.code);
                router.push(href('operators'));
              }, 'Operator deleted.', false);
            }}
          />
        ) : <Panel className="p-5 text-sm text-muted">Loading operator…</Panel>
      ) : null}

      {route.page === 'settings' ? (
        runtimeSettings
          ? <RuntimeSettingsForm settings={runtimeSettings} busy={busy} onSave={(settings) => void perform(() => updateGamesProviderRuntimeSettings(hostCode, settings), 'Provider runtime settings saved.')}/>
          : <Panel className="p-5 text-sm text-muted">Loading provider runtime settings…</Panel>
      ) : null}
      {route.page === 'test-player' ? <TestPlayerSetup /> : null}
    </div>
  );
}

function TestPlayerSetup() {
  const [credentials, setCredentials] = useState<{ email: string; password: string; startingBalanceMinor: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    setCredentials(null);
    try {
      const result = await createTestPlayer('Games Provider Test Player');
      setCredentials({
        email: result.email,
        password: result.password,
        startingBalanceMinor: result.startingBalanceMinor,
      });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel className="space-y-3 p-4">
      <div>
        <h2 className="font-display text-lg font-bold">Test player</h2>
        <p className="text-xs text-muted">Admin Play actions use the newest active test player. Test players cannot deposit or withdraw.</p>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button variant="gold" loading={busy} onClick={() => void create()}>Create test player</Button>
      {credentials ? (
        <div className="grid gap-2 rounded-xl border border-mint/25 bg-mint/5 p-3 text-xs sm:grid-cols-2">
          <p><span className="text-muted">Login:</span> <code>{credentials.email}</code></p>
          <p><span className="text-muted">One-time password:</span> <code>{credentials.password}</code></p>
          <p className="text-muted sm:col-span-2">Starting balance: {formatAmount(credentials.startingBalanceMinor)}. This password is shown only once.</p>
        </div>
      ) : null}
    </Panel>
  );
}

function Metric({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return <Panel className="p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</p><p className="mt-1 font-display text-xl font-bold">{value}</p><p className="text-[11px] text-muted">{hint}</p></Panel>;
}

function OperatorTable({
  operators,
  href,
}: {
  operators: Array<Pick<GamesProviderOperator, 'code' | 'name' | 'status' | 'currency' | 'enabledGames' | 'maintenance' | 'probeOkAt' | 'createdAt'>>;
  href: (path: string) => string;
}) {
  if (operators.length === 0) return <div className="p-4"><EmptyState title="No operators configured" body="Create an operator to connect a platform to this provider." /></div>;
  return (
    <ul className="divide-y divide-line/60">
      {operators.map((item) => (
        <li key={item.code} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <Link href={href(`operators/${encodeURIComponent(item.code)}`)} className="text-sm font-semibold hover:text-mint">{item.name}</Link>
            <p className="font-mono text-[11px] text-muted">{item.code} · {item.currency} · {(item.enabledGames ?? []).join(', ') || 'no games'}{item.maintenance ? ' · maintenance' : ''}</p>
          </div>
          <div className="flex items-center gap-2"><OperatorStatus status={item.status} /><Link href={href(`operators/${encodeURIComponent(item.code)}`)} className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold">Manage</Link></div>
        </li>
      ))}
    </ul>
  );
}

function OperatorCreateForm({ hostCode, onCancel, onCreated }: { hostCode: string; onCancel: () => void; onCreated: (code: string) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [minStake, setMinStake] = useState('100');
  const [maxStake, setMaxStake] = useState('100000');
  const [maxWin, setMaxWin] = useState('3000000');
  const [maxBets, setMaxBets] = useState('200');
  const [games, setGames] = useState('crash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const normalizedCode = code.trim().toLowerCase();
      const result = await createGamesProviderOperator(hostCode, {
        code: normalizedCode,
        name: name.trim(),
        currency: 'ETB',
        localeDefault: 'en',
        limits: { minStake, maxStake, maxWin, maxBetsPerRound: Number(maxBets) },
        enabledGames: games.split(',').map((value) => value.trim()).filter(Boolean),
      });
      if (!result.bingoLinked) throw new Error('Operator was created but could not be linked to Bingo.');
      onCreated(normalizedCode);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel className="p-4">
      <h2 className="font-display text-lg font-bold">Create operator</h2>
      <p className="mb-4 text-xs text-muted">Creates a PENDING operator. Bingo generates its callback address from the API host, uses configured Bingo web origins, and automatically stores the provider-generated signing secret.</p>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
        <Input label="Code" required minLength={2} maxLength={32} pattern="[a-z0-9_-]+" value={code} onChange={(event) => setCode(event.target.value.toLowerCase())} hint="The same tenant code is used for the provider, callback, and game launch." />
        <Input label="Display name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        <Input label="Minimum stake (minor units)" type="number" min="1" value={minStake} onChange={(event) => setMinStake(event.target.value)} />
        <Input label="Maximum stake (minor units)" type="number" min="1" value={maxStake} onChange={(event) => setMaxStake(event.target.value)} />
        <Input label="Maximum win (minor units)" type="number" min="1" value={maxWin} onChange={(event) => setMaxWin(event.target.value)} />
        <Input label="Maximum bets per round" type="number" min="1" value={maxBets} onChange={(event) => setMaxBets(event.target.value)} />
        <Input label="Enabled game IDs" hint="Comma-separated, e.g. crash,coinflip" value={games} onChange={(event) => setGames(event.target.value)} />
        {error ? <div className="sm:col-span-2"><ErrorNote>{error}</ErrorNote></div> : null}
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button type="submit" variant="gold" loading={busy}>Create and link</Button></div>
      </form>
    </Panel>
  );
}

function OperatorDetail({
  operator,
  hostCode,
  busy,
  onUpdate,
  onProbe,
  onStatus,
  onRotate,
  onRetire,
  onDelete,
}: {
  operator: GamesProviderOperator;
  hostCode: string;
  busy: boolean;
  onUpdate: (patch: GamesProviderOperatorPatch) => void;
  onProbe: () => void;
  onStatus: (status: GamesProviderOperator['status']) => void;
  onRotate: () => void;
  onRetire: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(operator);
  useEffect(() => setDraft(operator), [operator]);
  const update = () => onUpdate({
    name: draft.name,
    localeDefault: draft.localeDefault,
    limits: draft.limits,
    enabledGames: draft.enabledGames,
    theme: draft.theme,
    maintenance: draft.maintenance,
    botConfig: draft.botConfig ?? undefined,
  });
  return (
    <div className="space-y-4">
      <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div><p className="font-display text-lg font-bold">{operator.name}</p><p className="font-mono text-xs text-muted">{operator.code} · {hostCode}</p></div>
        <div className="flex flex-wrap items-center gap-2"><OperatorStatus status={operator.status}/><Button size="sm" variant="outline" loading={busy} onClick={onProbe}>Run probe</Button>{operator.status !== 'ACTIVE' ? <Button size="sm" variant="gold" disabled={busy || operator.probeOkAt === null} onClick={() => onStatus('ACTIVE')}>Activate</Button> : <Button size="sm" variant="danger" disabled={busy} onClick={() => onStatus('SUSPENDED')}>Suspend</Button>}</div>
      </Panel>
      <Panel className="p-4">
        <h3 className="mb-3 text-sm font-bold">Operator configuration</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <div className="rounded-lg border border-line px-3 py-2 text-xs sm:col-span-2"><p className="font-semibold">Managed connection addresses</p><p className="mt-1 break-all font-mono text-muted">Bingo API callback: {operator.callbackUrl}</p><p className="mt-1 break-all text-muted">Game origins: {operator.allowedOrigins.join(', ')}</p><p className="mt-1 text-muted">These are generated from the Bingo API host and its configured CORS origins.</p></div>
          <Input label="Enabled game IDs (comma-separated)" value={draft.enabledGames.join(', ')} onChange={(event) => setDraft({ ...draft, enabledGames: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} />
          <Input label="Minimum stake (minor units)" type="number" value={draft.limits.minStake} onChange={(event) => setDraft({ ...draft, limits: { ...draft.limits, minStake: event.target.value } })} />
          <Input label="Maximum stake (minor units)" type="number" value={draft.limits.maxStake} onChange={(event) => setDraft({ ...draft, limits: { ...draft.limits, maxStake: event.target.value } })} />
          <Input label="Maximum win (minor units)" type="number" value={draft.limits.maxWin} onChange={(event) => setDraft({ ...draft, limits: { ...draft.limits, maxWin: event.target.value } })} />
          <Input label="Max bets per round" type="number" value={draft.limits.maxBetsPerRound} onChange={(event) => setDraft({ ...draft, limits: { ...draft.limits, maxBetsPerRound: Number(event.target.value) } })} />
          <Select label="Default locale" value={draft.localeDefault} onChange={(event) => setDraft({ ...draft, localeDefault: event.target.value as 'en' | 'am' })}><option value="en">English</option><option value="am">Amharic</option></Select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.maintenance} onChange={(event) => setDraft({ ...draft, maintenance: event.target.checked })}/> Maintenance mode</label>
        </div>
        <div className="mt-4 flex flex-wrap justify-between gap-2"><div className="flex gap-2"><Button size="sm" variant="gold" loading={busy} onClick={update}>Save changes</Button><Button size="sm" variant="outline" loading={busy} onClick={() => onStatus('SUSPENDED')}>Suspend</Button></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || !operator.hasSecret} onClick={() => {
          if (window.confirm('Rotate the callback secret? The new secret will be synced to Bingo automatically; keep the overlap until a new probe succeeds.')) onRotate();
        }}>Rotate secret · v{operator.secretVersion ?? '—'}</Button>{operator.hasPreviousSecret ? <Button size="sm" variant="ghost" disabled={busy} onClick={onRetire}>Retire previous secret</Button> : null}<Button size="sm" variant="danger" disabled={busy || operator.status !== 'SUSPENDED'} onClick={onDelete}>Delete operator</Button></div></div>
        <p className="mt-3 text-[11px] text-muted">Last successful probe: {operator.probeOkAt ? new Date(operator.probeOkAt).toLocaleString() : 'not yet run'}. Secret values are never displayed.</p>
      </Panel>
    </div>
  );
}

function RuntimeSettingsForm({
  settings,
  busy,
  onSave,
}: {
  settings: GamesProviderRuntimeSettings;
  busy: boolean;
  onSave: (settings: Pick<GamesProviderRuntimeSettings, 'botConfig' | 'enabledGames'>) => void;
}) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const patchBot = (patch: Partial<NonNullable<GamesProviderRuntimeSettings['botConfig']>>) => setDraft({ ...draft, botConfig: { ...draft.botConfig, ...patch } });
  return (
    <Panel className="space-y-4 p-4">
      <div><h2 className="font-display text-lg font-bold">Provider runtime settings</h2><p className="text-xs text-muted">Owner operator: {settings.operatorCode}. Bot amounts are minor units; bots are always disclosed as simulations.</p></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.botConfig.enabled} onChange={(event) => patchBot({ enabled: event.target.checked })}/> Enable simulation bots</label>
        <Input label="Bot count" type="number" min="0" max="100" value={draft.botConfig.count} onChange={(event) => patchBot({ count: Number(event.target.value) })}/>
        <Input label="Bot minimum stake (minor units)" type="number" min="1" value={draft.botConfig.stakeMin} onChange={(event) => patchBot({ stakeMin: event.target.value })}/>
        <Input label="Bot maximum stake (minor units)" type="number" min="1" value={draft.botConfig.stakeMax} onChange={(event) => patchBot({ stakeMax: event.target.value })}/>
        <Input label="Round payout cap (minor units)" type="number" min="0" value={draft.botConfig.roundPayoutCap} onChange={(event) => patchBot({ roundPayoutCap: event.target.value })}/>
        <Input label="Daily payout cap (minor units)" type="number" min="0" value={draft.botConfig.dayPayoutCap} onChange={(event) => patchBot({ dayPayoutCap: event.target.value })}/>
        {(['crash', 'coinflip'] as const).map((game) => <label key={game} className="flex items-center gap-2 text-sm capitalize"><input type="checkbox" checked={draft.enabledGames.includes(game)} onChange={(event) => setDraft({ ...draft, enabledGames: event.target.checked ? [...draft.enabledGames, game] : draft.enabledGames.filter((item) => item !== game) })}/> Enable {game}</label>)}
      </div>
      <div><Button variant="gold" loading={busy} onClick={() => onSave({ botConfig: { ...draft.botConfig, disclose: true }, enabledGames: draft.enabledGames })}>Save runtime settings</Button></div>
      <p className="text-[11px] text-muted">Bot settings are display-only and do not send wallet bets or payouts.</p>
    </Panel>
  );
}
