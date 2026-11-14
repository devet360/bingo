'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { changePassword, ApiError } from '@/lib/api';
import { formatStake, initials } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { getRuntimeConfig } from '@/lib/runtime-config';
import { getTelegramWebApp } from '@/lib/telegram';
import { LoginPanel } from './login';
import { useSession } from './session';
import { Button, cn, ErrorNote, Input, Panel, Spinner } from './ui';

const NAV = [
  {
    href: '/',
    labelKey: 'shell.nav.lobby',
    role: 'player',
    icon: <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" />,
  },
  {
    href: '/wallet',
    labelKey: 'shell.nav.wallet',
    role: 'player',
    icon: (
      <path d="M4 7a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v2h1a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm3 3h11v2H7a1 1 0 0 1 0-2z" />
    ),
  },
  {
    href: '/agent',
    labelKey: 'shell.nav.agent',
    role: 'agent',
    icon: <path d="M12 3 4 7v5c0 5 3.4 8.2 8 9 4.6-.8 8-4 8-9V7zm0 5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm-4 9c.6-1.8 2.2-3 4-3s3.4 1.2 4 3z" />,
  },
  {
    href: '/support',
    labelKey: 'shell.nav.support',
    role: 'support',
    icon: (
      <path d="M12 3a8 8 0 0 0-8 8v4a3 3 0 0 0 3 3h1v-7H6v-.2A6 6 0 0 1 18 11v.8h-2V18h1.5a2.5 2.5 0 0 1-2.5 2.5h-2.2a1.5 1.5 0 1 0 0 1.5H15a4 4 0 0 0 3.7-2.6A3 3 0 0 0 21 16v-5a8 8 0 0 0-8-8z" />
    ),
  },
  {
    href: '/admin',
    labelKey: 'shell.nav.admin',
    role: 'admin',
    icon: (
      <path d="M12 2 4 5v6c0 5.2 3.4 9.4 8 11 4.6-1.6 8-5.8 8-11V5zm0 5.5 4 1.5v2c0 3.1-1.8 5.9-4 7-2.2-1.1-4-3.9-4-7V9z" />
    ),
  },
] as const;

function Logo({ href }: { href: string }) {
  return (
    <Link href={href} className="flex items-center gap-2">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-gold to-mint text-lg font-black text-ink">
        B
      </span>
      <span className="font-display text-lg font-bold tracking-tight">
        Bingo<span className="text-gold">Hall</span>
      </span>
    </Link>
  );
}

function PasswordGate() {
  const { refresh, logout } = useSession();
  const { t } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-10 w-full max-w-md">
      <Panel className="p-5">
        <h1 className="font-display text-xl font-bold">{t('staff.mustChangePassword')}</h1>
        <p className="mt-1 text-xs text-muted">{t('login.staffBlurb')}</p>
        <form className="mt-4 space-y-3" onSubmit={submit}>
          <Input
            label={t('staff.currentPassword')}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <Input
            label={t('staff.newPassword')}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <Input
            label={t('staff.newPassword')}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
          <ErrorNote>{error}</ErrorNote>
          <Button type="submit" className="w-full" loading={busy}>
            {t('staff.updatePassword')}
          </Button>
          <Button type="button" variant="ghost" className="w-full" onClick={() => void logout()}>
            {t('shell.signOut')}
          </Button>
        </form>
      </Panel>
    </div>
  );
}

