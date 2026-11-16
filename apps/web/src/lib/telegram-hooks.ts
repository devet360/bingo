'use client';

import { useCallback, useEffect, useRef } from 'react';
import { getTelegramWebApp, setClosingConfirmation } from './telegram';

/** Shows Telegram's own Back button and wires it to the supplied handler. */
export function useTelegramBackButton(onBack: () => void, enabled = true): void {
  const handler = useRef(onBack);
  handler.current = onBack;

  useEffect(() => {
    const back = getTelegramWebApp()?.BackButton;
    if (!back) return;
    const click = () => handler.current();
    try {
      back.onClick?.(click);
      if (enabled) back.show?.();
      else back.hide?.();
    } catch {
      // Older clients ignore button calls.
    }
    return () => {
      try {
        back.offClick?.(click);
        back.hide?.();
      } catch {
        // Nothing to clean up.
      }
    };
  }, [enabled]);
}

export interface MainButtonOptions {
  text: string;
  onClick: () => void;
  visible?: boolean;
  enabled?: boolean;
  loading?: boolean;
  progress?: boolean;
  color?: string;
  textColor?: string;
}

/**
 * Mirrors the primary action of a screen into Telegram's native Main button.
 * Browsers get nothing here; the in-page button stays the fallback.
 */
export function useTelegramMainButton({
  text,
  onClick,
  visible = true,
  enabled = true,
  loading = false,
  progress = false,
}: MainButtonOptions): void {
  const handler = useRef(onClick);
  handler.current = onClick;
  const click = useCallback(() => handler.current(), []);

  useEffect(() => {
    const button = getTelegramWebApp()?.MainButton;
    if (!button) return;
    try {
      button.onClick?.(click);
    } catch {
      // No main button on this client.
    }
    return () => {
      try {
        button.offClick?.(click);
        button.hideProgress?.();
        button.hide?.();
      } catch {
        // Nothing to clean up.
      }
    };
  }, [click]);

  useEffect(() => {
    const button = getTelegramWebApp()?.MainButton;
    if (!button) return;
    try {
      if (button.setText) button.setText(text);
      else button.setParams?.({ text });
      if (visible) {
        button.show?.();
        button.setParams?.({ is_visible: true });
      } else {
        button.hide?.();
      }
    } catch {
      // Ignore partial implementations.
    }
  }, [text, visible]);

  useEffect(() => {
    const button = getTelegramWebApp()?.MainButton;
    if (!button) return;
    try {
      if (enabled) button.enable?.();
      else button.disable?.();
    } catch {
      // Ignore partial implementations.
    }
  }, [enabled]);

  useEffect(() => {
    const button = getTelegramWebApp()?.MainButton;
    if (!button) return;
    try {
      if (loading || progress) button.showProgress?.(true);
      else button.hideProgress?.();
    } catch {
      // Ignore partial implementations.
    }
  }, [loading, progress]);
}

/** Asks Telegram to confirm before the player swipes the Mini App closed. */
export function useTelegramClosingConfirmation(enabled: boolean): void {
  useEffect(() => {
    setClosingConfirmation(enabled);
    return () => setClosingConfirmation(false);
  }, [enabled]);
}
