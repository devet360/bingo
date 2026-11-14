'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  createCampaign,
  deleteCampaign,
  fetchAdminCampaigns,
  updateCampaign,
} from '@/lib/api';
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
import { formatDateTime } from '@/lib/format';
import type { Campaign, CampaignAudience, CampaignKind } from '@/lib/types';
import { LoadingBlock, Row, SectionTitle } from './shared';

interface Draft {
  kind: CampaignKind;
  audience: CampaignAudience;
  locale: 'en' | 'am';
  title: string;
  body: string;
  imageUrl: string;
  linkUrl: string;
  linkLabel: string;
  enabled: boolean;
  priority: string;
  dismissHours: string;
  startsAt: string;
  endsAt: string;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function emptyDraft(): Draft {
  return {
    kind: 'BANNER',
    audience: 'ALL',
    locale: 'en',
    title: '',
    body: '',
    imageUrl: '',
    linkUrl: '',
    linkLabel: '',
    enabled: true,
    priority: '0',
    dismissHours: '24',
    startsAt: '',
    endsAt: '',
  };
}

function toDraft(campaign: Campaign): Draft {
  return {
    kind: campaign.kind,
    audience: campaign.audience,
    locale: campaign.locale === 'am' ? 'am' : 'en',
    title: campaign.title,
    body: campaign.body,
    imageUrl: campaign.imageUrl ?? '',
    linkUrl: campaign.linkUrl ?? '',
    linkLabel: campaign.linkLabel ?? '',
    enabled: campaign.enabled,
    priority: String(campaign.priority),
    dismissHours: String(campaign.dismissHours),
    startsAt: toLocalInput(campaign.startsAt),
    endsAt: toLocalInput(campaign.endsAt),
  };
}

export function MarketingTab() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setCampaigns(await fetchAdminCampaigns());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load campaigns.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (campaign: Campaign) => {
    try {
      await updateCampaign(campaign.id, { enabled: !campaign.enabled });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update the campaign.');
    }
  };

  const remove = async (campaign: Campaign) => {
    if (!window.confirm(`Delete "${campaign.title}"?`)) return;
    try {
      await deleteCampaign(campaign.id);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete the campaign.');
    }
  };

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line/60 px-4 py-3">
        <div>
          <SectionTitle>Announcements &amp; popups</SectionTitle>
          <p className="mt-1 max-w-xl text-[11px] text-muted">
            Banners sit above every page; popups open once and stay dismissed for the configured
            window. Target players, agents or everyone, in English or Amharic.
          </p>
        </div>
        <Button size="sm" variant="gold" onClick={() => setCreating(true)}>
          New campaign
        </Button>
      </div>

