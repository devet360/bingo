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

export type TelegramImpactStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';

interface TelegramButton {
  isVisible?: boolean;
  isActive?: boolean;
  show?: () => void;
  hide?: () => void;
  enable?: () => void;
  disable?: () => void;
  setText?: (text: string) => void;
  showProgress?: (leaveActive?: boolean) => void;
  hideProgress?: () => void;
  setParams?: (params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_active?: boolean;
    is_visible?: boolean;
  }) => void;
  onClick?: (handler: () => void) => void;
  offClick?: (handler: () => void) => void;
}

interface TelegramBackButton {
  isVisible?: boolean;
  show?: () => void;
  hide?: () => void;
  onClick?: (handler: () => void) => void;
  offClick?: (handler: () => void) => void;
}

interface TelegramPopupButton {
  id?: string;
  type?: 'default' | 'ok' | 'close' | 'cancel' | 'destructive';
  text?: string;
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: TelegramUser; start_param?: string };
  colorScheme?: string;
  themeParams?: Record<string, string>;
  viewportHeight?: number;
  viewportStableHeight?: number;
  ready?: () => void;
  expand?: () => void;
  close?: () => void;
  disableVerticalSwipes?: () => void;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  setBottomBarColor?: (color: string) => void;
  isExpanded?: boolean;
  isFullscreen?: boolean;
  requestFullscreen?: () => void;
  exitFullscreen?: () => void;
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
  isVersionAtLeast?: (version: string) => boolean;
  platform?: string;
  version?: string;
  openTelegramLink?: (url: string) => void;
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
  shareURL?: (url: string, text?: string) => void;
  showConfirm?: (message: string, callback: (confirmed: boolean) => void) => void;
  showAlert?: (message: string, callback?: () => void) => void;
  showPopup?: (
    params: { title?: string; message: string; buttons?: TelegramPopupButton[] },
    callback?: (buttonId: string) => void,
  ) => void;
  HapticFeedback?: TelegramHaptic;
  MainButton?: TelegramButton;
  SecondaryButton?: TelegramButton;
  BackButton?: TelegramBackButton;
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
    app.setBottomBarColor?.(chrome);
  } catch {
    // Older Telegram clients may not implement every method.
  }
  syncViewport();
  try {
    app.onEvent?.('viewportChanged', syncViewport);
  } catch {
    // The event is only emitted on Bot API 8.0+ clients.
  }
}

/**
 * Telegram reports a stable viewport height that shrinks when the on-screen
 * keyboard opens. Mirroring it into a CSS variable lets layouts use the real
 * visible area instead of the full device screen.
 */
function syncViewport(): void {
  const app = getTelegramWebApp();
  if (!app || typeof document === 'undefined') return;
  const height = app.viewportStableHeight ?? app.viewportHeight;
  if (height && height > 0) {
    document.documentElement.style.setProperty('--tg-viewport-height', `${height}px`);
  }
}

export function telegramVersionAtLeast(version: string): boolean {
  const app = getTelegramWebApp();
  if (!app) return false;
  try {
    if (typeof app.isVersionAtLeast === 'function') return app.isVersionAtLeast(version);
    const parts = (app.version ?? '0').split('.').map((part) => Number(part) || 0);
    const wanted = version.split('.').map((part) => Number(part) || 0);
    for (let index = 0; index < wanted.length; index += 1) {
      const have = parts[index] ?? 0;
      const want = wanted[index] ?? 0;
      if (have > want) return true;
      if (have < want) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Telegram's own confirm sheet when the client supports it, so money and
 * payout decisions are confirmed in the platform's voice. Browsers keep the
 * standard dialog.
 */
export function confirmAction(options: {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}): Promise<boolean> {
  const app = getTelegramWebApp();
  if (app && telegramVersionAtLeast('6.2') && typeof app.showPopup === 'function') {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        app.showPopup?.(
          {
            title: options.title,
            message: options.message,
            buttons: [
              { id: 'ok', type: options.destructive ? 'destructive' : 'default', text: options.confirmText ?? 'Confirm' },
              { id: 'cancel', type: 'cancel', text: options.cancelText ?? 'Cancel' },
            ],
          },
          (buttonId) => finish(buttonId === 'ok'),
        );
      } catch {
        finish(window.confirm(options.message));
      }
    });
  }
  if (typeof window === 'undefined') return Promise.resolve(false);
  return Promise.resolve(window.confirm(options.message));
}

export function alertUser(message: string, title?: string): Promise<void> {
  const app = getTelegramWebApp();
  if (app && telegramVersionAtLeast('6.2') && typeof app.showAlert === 'function') {
    return new Promise((resolve) => {
      try {
        app.showAlert?.(message, () => resolve());
      } catch {
        window.alert(message);
        resolve();
      }
    });
  }
  if (typeof window !== 'undefined') window.alert(message);
  return Promise.resolve();
}

/**
 * Bot API 8.0 clients share natively; older ones fall back to the t.me share
 * sheet, which every Telegram client handles.
 */
export function shareLink(url: string, text?: string): boolean {
  const app = getTelegramWebApp();
  try {
    if (app && typeof app.shareURL === 'function' && telegramVersionAtLeast('8.0')) {
      app.shareURL(url, text);
      return true;
    }
  } catch {
    // Fall through to the share sheet.
  }
  try {
    const share = `https://t.me/share/url?url=${encodeURIComponent(url)}${
      text ? `&text=${encodeURIComponent(text)}` : ''
    }`;
    if (app?.openTelegramLink) app.openTelegramLink(share);
    else if (typeof window !== 'undefined') window.open(share, '_blank', 'noreferrer');
    return true;
  } catch {
    return false;
  }
}

export function openExternalLink(url: string): void {
  const app = getTelegramWebApp();
  try {
    if (app?.openLink) {
      app.openLink(url);
      return;
    }
    if (app?.openTelegramLink) {
      app.openTelegramLink(url);
      return;
    }
  } catch {
    // Fall back to a normal tab.
  }
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noreferrer');
}

/** Warns before the player swipes the Mini App away mid-game. */
export function setClosingConfirmation(enabled: boolean): void {
  const app = getTelegramWebApp();
  try {
    if (enabled) app?.enableClosingConfirmation?.();
    else app?.disableClosingConfirmation?.();
  } catch {
    // Older clients do not close-confirm.
  }
}

export function subscribeThemeChange(handler: () => void): () => void {
  const app = getTelegramWebApp();
  try {
    app?.onEvent?.('themeChanged', handler);
  } catch {
    // No theme event on this client.
  }
  return () => {
    try {
      app?.offEvent?.('themeChanged', handler);
    } catch {
      // Nothing to unsubscribe from.
    }
  };
}

export function hapticImpact(style: TelegramImpactStyle = 'light'): void {
  const feedback = getTelegramWebApp()?.HapticFeedback;
  try {
    feedback?.impactOccurred?.(style);
  } catch {
    // Haptics are cosmetic.
  }
}

export function hapticSelection(): void {
  const feedback = getTelegramWebApp()?.HapticFeedback;
  try {
    feedback?.selectionChanged?.();
  } catch {
    // Haptics are cosmetic.
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
