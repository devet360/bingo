'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  fetchAdminSettings,
  fetchDepositProvidersAdmin,
  updateDepositLimits,
  updateDepositProvider,
  type DepositProviderPatch,
} from '@/lib/api';
import { PAYMENT_METHODS, creditsToMinor, formatStake, minorToCreditsInput } from '@/lib/format';
import {
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Pill,
  Select,
  Sheet,
} from '@/components/ui';
import type { DepositProvider, PaymentMethod } from '@/lib/types';
import { LoadingBlock, SectionTitle } from './shared';

interface ProviderDraft {
  name: string;
  enabled: boolean;
  supported: boolean;
  clientSide: boolean;
  requiresPhone: boolean;
  opaqueReference: boolean;
  accountDigits: string;
  sortOrder: string;
  refHint: string;
  refPattern: string;
  endpoint: string;
  instructions: string;
  minAmount: string;
  maxAmount: string;
}

function toDraft(provider: DepositProvider): ProviderDraft {
  return {
    name: provider.name,
    enabled: provider.enabled,
    supported: provider.supported,
    clientSide: provider.clientSide,
    requiresPhone: provider.requiresPhone,
    opaqueReference: provider.opaqueReference,
    accountDigits: provider.accountDigits === null ? '' : String(provider.accountDigits),
    sortOrder: String(provider.sortOrder),
    refHint: provider.refHint ?? '',
    refPattern: provider.refPattern ?? '',
    endpoint: provider.endpoint ?? '',
    instructions: provider.instructions ?? '',
    minAmount: minorToCreditsInput(provider.minAmount),
    maxAmount: minorToCreditsInput(provider.maxAmount),
  };
}

function YesNo({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Select label={label} value={value ? 'ON' : 'OFF'} onChange={(event) => onChange(event.target.value === 'ON')}>
      <option value="ON">On</option>
      <option value="OFF">Off</option>
    </Select>
  );
}

function DepositLimitsCard() {
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchAdminSettings()
      .then((settings) => {
        setMin(minorToCreditsInput(settings.depositLimits.minAmount));
        setMax(minorToCreditsInput(settings.depositLimits.maxAmount));
        setLoaded(true);
      })
      .catch((caught) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not load the deposit limits.');
        setLoaded(true);
      });
  }, []);

  const save = async () => {
    setError(null);
    setSaved(false);
    const minMinor = creditsToMinor(min);
    if (minMinor === null) {
      setError('The minimum must look like 10 or 7.50.');
      return;
    }
    const maxMinor = max.trim() ? creditsToMinor(max) : null;
    if (max.trim() && maxMinor === null) {
      setError('The maximum must look like 100 or 99.50, or be left empty for no cap.');
      return;
    }
    if (maxMinor !== null && maxMinor < minMinor) {
      setError('The maximum cannot be less than the minimum.');
      return;
    }
    setBusy(true);
    try {
      await updateDepositLimits({ minAmount: minMinor, maxAmount: maxMinor });
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the deposit limits.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="mb-3 p-4">
      <SectionTitle>Deposit limits</SectionTitle>
      <p className="mt-1 text-[11px] text-muted">
        Platform-wide floor and ceiling in ETB. A rail&apos;s own limits in Configure narrow this window further.
      </p>
      {!loaded ? (
        <LoadingBlock />
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Minimum ETB"
              inputMode="decimal"
              value={min}
              onChange={(event) => setMin(event.target.value)}
              hint="Every deposit must be at least this much."
            />
            <Input
              label="Maximum ETB"
              inputMode="decimal"
              value={max}
              onChange={(event) => setMax(event.target.value)}
              hint="Leave empty for no platform cap."
            />
          </div>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {saved ? <p className="text-[11px] text-mint">Deposit limits saved.</p> : null}
          <Button size="sm" loading={busy} onClick={() => void save()}>
            Save limits
          </Button>
        </div>
      )}
    </Panel>
  );
}

