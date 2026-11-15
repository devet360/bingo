'use client';

import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'gold' | 'outline' | 'ghost' | 'danger';

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mint';
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-mint text-[#04120c] hover:bg-[#4ce9ae] shadow-glow',
    gold: 'bg-gold text-[#1a1204] hover:bg-[#f7d98a]',
    outline: 'border border-line bg-transparent text-text hover:border-mint/50 hover:bg-raised',
    ghost: 'text-muted hover:bg-raised hover:text-text',
    danger: 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20',
  };
  const sizes = {
    sm: 'h-9 px-3 text-xs',
    md: 'h-11 px-4 text-sm',
    lg: 'h-12 px-5 text-base',
  };
  return (
    <button
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block animate-spin rounded-full border-2 border-current border-t-transparent',
        className ?? 'h-5 w-5',
      )}
      aria-label="Loading"
    />
  );
}

export function Panel({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
}) {
  return (
    <Tag className={cn('rounded-2xl border border-line/80 bg-panel/90 shadow-card backdrop-blur', className)}>
      {children}
    </Tag>
  );
}

type Tone = 'neutral' | 'mint' | 'gold' | 'danger' | 'warn' | 'blue';

const TONES: Record<Tone, string> = {
  neutral: 'bg-raised text-muted border-line',
  mint: 'bg-mint/10 text-mint border-mint/25',
  gold: 'bg-gold/10 text-gold border-gold/25',
  danger: 'bg-danger/10 text-danger border-danger/25',
  warn: 'bg-warn/10 text-warn border-warn/25',
  blue: 'bg-blue/10 text-blue border-blue/25',
};

export function Pill({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border border-line/70 bg-raised/60 px-3 py-2.5', className)}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 font-display text-lg font-semibold text-text">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}

export function Input({
  label,
  hint,
  error,
  className,
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string }) {
  const inputId = id ?? rest.name;
  return (
    <label className="block">
      {label ? (
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
          {label}
        </span>
      ) : null}
      <input
        id={inputId}
        className={cn(
          'h-11 w-full rounded-xl border border-line bg-ink/60 px-3 text-sm text-text placeholder:text-muted/60 focus:border-mint/60 focus:outline-none',
          error && 'border-danger/60',
          className,
        )}
        {...rest}
      />
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : null}
      {!error && hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Select({
  label,
  children,
  className,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return (
    <label className="block">
      {label ? (
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
          {label}
        </span>
      ) : null}
      <select
        className={cn(
          'h-11 w-full appearance-none rounded-xl border border-line bg-ink/60 px-3 text-sm text-text focus:border-mint/60 focus:outline-none',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
    </label>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
      <p className="font-display text-sm font-semibold text-text">{title}</p>
      {body ? <p className="mx-auto mt-1 max-w-sm text-xs text-muted">{body}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
      {children}
    </p>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ value: T; label: string; badge?: number }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-xl border border-line bg-ink/50 p-1">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={cn(
            'flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition',
            value === tab.value ? 'bg-raised text-text shadow' : 'text-muted hover:text-text',
          )}
        >
          {tab.label}
          {tab.badge ? (
            <span className="ml-1.5 rounded-full bg-mint/20 px-1.5 py-0.5 text-[10px] text-mint">
              {tab.badge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // Portalled to <body>: ancestors such as Panel use backdrop-blur, which makes
  // them the containing block for fixed children, so an inline sheet would be
  // clipped under the app header and tab bar.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[calc(100dvh-0.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-line bg-panel shadow-2xl sm:max-h-[calc(100dvh-3rem)] sm:rounded-3xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line/70 px-5 py-3">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
