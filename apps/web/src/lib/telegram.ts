export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}

interface TelegramHaptic {
  impactOccurred?: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
  notificationOccurred?: (type: 'error' | 'success' | 'warning') => void;
  selectionChanged?: () => void;
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: TelegramUser; start_param?: string };
  colorScheme?: string;
  themeParams?: Record<string, string>;
  viewportStableHeight?: number;
  ready?: () => void;
  expand?: () => void;
  close?: () => void;
  disableVerticalSwipes?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  isExpanded?: boolean;
  isFullscreen?: boolean;
  requestFullscreen?: () => void;
  exitFullscreen?: () => void;
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
  platform?: string;
  version?: string;
  openTelegramLink?: (url: string) => void;
  HapticFeedback?: TelegramHaptic;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

export function getTelegramInitData(): string {
  return getTelegramWebApp()?.initData ?? '';
}

export function isTelegramClient(): boolean {
  const app = getTelegramWebApp();
  return Boolean(app && app.initData);
}

/**
 * Telegram injects initData after the SDK script loads, which can trail the
 * first React effect. Only wait when the page really looks like a Mini App so
 * ordinary browser visitors are not held on the splash screen.
 */
function looksLikeTelegramClient(): boolean {
  if (typeof window === 'undefined') return false;
  if (/Telegram/i.test(navigator.userAgent)) return true;
  if (/t\.me|telegram/i.test(document.referrer)) return true;
  const hash = window.location.hash;
  return hash.includes('tgWebAppData') || hash.includes('tgWebAppStartParam');
}

export async function resolveTelegramInitData(timeoutMs = 2_000): Promise<string> {
  const immediate = getTelegramInitData();
  if (immediate || !looksLikeTelegramClient()) return immediate;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = getTelegramInitData();
    if (next) return next;
  }
  return '';
}

/** Boots the Mini App chrome; safe to call outside Telegram. */
export function initTelegram(): void {
  const app = getTelegramWebApp();
  if (!app) return;
  try {
    app.ready?.();
    app.expand?.();
    app.disableVerticalSwipes?.();
    const chrome = document.documentElement.dataset.theme === 'light' ? '#f4f8f4' : '#050d0b';
    app.setHeaderColor?.(chrome);
    app.setBackgroundColor?.(chrome);
  } catch {
    // Older Telegram clients may not implement every method.
  }
}

/**
 * Bot API 8.0 fullscreen hides the Telegram chrome, which gives the board the
 * whole screen. Older clients and plain browsers still get an expanded view.
 */
export function getFullscreenState(): boolean {
  const app = getTelegramWebApp();
  if (app?.isFullscreen) return true;
  if (typeof document === 'undefined') return false;
  return Boolean(document.fullscreenElement);
}

export function toggleFullscreen(): boolean {
  const app = getTelegramWebApp();
  try {
    if (typeof app?.requestFullscreen === 'function') {
      if (app.isFullscreen) app.exitFullscreen?.();
      else app.requestFullscreen();
      return true;
    }
    if (typeof document === 'undefined') return false;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    } else {
      void document.documentElement.requestFullscreen?.();
    }
    return true;
  } catch {
    return false;
  }
}

export function subscribeFullscreen(handler: () => void): () => void {
  const app = getTelegramWebApp();
  try {
    app?.onEvent?.('fullscreenChanged', handler);
  } catch {
    // Older clients do not emit the event.
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('fullscreenchange', handler);
  }
  return () => {
    try {
      app?.offEvent?.('fullscreenChanged', handler);
    } catch {
      // Nothing to unsubscribe from.
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('fullscreenchange', handler);
    }
  };
}

export function supportsFullscreen(): boolean {
  const app = getTelegramWebApp();
  if (typeof app?.requestFullscreen === 'function') return true;
  if (typeof document === 'undefined') return false;
  return typeof document.documentElement.requestFullscreen === 'function';
}

export function haptic(kind: 'tap' | 'success' | 'error' | 'warning'): void {
  const feedback = getTelegramWebApp()?.HapticFeedback;
  if (!feedback) return;
  try {
    if (kind === 'tap') feedback.impactOccurred?.('light');
    else if (kind === 'success') feedback.notificationOccurred?.('success');
    else if (kind === 'error') feedback.notificationOccurred?.('error');
    else feedback.notificationOccurred?.('warning');
  } catch {
    // Haptics are cosmetic.
  }
}

export function telegramDisplayName(user: TelegramUser | undefined): string | null {
  if (!user) return null;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || user.username || null;
}
