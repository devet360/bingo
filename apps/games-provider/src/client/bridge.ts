import type { Lang } from './types';

interface ThemeMessage {
  type: 'bingo:theme';
  payload: {
    scheme: 'dark' | 'light';
    bg: string; panel: string; text: string; hint: string; button: string; buttonText: string;
    gold: string; danger: string; safeBottom: number; viewportHeight: number;
  };
}

let onLocale: ((lang: Lang) => void) | null = null;
let pendingLocale: Lang | null = null;

function applyTheme(payload: ThemeMessage['payload']) {
  const root = document.documentElement;
  root.dataset.scheme = payload.scheme;
  root.style.setProperty('--g-bg', payload.bg);
  root.style.setProperty('--g-panel', payload.panel);
  root.style.setProperty('--g-text', payload.text);
  root.style.setProperty('--g-hint', payload.hint);
  root.style.setProperty('--g-accent', payload.button);
  root.style.setProperty('--g-on-accent', payload.buttonText);
  root.style.setProperty('--g-gold', payload.gold);
  root.style.setProperty('--g-danger', payload.danger);
  root.style.setProperty('--g-safe-bottom', `${payload.safeBottom}px`);
}

// The parent posts its theme and locale to this iframe as soon as it loads,
// which can be before React mounts. Listening from module scope means the first
// message is applied to the document root and locale is buffered until the app
// subscribes. Only a message from the framing document's own origin is applied.
const parentOrigin = typeof document === 'undefined' || !document.referrer
  ? null
  : new URL(document.referrer).origin;

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (!parentOrigin || event.origin !== parentOrigin) return;
    const data = event.data as { type?: string; payload?: unknown } | null;
    if (data?.type === 'bingo:theme') {
      applyTheme((data as ThemeMessage).payload);
    }
    if (data?.type === 'bingo:locale') {
      const lang: Lang = data.payload === 'am' ? 'am' : 'en';
      if (onLocale) onLocale(lang);
      else pendingLocale = lang;
    }
  });
}

export function installBridge(handlers: { onLocale: (lang: Lang) => void }) {
  onLocale = handlers.onLocale;
  if (pendingLocale !== null) {
    const lang = pendingLocale;
    pendingLocale = null;
    handlers.onLocale(lang);
  }
}

// The parent validates the provider origin on its side; this frame has no
// secret to protect by choosing a narrower target.
export function haptic(kind: 'tap' | 'success' | 'error') {
  window.parent.postMessage({ type: 'bingo:haptic', payload: kind }, '*');
}

export function exitGame() {
  window.parent.postMessage({ type: 'bingo:exit' }, '*');
}
