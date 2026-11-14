'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { fetchCampaigns } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { Campaign } from '@/lib/types';
import { useSession } from './session';
import { Button } from './ui';

const DISMISS_PREFIX = 'bingo.campaign.dismiss.';
const REFRESH_MS = 5 * 60 * 1_000;

function dismissedUntil(id: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    return Number(window.localStorage.getItem(`${DISMISS_PREFIX}${id}`) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function dismiss(id: string, hours: number): void {
  if (typeof window === 'undefined') return;
  try {
    if (hours > 0) {
      window.localStorage.setItem(
        `${DISMISS_PREFIX}${id}`,
        String(Date.now() + hours * 3_600_000),
      );
    }
  } catch {
    // Storage is optional; the in-memory hide below still works.
  }
}

interface CampaignsValue {
  campaigns: Campaign[];
  hide: (id: string) => void;
  reload: () => void;
}

const CampaignsContext = createContext<CampaignsValue>({
  campaigns: [],
  hide: () => undefined,
  reload: () => undefined,
});

export function CampaignsProvider({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const { lang } = useI18n();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [hidden, setHidden] = useState<Record<string, true>>({});
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (status !== 'authed') {
      setCampaigns([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      void fetchCampaigns(lang)
        .then((next) => {
          if (!cancelled) setCampaigns(next);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [status, lang, generation]);

  const hide = useCallback((id: string) => {
    setHidden((current) => ({ ...current, [id]: true }));
  }, []);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  const visible = useMemo(
    () => campaigns.filter((campaign) => !hidden[campaign.id] && dismissedUntil(campaign.id) < Date.now()),
    [campaigns, hidden],
  );

  const value = useMemo<CampaignsValue>(
    () => ({ campaigns: visible, hide, reload }),
    [visible, hide, reload],
  );

  return <CampaignsContext.Provider value={value}>{children}</CampaignsContext.Provider>;
}

export function useCampaigns(): CampaignsValue {
  return useContext(CampaignsContext);
}

function CampaignCta({ campaign }: { campaign: Campaign }) {
  if (!campaign.linkUrl) return null;
  const label = campaign.linkLabel || campaign.linkUrl;
  if (campaign.linkUrl.startsWith('/')) {
    return (
      <Link
        href={campaign.linkUrl}
        className="rounded-lg bg-mint px-3 py-1.5 text-xs font-bold text-[#04120c] transition hover:opacity-90"
      >
        {label}
      </Link>
    );
  }
  return (
    <a
      href={campaign.linkUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="rounded-lg bg-mint px-3 py-1.5 text-xs font-bold text-[#04120c] transition hover:opacity-90"
    >
      {label}
    </a>
  );
}

/** Inline announcements shown above page content. */
export function CampaignBanners() {
  const { campaigns, hide } = useCampaigns();
  const banners = campaigns.filter((campaign) => campaign.kind === 'BANNER');
  if (banners.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      {banners.map((campaign) => (
        <article
          key={campaign.id}
          className="relative flex items-start gap-3 overflow-hidden rounded-2xl border border-gold/30 bg-gradient-to-r from-gold/15 via-panel/90 to-panel/90 px-4 py-3"
        >
          <span className="mt-0.5 h-8 w-1 shrink-0 rounded-full bg-gold" aria-hidden />
          {campaign.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={campaign.imageUrl}
              alt=""
              className="hidden h-12 w-12 shrink-0 rounded-lg object-cover sm:block"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold">
              Announcement
            </p>
            <h2 className="font-display text-sm font-bold leading-tight">{campaign.title}</h2>
            <p className="mt-0.5 text-xs text-muted">{campaign.body}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {campaign.dismissHours > 0 ? (
              <button
                type="button"
                onClick={() => {
                  dismiss(campaign.id, campaign.dismissHours);
                  hide(campaign.id);
                }}
                className="text-muted transition hover:text-text"
                aria-label="Dismiss announcement"
              >
                ✕
              </button>
            ) : null}
            <CampaignCta campaign={campaign} />
          </div>
        </article>
      ))}
    </div>
  );
}

/** Highest-priority popup campaign, dismissed per campaign for its configured window. */
export function CampaignPopup() {
  const { campaigns, hide } = useCampaigns();
  const popup = campaigns.find((campaign) => campaign.kind === 'POPUP');
  const popupId = popup?.id ?? null;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(Boolean(popupId));
  }, [popupId]);

  if (!popup || !open) return null;

  const close = () => {
    dismiss(popup.id, popup.dismissHours);
    hide(popup.id);
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-6">
      <div className="w-full max-w-md overflow-hidden rounded-t-3xl border border-line bg-panel shadow-2xl sm:rounded-3xl">
        {popup.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={popup.imageUrl} alt="" className="h-40 w-full object-cover" />
        ) : (
          <div className="h-1.5 w-full bg-gradient-to-r from-gold via-mint to-gold" />
        )}
        <div className="p-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-mint">
            Bingo 251
          </p>
          <h2 className="mt-1 font-display text-xl font-black tracking-tight">{popup.title}</h2>
          <p className="mt-2 text-sm text-muted">{popup.body}</p>
          <div className="mt-5 flex items-center justify-between gap-3">
            <Button variant="ghost" size="sm" onClick={close}>
              Maybe later
            </Button>
            <div onClick={close}>
              <CampaignCta campaign={popup} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
