'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ApiError, fetchGameSession } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { haptic, getTelegramWebApp } from '@/lib/telegram';
import { Button, Spinner } from '@/components/ui';

type Screen =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; origin: string }
  | { kind: 'ended' }
  | { kind: 'unconfigured' }
  | { kind: 'failed' };

export default function PlayGamePage() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const { t, lang } = useI18n();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });

  const exit = useCallback(() => router.replace('/games'), [router]);

  useEffect(() => {
    let cancelled = false;
    const settle = (next: Screen) => {
      if (!cancelled) setScreen(next);
    };

    fetchGameSession(params.sessionId)
      .then((session) => {
        if (session.status !== 'OPEN') return settle({ kind: 'ended' });
        const raw = typeof session.launchUrl === 'string' ? session.launchUrl.trim() : '';
        if (!raw) return settle({ kind: 'unconfigured' });
        try {
          const url = new URL(raw);
          // `javascript:`/`data:` URLs parse but have the opaque origin "null",
          // which postMessage rejects as a targetOrigin — a game without an
          // absolute http(s) launch URL cannot be embedded at all.
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return settle({ kind: 'unconfigured' });
          }
          settle({ kind: 'ready', url: raw, origin: url.origin });
        } catch {
          settle({ kind: 'unconfigured' });
        }
      })
      .catch((error: unknown) => {
        // Only a missing or gone session ends the round; a transport or auth
        // failure is a different problem and must not claim the game ended.
        const dead =
          error instanceof ApiError &&
          (error.status === 404 || error.status === 410 || error.code === 'SESSION_EXPIRED');
        settle(dead ? { kind: 'ended' } : { kind: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [params.sessionId]);

  const providerOrigin = screen.kind === 'ready' ? screen.origin : null;
  const launchUrl = screen.kind === 'ready' ? screen.url : null;

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

  if (screen.kind === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="h-6 w-6 text-mint" />
      </div>
    );
  }

  if (screen.kind === 'ready') {
    return (
      <iframe
        ref={frameRef}
        src={screen.url}
        title="Crash"
        allow="fullscreen"
        className="fixed inset-0 h-dvh w-full border-0 bg-ink"
      />
    );
  }

  const title =
    screen.kind === 'ended'
      ? t('games.sessionEnded')
      : screen.kind === 'unconfigured'
        ? t('games.noLaunchUrl')
        : t('games.launchError');

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="font-display text-lg font-bold">{title}</p>
      {screen.kind === 'ended' ? <p className="text-sm text-muted">{t('games.sessionEndedBody')}</p> : null}
      <Button onClick={exit}>{t('games.returnToLobby')}</Button>
    </div>
  );
}
