'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, fetchRoundProof } from '@/lib/api';
import { ballTone } from '@/lib/bingo';
import { useI18n } from '@/lib/i18n';
import { Button, CopyButton, ErrorNote, Panel, Pill, Spinner, cn } from '@/components/ui';
import type { RoundProof } from '@/lib/types';

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <li className="flex items-start gap-2.5 rounded-xl bg-ink/50 px-3 py-2">
      <span
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-black',
          ok ? 'bg-mint/20 text-mint' : 'bg-danger/20 text-danger',
        )}
      >
        {ok ? '✓' : '×'}
      </span>
      <div>
        <p className="text-xs font-semibold">{label}</p>
        {detail ? <p className="text-[10px] text-muted">{detail}</p> : null}
      </div>
    </li>
  );
}

export default function VerifyPage() {
  const params = useParams<{ roundId: string }>();
  const roundId = params.roundId;
  const { t } = useI18n();
  const [proof, setProof] = useState<RoundProof | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browserHash, setBrowserHash] = useState<string | null>(null);

  useEffect(() => {
    fetchRoundProof(roundId)
      .then(async (data) => {
        setProof(data);
        if (data.serverSeed) {
          setBrowserHash(await sha256Hex(data.serverSeed));
        }
      })
      .catch((cause) => {
        setError(cause instanceof ApiError ? cause.message : t('verify.loadError'));
      });
  }, [roundId]);

  const ballCount = proof?.variant === 'UK_90' ? 90 : 75;
  const drawnCount = proof?.drawnBalls.length ?? 0;
  const browserMatches = useMemo(
    () => Boolean(proof && browserHash && browserHash === proof.serverSeedHash),
    [proof, browserHash],
  );

  if (error) {
    return (
      <div className="space-y-3 py-10 text-center">
        <ErrorNote>{error}</ErrorNote>
        <Link href="/">
          <Button variant="outline" size="sm">
            {t('verify.backLobby')}
          </Button>
        </Link>
      </div>
    );
  }

  if (!proof) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted">
        <Spinner className="h-6 w-6 text-mint" />
        <p className="text-xs uppercase tracking-widest">{t('verify.loading')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="text-xs text-muted hover:text-text">
          {t('room.lobby')}
        </Link>
        <Pill tone={proof.matches ? 'mint' : 'danger'}>
          {proof.matches ? t('verify.valid') : t('verify.mismatch')}
        </Pill>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-mint/80">
          {t('verify.eyebrow')}
        </p>
        <h1 className="mt-1 font-display text-2xl font-black tracking-tight">{t('verify.title')}</h1>
        <p className="mt-0.5 break-all font-mono text-[10px] text-muted">{proof.roundId}</p>
      </div>

      <Panel className="p-4">
        <ul className="space-y-1.5">
          <Check
            ok={proof.seedHashMatches && browserMatches}
            label="Seed hash matches the revealed seed"
            detail="SHA-256(serverSeed) computed here in your browser."
          />
          <Check
            ok={proof.committed}
            label="Commitment published before draws"
            detail="The hash was locked in before the first ball."
          />
          <Check
            ok={proof.alreadyDrawnMatch}
            label="Live draws are a prefix of the committed order"
            detail={`${drawnCount} balls were shown during play.`}
          />
          <Check
            ok={proof.matches}
            label="Recomputed ball order matches the server"
            detail={`${proof.rngVersion} · nonce ${proof.nonce}`}
          />
        </ul>
        {!proof.seedHashMatches ? (
          <p className="mt-2 text-[11px] text-danger">
            The API reports a seed hash mismatch — contact support with this round id.
          </p>
        ) : null}
      </Panel>

      <Panel className="p-4">
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">{t('verify.seeds')}</h2>
        <div className="mt-2 space-y-2">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted">{t('verify.serverSeed')}</p>
            <div className="mt-1 flex items-start justify-between gap-2">
              <p className="break-all font-mono text-[11px] text-text">{proof.serverSeed}</p>
              <CopyButton value={proof.serverSeed} />
            </div>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted">{t('verify.serverSeedHash')}</p>
            <div className="mt-1 flex items-start justify-between gap-2">
              <p className="break-all font-mono text-[11px] text-muted">{proof.serverSeedHash}</p>
              <CopyButton value={proof.serverSeedHash} />
            </div>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted">
              {t('verify.clientSeeds', { count: proof.clientSeedCount })}
            </p>
            {proof.clientSeeds.length === 0 ? (
              <p className="mt-1 font-mono text-[11px] text-text">{proof.clientSeed ?? '—'}</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {proof.clientSeeds.map((seed, index) => (
                  <li key={`${seed.userId}-${index}`} className="font-mono text-[11px] text-text">
                    <span className="text-muted">{seed.userId.slice(0, 8)}…</span> {seed.clientSeed}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-[10px] text-muted">
              finalSeed = HMAC-SHA256(serverSeed, clientSeed:nonce)
            </p>
          </div>
        </div>
      </Panel>

      <Panel className="p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
            {t('verify.committed')}
          </h2>
          <span className="text-[10px] text-muted">
            {t('verify.drawnCount', { drawn: drawnCount, total: ballCount })}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-10 gap-1">
          {Array.from({ length: ballCount }, (_, index) => {
            const ball = proof.ballOrder[index];
            const drawn = index < drawnCount;
            return (
              <span
                key={index}
                className={cn(
                  'flex aspect-square items-center justify-center rounded-md text-[10px] font-semibold tabular-nums',
                  drawn
                    ? cn('text-white', ball !== undefined ? ballTone(ball) : 'bg-raised')
                    : 'bg-raised/50 text-muted',
                  drawn && 'ring-1 ring-white/30',
                )}
              >
                {ball ?? '·'}
              </span>
            );
          })}
        </div>
        <p className="mt-2 text-[10px] text-muted">
          {t('verify.orderNote')}
        </p>
      </Panel>

      <Panel className="p-4 text-xs text-muted">
        <p>
          Status <span className="font-semibold text-text">{proof.status}</span>
          {proof.ballOrder.length > 0 ? (
            <>
              {' '}
              · first ball <span className="font-semibold text-text">{proof.ballOrder[0]}</span>
            </>
          ) : null}
        </p>
        <p className="mt-1">
          Round id <span className="font-mono text-[10px] text-text">{proof.roundId}</span>
        </p>
        {proof.clientSeeds[0]?.userId ? (
          <p className="mt-1">Client seed contributors: {proof.clientSeeds.length}</p>
        ) : null}
      </Panel>

      <p className="text-center text-[10px] text-muted">
        {t('verify.footer')}
      </p>
    </div>
  );
}