function VerifyPhoneBanner() {
  const { t } = useI18n();
  const botUsername = getRuntimeConfig().botUsername;
  const open = () => {
    const url = `https://t.me/${botUsername}?start=verify`;
    const app = getTelegramWebApp();
    if (app?.openTelegramLink) app.openTelegramLink(url);
    else window.open(url, '_blank', 'noreferrer');
  };
  return (
    <div className="mb-3 flex flex-col gap-2 rounded-2xl border border-gold/30 bg-gold/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-gold">
        Verify your phone number in the Telegram bot to buy cards and request payouts.
      </p>
      {botUsername ? (
        <Button size="sm" variant="gold" onClick={open}>
          {t('login.openTelegram')}
        </Button>
      ) : null}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { status, user, wallet, agent, isTelegram, logout } = useSession();
  const { t, lang, setLang } = useI18n();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  if (status === 'loading') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 text-muted">
        <Spinner className="h-7 w-7 text-mint" />
        <p className="text-xs uppercase tracking-widest">{t('shell.opening')}</p>
      </div>
    );
  }

  if (status === 'anon') {
    return (
      <div className="min-h-dvh px-4 pb-10">
        <LoginPanel />
      </div>
    );
  }

  if (user?.mustChangePassword) {
    return (
      <div className="min-h-dvh px-4 pb-10">
        <PasswordGate />
      </div>
    );
  }

  const role = user?.role ?? 'PLAYER';
  const isAdmin = role === 'SUPER_ADMIN';
  const isSupport = role === 'SUPPORT' || isAdmin;
  const isStaff = isSupport || role === 'AGENT';
  const canPlay = role === 'PLAYER' || role === 'AGENT';

  const nav = NAV.filter((item) => {
    if (item.role === 'player') return canPlay;
    if (item.role === 'agent') return Boolean(agent);
    if (item.role === 'support') return isSupport;
    if (item.role === 'admin') return isAdmin;
    return false;
  });

  const wide = pathname.startsWith('/admin') || pathname.startsWith('/support');
  const homeHref = isAdmin ? '/admin' : isSupport ? '/support' : agent ? '/agent' : '/';

  return (
    <div className="min-h-dvh pb-24">
      <header className="sticky top-0 z-30 border-b border-line/60 bg-ink/85 backdrop-blur">
        <div
          className={cn(
            'mx-auto flex h-14 w-full items-center justify-between gap-3 px-4',
            wide ? 'max-w-6xl' : 'max-w-3xl',
          )}
        >
          <Logo href={homeHref} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLang(lang === 'en' ? 'am' : 'en')}
              className="rounded-full border border-line px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-muted hover:text-text"
              aria-label={t('common.language')}
            >
              {lang === 'en' ? 'EN' : 'አማ'}
            </button>
            {canPlay && wallet ? (
              <Link
                href="/wallet"
                className="flex items-center gap-1.5 rounded-full border border-gold/25 bg-gold/10 px-3 py-1.5 text-xs font-semibold text-gold"
              >
                <span className="text-[10px] uppercase tracking-wide opacity-70">
                  {t('common.credits')}
                </span>
                {formatStake(wallet.available)}
              </Link>
            ) : null}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-raised text-xs font-bold text-text"
                aria-label={t('shell.account')}
              >
                {initials(user?.displayName)}
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-11 z-40 w-56 rounded-xl border border-line bg-panel p-3 shadow-xl">
                  <p className="truncate text-sm font-semibold">{user?.displayName}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {user?.role}
                    {agent ? ` · ${agent.agentCode}` : ''}
                    {isTelegram ? ' · Telegram' : ''}
                  </p>
                  <div className="my-2 h-px bg-line" />
                  {canPlay ? (
                    <Link
                      href="/wallet"
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-raised hover:text-text"
                    >
                      {t('shell.walletLink')}
                    </Link>
                  ) : null}
                  {isStaff ? (
                    <Link
                      href={isAdmin ? '/admin' : '/support'}
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-raised hover:text-text"
                    >
                      {isAdmin ? t('staff.adminTitle') : t('staff.supportTitle')}
                    </Link>
                  ) : null}
                  <div className="my-2 flex gap-1">
                    {(['en', 'am'] as const).map((code) => (
                      <button
                        key={code}
                        type="button"
                        onClick={() => setLang(code)}
                        className={cn(
                          'flex-1 rounded-lg px-2 py-1 text-[10px] font-bold uppercase',
                          lang === code ? 'bg-raised text-text' : 'text-muted',
                        )}
                      >
                        {code === 'en' ? 'English' : 'አማርኛ'}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => void logout()}
                    className="block w-full rounded-lg px-2 py-1.5 text-left text-xs text-danger hover:bg-danger/10"
                  >
                    {t('shell.signOut')}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <main
        className={cn(
          'mx-auto w-full px-4 pt-4',
          wide ? 'max-w-6xl' : 'max-w-3xl',
        )}
      >
        {canPlay && user && !user.phoneVerified ? <VerifyPhoneBanner /> : null}
        {children}
      </main>

      {nav.length > 0 ? (
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line/70 bg-ink/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-stretch">
            {nav.map((item) => {
              const active =
                item.href === '/'
                  ? pathname === '/'
                  : item.href === '/admin'
                    ? pathname.startsWith('/admin')
                    : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-semibold uppercase tracking-wide transition',
                    active ? 'text-mint' : 'text-muted hover:text-text',
                  )}
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
                    {item.icon}
                  </svg>
                  {t(item.labelKey)}
                </Link>
              );
            })}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
