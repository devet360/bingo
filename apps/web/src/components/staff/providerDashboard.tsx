'use client';

import { useEffect, useState } from 'react';
import { ApiError, fetchGameProviders, issueGameProviderConsoleToken } from '@/lib/api';
import type { GameProvider } from '@/lib/types';
import { Button, EmptyState, ErrorNote, Panel, Select } from '@/components/ui';
import { LoadingBlock } from './shared';

export function ProviderDashboardTab({ preferredProviderCode }: { preferredProviderCode?: string }) {
  const [providers, setProviders] = useState<GameProvider[] | null>(null);
  const [selectedCode, setSelectedCode] = useState('');
  const [consoleUrl, setConsoleUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingConsole, setLoadingConsole] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchGameProviders()
      .then((allItems) => {
        if (cancelled) return;
        const items = allItems.filter((item) => item.apiBaseUrl !== null);
        setProviders(items);
        const preferred = items.find((item) => item.code === preferredProviderCode);
        setSelectedCode(preferred?.code ?? items[0]?.code ?? '');
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setProviders([]);
        setError(caught instanceof ApiError ? caught.message : 'Could not load game providers.');
      });
    return () => {
      cancelled = true;
    };
  }, [preferredProviderCode]);

  const selectedProvider = providers?.find((provider) => provider.code === selectedCode) ?? null;

  useEffect(() => {
    if (!selectedProvider) {
      setConsoleUrl(null);
      return;
    }

    let cancelled = false;
    let renewing = false;
    const renew = async () => {
      if (renewing) return;
      renewing = true;
      setLoadingConsole(true);
      setError(null);
      try {
        if (!selectedProvider.apiBaseUrl) {
          throw new Error('Configure this provider’s API base URL before opening its dashboard.');
        }
        const url = new URL(selectedProvider.apiBaseUrl);
        const localHttp = url.protocol === 'http:'
          && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
        if (url.protocol !== 'https:' && !localHttp) {
          throw new Error('Use HTTPS for provider dashboards outside local development.');
        }
        if (url.username || url.password) {
          throw new Error('Remove credentials from the provider API base URL.');
        }
        const issued = await issueGameProviderConsoleToken(selectedProvider.code, 'provider_viewer');
        if (cancelled) return;
        url.pathname = '/provider-console';
        url.search = '';
        url.hash = '';
        url.searchParams.set('token', issued.token);
        setConsoleUrl(url.toString());
      } catch (caught) {
        if (!cancelled) {
          setConsoleUrl(null);
          setError(caught instanceof ApiError ? caught.message : caught instanceof Error
            ? caught.message
            : 'Could not open the provider dashboard.');
        }
      } finally {
        renewing = false;
        if (!cancelled) setLoadingConsole(false);
      }
    };
    void renew();
    const timer = window.setInterval(() => void renew(), 8 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedProvider, refreshKey]);

  if (providers === null) return <Panel><LoadingBlock /></Panel>;
  if (providers.length === 0) {
    return (
      <EmptyState
        title="No provider dashboard is configured"
        body={error ?? 'Add a provider API base URL in the Games page before opening its dashboard.'}
      />
    );
  }

  return (
    <div className="space-y-4">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Panel className="space-y-3 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-[220px] flex-1">
            <Select
              label="Games provider"
              value={selectedCode}
              onChange={(event) => setSelectedCode(event.target.value)}
            >
              {providers.map((provider) => (
                <option key={provider.code} value={provider.code}>
                  {provider.name} ({provider.code})
                </option>
              ))}
            </Select>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={loadingConsole}
              onClick={() => setRefreshKey((key) => key + 1)}
            >
              {loadingConsole ? 'Refreshing…' : 'Refresh'}
            </Button>
            {consoleUrl ? (
              <a
                href={consoleUrl}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                className="inline-flex h-9 items-center rounded-xl border border-line px-3 text-xs font-semibold text-text hover:bg-raised"
              >
                Open separately
              </a>
            ) : null}
          </div>
        </div>
        <p className="text-xs text-muted">
          Provider-owned live operations view. Access uses a short-lived, read-only token scoped
          to this provider and renewed automatically while this page is open.
        </p>
      </Panel>

      {consoleUrl ? (
        <Panel className="overflow-hidden p-0">
          <iframe
            key={consoleUrl}
            src={consoleUrl}
            title={`${selectedProvider?.name ?? 'Games provider'} dashboard`}
            referrerPolicy="no-referrer"
            className="h-[calc(100dvh-290px)] min-h-[560px] w-full border-0 bg-ink"
          />
        </Panel>
      ) : (
        <EmptyState
          title={loadingConsole ? 'Connecting to the games provider…' : 'Dashboard unavailable'}
          body={loadingConsole ? 'Waiting for a scoped console token.' : 'Check the provider API URL and console-token configuration.'}
        />
      )}
    </div>
  );
}
