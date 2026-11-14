'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  configureApi,
  fetchMe,
  fetchWallet,
  getTokens,
  logoutRequest,
  passwordLogin,
  setTokens,
  telegramLogin,
  type AuthPayload,
  type Tokens,
} from '@/lib/api';
import { initTelegram, isTelegramClient, resolveTelegramInitData } from '@/lib/telegram';
import type { Agent, User, Wallet } from '@/lib/types';

const STORAGE_KEY = 'bingo.session.v1';

type Status = 'loading' | 'anon' | 'authed';

interface SessionContextValue {
  status: Status;
  user: User | null;
  wallet: Wallet | null;
  agent: Agent | null;
  isTelegram: boolean;
  telegramError: string | null;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshWallet: () => Promise<void>;
  setWallet: (patch: Partial<Wallet>) => void;
  setAgent: (agent: Agent | null) => void;
  retryTelegram: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function readStoredTokens(): Tokens | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Tokens;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredTokens(tokens: Tokens | null): void {
  if (typeof window === 'undefined') return;
  if (!tokens) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      refreshExpiresAt: tokens.refreshExpiresAt,
    }),
  );
}

function tokensFromAuth(auth: AuthPayload): Tokens {
  return {
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    refreshExpiresAt: auth.refreshExpiresAt,
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [wallet, setWalletState] = useState<Wallet | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [isTelegram, setIsTelegram] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const bootstrapped = useRef(false);

  const hydrate = useCallback(async () => {
    const me = await fetchMe();
    setUser(me.user);
    setWalletState(me.wallet);
    setAgent(me.agent);
    setStatus('authed');
  }, []);

  const reset = useCallback(() => {
    setTokens(null);
    setUser(null);
    setWalletState(null);
    setAgent(null);
    setStatus('anon');
  }, []);

  const bootstrap = useCallback(async () => {
    initTelegram();
    const initData = await resolveTelegramInitData();
    setIsTelegram(Boolean(initData) || isTelegramClient());

    if (initData) {
      try {
        const auth = await telegramLogin(initData);
        setTokens(tokensFromAuth(auth));
        setTelegramError(null);
        await hydrate();
        return;
      } catch (error) {
        setTelegramError(
          error instanceof ApiError
            ? `Telegram sign-in failed: ${error.message}`
            : 'Telegram sign-in failed. Reopen the app from the bot.',
        );
      }
    }

    if (getTokens() ?? readStoredTokens()) {
      if (!getTokens()) setTokens(readStoredTokens());
      try {
        await hydrate();
        return;
      } catch {
        // Refresh is attempted inside the API client; landing here means the
        // session is unusable, so fall through to the login screen.
      }
    }
    reset();
  }, [hydrate, reset]);

  useEffect(() => {
    configureApi({
      persist: writeStoredTokens,
      sessionLost: () => {
        setUser(null);
        setWalletState(null);
        setAgent(null);
        setStatus('anon');
      },
    });
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void bootstrap();
  }, [bootstrap]);

  const login = useCallback(
    async (identifier: string, password: string) => {
      const auth = await passwordLogin(identifier.trim(), password);
      setTokens(tokensFromAuth(auth));
      await hydrate();
    },
    [hydrate],
  );

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } catch {
      // Local sign-out must work even when the API is unreachable.
    }
    reset();
  }, [reset]);

  const refresh = useCallback(async () => {
    if (!getTokens()) return;
    await hydrate();
  }, [hydrate]);

  const refreshWallet = useCallback(async () => {
    if (!getTokens()) return;
    const next = await fetchWallet();
    setWalletState(next);
  }, []);

  const setWallet = useCallback((patch: Partial<Wallet>) => {
    setWalletState((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const retryTelegram = useCallback(async () => {
    setTelegramError(null);
    setStatus('loading');
    await bootstrap();
  }, [bootstrap]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      user,
      wallet,
      agent,
      isTelegram,
      telegramError,
      login,
      logout,
      refresh,
      refreshWallet,
      setWallet,
      setAgent,
      retryTelegram,
    }),
    [
      status,
      user,
      wallet,
      agent,
      isTelegram,
      telegramError,
      login,
      logout,
      refresh,
      refreshWallet,
      setWallet,
      retryTelegram,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}