      {error ? (
        <div className="px-4 pt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}

      {campaigns === null ? (
        <LoadingBlock />
      ) : campaigns.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No campaigns yet" body="Create a banner for the lobby or a launch popup." />
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {campaigns.map((campaign) => (
            <li key={campaign.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Pill tone={campaign.kind === 'POPUP' ? 'gold' : 'blue'}>{campaign.kind}</Pill>
                    <Pill tone={campaign.enabled ? 'mint' : 'neutral'}>
                      {campaign.enabled ? 'live' : 'off'}
                    </Pill>
                    <Pill tone="neutral">{campaign.audience}</Pill>
                    <Pill tone="neutral">{campaign.locale.toUpperCase()}</Pill>
                    <Pill tone="neutral">p{campaign.priority}</Pill>
                  </div>
                  <p className="mt-1 text-sm font-semibold">{campaign.title}</p>
                  <p className="line-clamp-2 text-[11px] text-muted">{campaign.body}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-wider text-muted">
                    {campaign.startsAt ? formatDateTime(campaign.startsAt) : 'always'} →{' '}
                    {campaign.endsAt ? formatDateTime(campaign.endsAt) : 'until disabled'} · dismiss{' '}
                    {campaign.dismissHours}h
                    {campaign.linkUrl ? ` · ${campaign.linkUrl}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => setEditing(campaign)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void toggle(campaign)}>
                    {campaign.enabled ? 'Pause' : 'Publish'}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void remove(campaign)}>
                    Delete
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CampaignSheet
        open={creating || editing !== null}
        campaign={editing}
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
    </Panel>
  );
}

function CampaignSheet({
  open,
  campaign,
  onClose,
  onSaved,
}: {
  open: boolean;
  campaign: Campaign | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(campaign ? toDraft(campaign) : emptyDraft());
    setError(null);
  }, [open, campaign]);

  if (!open) return null;
  const patch = (next: Partial<Draft>) => setDraft({ ...draft, ...next });

  const save = async () => {
    setError(null);
    if (!draft.title.trim() || !draft.body.trim()) {
      setError('A title and body are required.');
      return;
    }
    const priority = Number(draft.priority || '0');
    const dismissHours = Number(draft.dismissHours || '0');
    if (!Number.isInteger(priority) || priority < 0 || !Number.isInteger(dismissHours) || dismissHours < 0) {
      setError('Priority and dismiss hours must be whole numbers.');
      return;
    }
    const body = {
      kind: draft.kind,
      audience: draft.audience,
      locale: draft.locale,
      title: draft.title.trim(),
      body: draft.body.trim(),
      imageUrl: draft.imageUrl.trim() || null,
      linkUrl: draft.linkUrl.trim() || null,
      linkLabel: draft.linkLabel.trim() || null,
      enabled: draft.enabled,
      priority,
      dismissHours,
      startsAt: draft.startsAt ? new Date(draft.startsAt).toISOString() : null,
      endsAt: draft.endsAt ? new Date(draft.endsAt).toISOString() : null,
    };
    setBusy(true);
    try {
      if (campaign) await updateCampaign(campaign.id, body);
      else await createCampaign(body);
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the campaign.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open title={campaign ? 'Edit campaign' : 'New campaign'} onClose={onClose}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Type"
            value={draft.kind}
            onChange={(event) => patch({ kind: event.target.value as CampaignKind })}
          >
            <option value="BANNER">Banner</option>
            <option value="POPUP">Popup</option>
          </Select>
          <Select
            label="Audience"
            value={draft.audience}
            onChange={(event) => patch({ audience: event.target.value as CampaignAudience })}
          >
            <option value="ALL">Everyone</option>
            <option value="PLAYERS">Players</option>
            <option value="AGENTS">Agents</option>
          </Select>
          <Select
            label="Language"
            value={draft.locale}
            onChange={(event) => patch({ locale: event.target.value as 'en' | 'am' })}
          >
            <option value="en">English</option>
            <option value="am">አማርኛ</option>
          </Select>
          <Select
            label="Enabled"
            value={draft.enabled ? 'ON' : 'OFF'}
            onChange={(event) => patch({ enabled: event.target.value === 'ON' })}
          >
            <option value="ON">Live</option>
            <option value="OFF">Hidden</option>
          </Select>
        </div>
        <Input label="Title" value={draft.title} onChange={(event) => patch({ title: event.target.value })} />
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
            Body
          </span>
          <textarea
            className="min-h-[90px] w-full rounded-xl border border-line bg-ink/60 px-3 py-2 text-sm text-text focus:border-mint/60 focus:outline-none"
            value={draft.body}
            onChange={(event) => patch({ body: event.target.value })}
          />
        </label>
        <Input
          label="Image URL"
          value={draft.imageUrl}
          onChange={(event) => patch({ imageUrl: event.target.value })}
          placeholder="https://…"
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Link URL"
            value={draft.linkUrl}
            onChange={(event) => patch({ linkUrl: event.target.value })}
            hint="In-app path like /bonuses or an https URL."
          />
          <Input
            label="Link label"
            value={draft.linkLabel}
            onChange={(event) => patch({ linkLabel: event.target.value })}
          />
          <Input
            label="Priority"
            inputMode="numeric"
            value={draft.priority}
            onChange={(event) => patch({ priority: event.target.value })}
            hint="Higher shows first."
          />
          <Input
            label="Dismiss (hours)"
            inputMode="numeric"
            value={draft.dismissHours}
            onChange={(event) => patch({ dismissHours: event.target.value })}
          />
          <Input
            label="Starts at"
            type="datetime-local"
            value={draft.startsAt}
            onChange={(event) => patch({ startsAt: event.target.value })}
          />
          <Input
            label="Ends at"
            type="datetime-local"
            value={draft.endsAt}
            onChange={(event) => patch({ endsAt: event.target.value })}
          />
        </div>
        <div className="rounded-xl border border-line bg-raised/40 px-3 py-2">
          <Row label="Window">
            {draft.startsAt || draft.endsAt ? 'scheduled' : 'immediately, until disabled'}
          </Row>
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button className="w-full" loading={busy} onClick={() => void save()}>
          {campaign ? 'Save campaign' : 'Create campaign'}
        </Button>
      </div>
    </Sheet>
  );
}
