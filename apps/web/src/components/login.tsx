'use client';

import { useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api';
import { getRuntimeConfig } from '@/lib/runtime-config';
import { useI18n } from '@/lib/i18n';
import { useSession } from './session';
import { Button, ErrorNote, Input, Panel, Spinner } from './ui';

export function LoginPanel() {
  const { login, isTelegram, telegramError, retryTelegram, status } = useSession();
  const { t } = useI18n();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const botUsername = getRuntimeConfig().botUsername;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!identifier.trim() || !password) {
      setError(t('login.required'));
      return;
    }
    setBusy(true);
    try {
      await login(identifier, password);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-10 w-full max-w-md animate-rise space-y-4">
      <div className="text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-gold via-[#f7d98a] to-gold text-base font-black tracking-tight text-[#1a1204] shadow-glow ring-2 ring-mint/40">
          251
        </div>
        <h1 className="mt-4 font-display text-3xl font-bold tracking-tight">Bingo 251</h1>
        <p className="mt-1 text-sm text-muted">{t('login.playersBlurb')}</p>
      </div>

      {isTelegram ? (
        <Panel className="p-5">
          <div className="flex items-center gap-3">
            {status === 'loading' ? <Spinner className="h-5 w-5 text-mint" /> : null}
            <div>
              <p className="text-sm font-semibold">
                {telegramError ? t('login.retry') : t('login.verifying')}
              </p>
              <p className="mt-1 text-xs text-muted">{telegramError ?? t('login.retryHint')}</p>
            </div>
          </div>
          {telegramError ? (
            <Button
              className="mt-4 w-full"
              variant="outline"
              onClick={() => void retryTelegram()}
              loading={status === 'loading'}
            >
              {t('login.retry')}
            </Button>
          ) : null}
        </Panel>
      ) : (
        <>
          <Panel className="p-5">
            <h2 className="font-display text-lg font-bold">{t('login.playersTitle')}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">{t('login.playersBlurb')}</p>
            {botUsername ? (
              <a
                href={`https://t.me/${botUsername}?start=verify`}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-xl bg-mint px-4 text-sm font-semibold text-[#04120c] shadow-glow transition hover:bg-[#4ce9ae]"
              >
                {t('login.openTelegram')} → @{botUsername}
              </a>
            ) : (
              <p className="mt-3 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
                {t('login.telegramUnavailable')}
              </p>
            )}
          </Panel>

          <Panel className="p-5">
            <h2 className="font-display text-lg font-bold">{t('login.staffTitle')}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">{t('login.staffBlurb')}</p>
            <form className="mt-4 space-y-3" onSubmit={submit}>
              <Input
                label={t('login.identifier')}
                name="identifier"
                autoComplete="username"
                placeholder="you@bingo251.et or +2519…"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
              />
              <Input
                label={t('login.password')}
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <ErrorNote>{error}</ErrorNote>
              <Button type="submit" className="w-full" size="lg" loading={busy}>
                {t('login.submit')}
              </Button>
            </form>
          </Panel>
        </>
      )}

      <p className="px-2 text-center text-[11px] leading-relaxed text-muted">{t('login.footer')}</p>
    </div>
  );
}