export function ProvidersTab() {
  const [providers, setProviders] = useState<DepositProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<DepositProvider | null>(null);

  const load = useCallback(async () => {
    try {
      setProviders(await fetchDepositProvidersAdmin());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load deposit rails.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <DepositLimitsCard />
      <Panel className="overflow-hidden">
      <div className="border-b border-line/60 px-4 py-3">
        <SectionTitle>Deposit rails</SectionTitle>
        <p className="mt-1 text-[11px] text-muted">
          Enable the banks players may use. Only rails with a receipt parser can auto-verify; the parser
          and its host allowlist ship with the API and cannot be edited here.
        </p>
      </div>
      {error ? (
        <div className="p-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {providers === null ? (
        <LoadingBlock />
      ) : providers.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No providers configured" />
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {providers.map((provider) => (
            <li key={provider.code} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-semibold">{provider.name}</p>
                  <Pill tone={provider.enabled ? 'mint' : 'neutral'}>
                    {provider.enabled ? 'enabled' : 'off'}
                  </Pill>
                  {provider.supported ? null : <Pill tone="danger">manual only</Pill>}
                  {provider.clientSide ? <Pill tone="blue">client-side</Pill> : null}
                </div>
                <p className="mt-0.5 text-[11px] text-muted">
                  {provider.code} ·{' '}
                  {PAYMENT_METHODS.find((item) => item.value === provider.method)?.label} ·{' '}
                  {provider.parser ?? 'no parser'}
                  {provider.minAmount || provider.maxAmount
                    ? ` · ${formatStake(provider.minAmount ?? undefined)}–${
                        provider.maxAmount ? formatStake(provider.maxAmount) : '∞'
                      } ETB`
                    : ''}
                </p>
                {provider.refHint ? (
                  <p className="mt-1 text-[11px] text-muted">Reference: {provider.refHint}</p>
                ) : null}
              </div>
              <Button size="sm" variant="outline" onClick={() => setTarget(provider)}>
                Configure
              </Button>
            </li>
          ))}
        </ul>
      )}

      <SyncSheet
        provider={target}
        onClose={() => setTarget(null)}
        onSaved={() => {
          setTarget(null);
          void load();
        }}
      />
      </Panel>
    </div>
  );
}

function SyncSheet({
  provider,
  onClose,
  onSaved,
}: {
  provider: DepositProvider | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(provider ? toDraft(provider) : null);
    setError(null);
  }, [provider]);

  if (!provider || !draft) return null;

  const patch = (next: Partial<ProviderDraft>) => setDraft({ ...draft, ...next });

  const save = async () => {
    setError(null);
    if (!draft.name.trim()) {
      setError('A display name is required.');
      return;
    }
    let minMinor: number | null = null;
    let maxMinor: number | null = null;
    if (draft.minAmount.trim()) {
      minMinor = creditsToMinor(draft.minAmount);
      if (minMinor === null) {
        setError('The minimum must look like 10 or 7.50.');
        return;
      }
    }
    if (draft.maxAmount.trim()) {
      maxMinor = creditsToMinor(draft.maxAmount);
      if (maxMinor === null) {
        setError('The maximum must look like 100 or 99.50.');
        return;
      }
    }
    if (minMinor !== null && maxMinor !== null && minMinor > maxMinor) {
      setError('The minimum cannot be greater than the maximum.');
      return;
    }
    const digits = draft.accountDigits.trim() ? Number(draft.accountDigits) : null;
    if (digits !== null && (!Number.isInteger(digits) || digits < 1 || digits > 12)) {
      setError('Account digits must be a whole number between 1 and 12.');
      return;
    }
    const order = draft.sortOrder.trim() ? Number(draft.sortOrder) : 0;
    if (!Number.isInteger(order) || order < 0) {
      setError('Sort order must be zero or a positive whole number.');
      return;
    }

    const body: DepositProviderPatch = {
      name: draft.name.trim(),
      enabled: draft.enabled,
      supported: draft.supported,
      clientSide: draft.clientSide,
      requiresPhone: draft.requiresPhone,
      opaqueReference: draft.opaqueReference,
      accountDigits: digits,
      sortOrder: order,
      refHint: draft.refHint.trim() || null,
      refPattern: draft.refPattern.trim() || null,
      endpoint: draft.endpoint.trim() || null,
      instructions: draft.instructions.trim() || null,
      minAmount: minMinor,
      maxAmount: maxMinor,
    };
    setBusy(true);
    try {
      await updateDepositProvider(provider.code, body);
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the rail.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open title={`Configure ${provider.name}`} onClose={onClose}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        <Input label="Display name" value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <YesNo label="Enabled for players" value={draft.enabled} onChange={(enabled) => patch({ enabled })} />
          <YesNo
            label="Parser support"
            value={draft.supported}
            onChange={(supported) => patch({ supported })}
          />
          <YesNo
            label="Client-side fetch"
            value={draft.clientSide}
            onChange={(clientSide) => patch({ clientSide })}
          />
          <YesNo label="Needs payer phone" value={draft.requiresPhone} onChange={(requiresPhone) => patch({ requiresPhone })} />
          <YesNo
            label="Opaque reference"
            value={draft.opaqueReference}
            onChange={(opaqueReference) => patch({ opaqueReference })}
          />
          <Input
            label="Account digits"
            inputMode="numeric"
            value={draft.accountDigits}
            onChange={(event) => patch({ accountDigits: event.target.value })}
            hint="Last N digits of the receiving account."
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Min ETB"
            inputMode="decimal"
            value={draft.minAmount}
            onChange={(event) => patch({ minAmount: event.target.value })}
          />
          <Input
            label="Max ETB"
            inputMode="decimal"
            value={draft.maxAmount}
            onChange={(event) => patch({ maxAmount: event.target.value })}
          />
        </div>
        <Input
          label="Reference hint"
          value={draft.refHint}
          onChange={(event) => patch({ refHint: event.target.value })}
          hint="Shown under the reference field."
        />
        <Input
          label="Reference pattern"
          value={draft.refPattern}
          onChange={(event) => patch({ refPattern: event.target.value })}
          hint="Anchored regular expression, e.g. ^[A-Z0-9]{10}$."
        />
        <Input
          label="Endpoint template"
          value={draft.endpoint}
          onChange={(event) => patch({ endpoint: event.target.value })}
          hint="https URL with {ref}, {account} or {phone}. The host must be on the parser allowlist."
        />
        <Input
          label="Instructions"
          value={draft.instructions}
          onChange={(event) => patch({ instructions: event.target.value })}
          hint="Player-facing text on the deposit page."
        />
        <Input
          label="Sort order"
          inputMode="numeric"
          value={draft.sortOrder}
          onChange={(event) => patch({ sortOrder: event.target.value })}
        />
        <div className="rounded-xl border border-gold/25 bg-gold/5 p-3 text-[11px] text-muted">
          Parser: <span className="font-mono text-text">{provider.parser ?? 'none'}</span> · method:{' '}
          {PAYMENT_METHODS.find((item) => item.value === (provider.method as PaymentMethod))?.label}
          <p className="mt-1">
            Enabling a rail without a parser is rejected. Disable it first before marking the parser
            unsupported.
          </p>
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button className="w-full" loading={busy} onClick={() => void save()}>
          Save rail
        </Button>
      </div>
    </Sheet>
  );
}
