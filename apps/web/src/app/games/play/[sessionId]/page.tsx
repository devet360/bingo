'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { fetchGameSession } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { haptic, getTelegramWebApp } from '@/lib/telegram';
import { Button, Spinner } from '@/components/ui';

export default function PlayGamePage() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const { t, lang } = useI18n();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const [providerOrigin, setProviderOrigin] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const exit = useCallback(() => router.replace('/games'), [router]);

  useEffect(() => {
    let cancelled = false;
    fetchGameSession(params.sessionId)
      .then((session) => {
        if (cancelled) return;
        // The API returns closed rows too: only an OPEN session with a launch
        // URL can be entered, otherwise the spinner would never resolve.
        // The provider origin comes from that URL, so postMessage always targets
        // the host the session actually points at (no build-time env inlining).
        if (session.status === 'OPEN' && typeof session.launchUrl === 'string' && session.launchUrl) {
          try {
            const origin = new URL(session.launchUrl).origin;
            setLaunchUrl(session.launchUrl);
            setProviderOrigin(origin);
          } catch {
            setEnded(true);
          }
        } else {
          setEnded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setEnded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [params.sessionId]);

  const postTheme = useCallback(() => {
    if (!providerOrigin) return;
    const styles = getComputedStyle(document.documentElement);
    const rgb = (name: string) => `rgb(${styles.getPropertyValue(name).trim().split(/\s+/).join(',')})`;
    frameRef.current?.contentWindow?.postMessage(
      {
        type: 'bingo:theme',
        payload: {
          scheme: document.documentElement.dataset.theme ?? 'dark',
          bg: rgb('--c-ink'),
          panel: rgb('--c-panel'),
          text: rgb('--c-text'),
          hint: rgb('--c-muted'),
          button: rgb('--c-mint'),
          buttonText: rgb('--c-on-accent'),
          gold: rgb('--c-gold'),
          danger: rgb('--c-danger'),
          safeBottom: 0,
          viewportHeight: window.innerHeight,
        },
      },
      providerOrigin,
    );
  }, [providerOrigin]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!providerOrigin || event.origin !== providerOrigin) return;
      if (event.data?.type === 'bingo:haptic') {
        haptic(event.data.payload === 'success' ? 'success' : event.data.payload === 'error' ? 'error' : 'tap');
      }
      if (event.data?.type === 'bingo:exit') exit();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [exit, providerOrigin]);

  useEffect(() => {
    if (!launchUrl || !providerOrigin) return;
    postTheme();
    const frame = frameRef.current;
    const send = () => {
      postTheme();
      frame?.contentWindow?.postMessage({ type: 'bingo:locale', payload: lang }, providerOrigin);
    };
    frame?.addEventListener('load', send);
    const timer = window.setTimeout(send, 300);
    return () => {
      frame?.removeEventListener('load', send);
      window.clearTimeout(timer);
    };
  }, [launchUrl, lang, providerOrigin, postTheme]);

  useEffect(() => {
    const back = getTelegramWebApp()?.BackButton;
    back?.show?.();
    back?.onClick?.(exit);
    return () => back?.offClick?.(exit);
  }, [exit]);

  if (ended) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="font-display text-lg font-bold">{t('games.sessionEnded')}</p>
        <p className="text-sm text-muted">{t('games.sessionEndedBody')}</p>
        <Button onClick={exit}>{t('games.returnToLobby')}</Button>
      </div>
    );
  }

  if (!launchUrl) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="h-6 w-6 text-mint" />
      </div>
    );
  }

  return (
    <iframe
      ref={frameRef}
      src={launchUrl}
      title="Crash"
      allow="fullscreen"
      className="fixed inset-0 h-dvh w-full border-0 bg-ink"
    />
  );
}
