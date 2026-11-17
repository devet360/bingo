import React, { useEffect, useState } from 'react';
import { CheckCircle2, ShieldCheck, X, XCircle } from 'lucide-react';
import { t } from '../i18n';
import { verifyProof, type ProofPayload, type VerifyResult } from '../fair';
import type { Lang } from '../types';

interface ProvablyFairModalProps {
  isOpen: boolean;
  onClose: () => void;
  lang: Lang;
  currentRoundId: number | null;
  currentServerSeedHash: string | null;
  inspectedRoundId: number | null;
}

export const ProvablyFairModal: React.FC<ProvablyFairModalProps> = ({
  isOpen, onClose, lang, currentRoundId, currentServerSeedHash, inspectedRoundId,
}) => {
  const [proof, setProof] = useState<ProofPayload | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookup, setLookup] = useState('');

  const load = (id: number) => {
    setLoading(true);
    setError(null);
    setProof(null);
    setResult(null);
    return fetch(`/api/rounds/${id}/proof`)
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        const body = (await response.json()) as { data: ProofPayload };
        setProof(body.data);
      })
      .catch(() => setError(t(lang, 'proofUnavailable')))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!isOpen || inspectedRoundId === null) return;
    setLookup(String(inspectedRoundId));
    void load(inspectedRoundId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, inspectedRoundId]);

  useEffect(() => {
    if (!proof) return;
    let cancelled = false;
    void verifyProof(proof)
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch(() => {
        if (!cancelled) setError(t(lang, 'verificationMismatch'));
      });
    return () => {
      cancelled = true;
    };
  }, [proof, lang]);

  if (!isOpen) return null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const id = Number(lookup);
    if (Number.isSafeInteger(id) && id > 0) void load(id);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      style={{ paddingBottom: 'calc(var(--g-safe-bottom) + 1rem)' }}>
      <div className="w-full max-w-xl max-h-[90dvh] overflow-y-auto bg-[var(--g-panel)] border border-white/10 rounded-xl shadow-2xl">
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-3 sticky top-0 bg-[var(--g-panel)]">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <h2 className="text-sm font-display font-bold text-[var(--g-text)]">{t(lang, 'provablyFair')}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label={t(lang, 'close')}
            className="p-1.5 rounded-lg text-[var(--g-hint)] hover:text-[var(--g-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4 text-xs">
          <section className="rounded-lg bg-black/30 border border-white/10 p-3 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[var(--g-text)]">
                {t(lang, 'liveCommit')} #{currentRoundId ?? '—'}
              </span>
              <span className="text-[var(--g-hint)]">{t(lang, 'serverSeedHidden')}</span>
            </div>
            <div className="font-mono break-all text-[var(--g-hint)]">
              SHA-256: {currentServerSeedHash ?? '…'}
            </div>
          </section>

          <section className="rounded-lg bg-black/30 border border-white/10 p-3 flex flex-col gap-2">
            <form onSubmit={submit} className="flex items-center gap-1.5">
              <input type="number" min={1} value={lookup} onChange={(event) => setLookup(event.target.value)}
                aria-label={t(lang, 'round')}
                className="w-24 bg-black/40 border border-white/10 rounded-md px-2 py-1 font-mono text-[var(--g-text)] focus:outline-none" />
              <button type="submit" className="px-3 py-1 rounded-md bg-slate-800 text-[var(--g-text)] font-medium">
                {t(lang, 'inspect')}
              </button>
            </form>

            {loading && <div className="py-4 text-center text-[var(--g-hint)]">{t(lang, 'verifying')}</div>}
            {error && <div className="py-4 text-center text-[var(--g-danger)]">{error}</div>}
            {!loading && !error && !proof && (
              <div className="py-4 text-center text-[var(--g-hint)]">{t(lang, 'inspectHint')}</div>
            )}

            {proof && result && (
              <div className="flex flex-col gap-2">
                <div className={`p-2.5 rounded-md border flex items-center justify-between gap-2 ${
                  result.serverSeedHashMatches && result.crashPointMatches
                    ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                    : 'bg-rose-950/40 border-rose-500/40 text-rose-200'
                }`}>
                  <span className="flex items-center gap-1.5 font-semibold">
                    {result.serverSeedHashMatches && result.crashPointMatches
                      ? <CheckCircle2 className="w-4 h-4" />
                      : <XCircle className="w-4 h-4" />}
                    {result.serverSeedHashMatches && result.crashPointMatches
                      ? `${t(lang, 'verified')} · #${proof.roundId}`
                      : t(lang, 'verificationMismatch')}
                  </span>
                  <span className="font-mono font-bold tabular-nums">{result.computedCrashPoint.toFixed(2)}x</span>
                </div>
                <div>
                  <div className="text-[var(--g-hint)] mb-1">{t(lang, 'revealedServerSeed')}</div>
                  <div className="font-mono break-all text-[var(--g-text)]">{proof.serverSeed}</div>
                </div>
                <div>
                  <div className="text-[var(--g-hint)] mb-1">{t(lang, 'committedHash')}</div>
                  <div className="font-mono break-all text-emerald-300">{result.serverSeedHashComputed}</div>
                </div>
                <div>
                  <div className="text-[var(--g-hint)] mb-1">{t(lang, 'combinedInput')}</div>
                  <div className="font-mono break-all text-[var(--g-text)]">{result.combinedInput}</div>
                </div>
                <div className="font-mono text-[var(--g-hint)]">
                  SHA-512 → {result.hexSlice52Bit}
                </div>
                <div className="font-mono text-[var(--g-text)]">
                  {t(lang, 'crashResult')}: {result.computedCrashPoint.toFixed(2)}x
                  {result.decimalValue % 33 === 0 ? ` · ${t(lang, 'instantCrashEdge')}` : ''}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
