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
  disableVerticalSwipes?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  isExpanded?: boolean;
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
    app.setHeaderColor?.('#050d0b');
    app.setBackgroundColor?.('#050d0b');
  } catch {
    // Older Telegram clients may not implement every method.
  }
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
