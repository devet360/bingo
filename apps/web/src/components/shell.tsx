'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { changePassword, ApiError } from '@/lib/api';
import { formatStake, initials } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { getRuntimeConfig } from '@/lib/runtime-config';
import { haptic, hapticSelection, openExternalLink } from '@/lib/telegram';
import { useTelegramBackButton } from '@/lib/telegram-hooks';
import { useTheme } from '@/lib/theme';
import { CampaignBanners, CampaignPopup } from './campaigns';
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
    href: '/games',
    labelKey: 'shell.nav.games',
    role: 'player',
    icon: (
      <path d="M7 6h10a5 5 0 0 1 5 5v3a4 4 0 0 1-7.2 2.4L13.6 15h-3.2l-1.2 1.4A4 4 0 0 1 2 14v-3a5 5 0 0 1 5-5zm0 4a1 1 0 0 0-1 1v1H5v2h1v1h2v-1h1v-2H8v-1a1 1 0 0 0-1-1zm9.5 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm1.8-2.4a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" />
    ),
  },
  {
    href: '/bonuses',
    labelKey: 'shell.nav.rewards',
    role: 'player',
    icon: (
      <path d="M12 2 9.2 8.6 2 9.3l5.4 4.7L5.8 21 12 17.3 18.2 21l-1.6-7L22 9.3l-7.2-.7z" />
    ),
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

function Logo({ href, compact = false }: { href: string; compact?: boolean }) {
  return (
    <Link href={href} className="flex items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-gold via-[#f7d98a] to-gold text-[10px] font-black tracking-tight text-[#1a1204] shadow-glow ring-2 ring-mint/35">
        251
      </span>
      {compact ? null : (
        <span className="font-display text-lg font-bold tracking-tight">
          Bingo<span className="text-gold"> 251</span>
        </span>
      )}
    </Link>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => {
        hapticSelection();
        toggle();
      }}
      className="flex h-7 w-7 items-center justify-center rounded-full border border-line text-muted transition hover:text-text"
      aria-label={t('common.theme')}
      title={theme === 'dark' ? t('common.themeLight') : t('common.themeDark')}
    >
      {theme === 'dark' ? (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
          <path d="M12 4a8 8 0 1 0 8 8 6.5 6.5 0 0 1-8-8z" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      )}
    </button>
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
    haptic('tap');
    openExternalLink(`https://t.me/${botUsername}?start=verify`);
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
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  // Rooms and embedded provider games trade the app chrome for play space.
  // Telegram's native back button should return to the lobby instead of
  // leaving the Mini App.
  const immersive = pathname.startsWith('/room/') || pathname.startsWith('/games/play/');
  useTelegramBackButton(() => {
    haptic('tap');
    router.push(pathname.startsWith('/games/play/') ? '/games' : '/');
  }, immersive);

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

  // Game rooms and embedded provider games trade the app chrome for board
  // space; Telegram already draws its own title bar, so the in-app header
  // shrinks there too.
  const adminArea = pathname.startsWith('/admin');
  const wide = adminArea || pathname.startsWith('/support') || immersive;
  const widthClass = adminArea ? 'max-w-[1440px]' : wide ? 'max-w-6xl' : 'max-w-3xl';
  const chromeHeight = isTelegram ? 'h-11' : 'h-14';
  const homeHref = isAdmin ? '/admin' : isSupport ? '/support' : agent ? '/agent' : '/';

  return (
    <div
      className={cn('min-h-dvh', immersive ? 'pb-2' : adminArea ? 'pb-6' : 'pb-20')}
      style={{ minHeight: 'var(--tg-viewport-height, 100dvh)' }}
    >
      {immersive ? null : (
      <header className="sticky top-0 z-30 border-b border-line/60 bg-ink/85 backdrop-blur">
        <div
          className={cn(
            'mx-auto flex w-full items-center justify-between gap-3 px-4',
            chromeHeight,
            widthClass,
          )}
        >
          <Logo href={homeHref} compact={isTelegram} />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              type="button"
              onClick={() => {
                hapticSelection();
                setLang(lang === 'en' ? 'am' : 'en');
              }}
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
                {formatStake(wallet.available)}
                <span className="text-[10px] uppercase tracking-wide opacity-70">
                  {t('common.credits')}
                </span>
                {wallet.bonus !== '0' ? (
                  <span className="rounded-full bg-mint/15 px-1.5 text-[10px] text-mint">
                    +{formatStake(wallet.bonus)}
                  </span>
                ) : null}
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
                    <>
                      <Link
                        href="/wallet"
                        onClick={() => setMenuOpen(false)}
                        className="block rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-raised hover:text-text"
                      >
                        {t('shell.walletLink')}
                      </Link>
                      <Link
                        href="/bonuses"
                        onClick={() => setMenuOpen(false)}
                        className="block rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-raised hover:text-text"
                      >
                        {t('shell.rewardsLink')}
                      </Link>
                      <Link
                        href="/referrals"
                        onClick={() => setMenuOpen(false)}
                        className="block rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-raised hover:text-text"
                      >
                        {t('shell.referralsLink')}
                      </Link>
                    </>
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
                        onClick={() => {
                          hapticSelection();
                          setLang(code);
                        }}
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
      )}

      <main
        className={cn(
          'mx-auto w-full',
          immersive ? 'px-2 pt-2 pb-[env(safe-area-inset-bottom)]' : 'px-3 pt-3 sm:px-4',
          widthClass,
        )}
      >
        {canPlay && user && !user.phoneVerified ? <VerifyPhoneBanner /> : null}
        <CampaignBanners />
        {children}
      </main>

      <CampaignPopup />

      {nav.length > 0 && !immersive && !adminArea ? (
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
                  onClick={() => hapticSelection()}
                  className={cn(
                    'flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[9px] font-semibold uppercase tracking-wide transition',
                    active ? 'text-mint' : 'text-muted hover:text-text',
                  )}
                >
                  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="currentColor" aria-hidden>
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
