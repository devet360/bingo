export interface RuntimeConfig {
  apiUrl: string;
  socketUrl: string;
  /** Bot username without the @, used for the player sign-in deep link. */
  botUsername: string;
}

declare global {
  interface Window {
    __BINGO_CONFIG__?: Partial<RuntimeConfig>;
  }
}

/**
 * Dokku injects env vars at runtime, not build time, so `/config.js` writes the
 * API/socket URLs onto `window` before hydration. NEXT_PUBLIC_* is only a
 * local-dev fallback.
 */
export function getRuntimeConfig(): RuntimeConfig {
  const fallback = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  if (typeof window !== 'undefined' && window.__BINGO_CONFIG__?.apiUrl) {
    return {
      apiUrl: window.__BINGO_CONFIG__.apiUrl.replace(/\/$/, ''),
      socketUrl: (window.__BINGO_CONFIG__.socketUrl ?? window.__BINGO_CONFIG__.apiUrl).replace(/\/$/, ''),
      botUsername: window.__BINGO_CONFIG__.botUsername?.replace(/^@/, '') ?? '',
    };
  }
  return {
    apiUrl: fallback.replace(/\/$/, ''),
    socketUrl: (process.env.NEXT_PUBLIC_SOCKET_URL ?? fallback).replace(/\/$/, ''),
    botUsername: (process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, ''),
  };
}
