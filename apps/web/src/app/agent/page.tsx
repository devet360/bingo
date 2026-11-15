'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  claimAgentDeposit,
  creditAgentDeposit,
  fetchAgentCommissions,
  fetchAgentDeposits,
  fetchAgentFloatRequests,
  fetchAgentProfile,
  fetchAgentWithdrawalProofs,
  fetchAgentWithdrawals,
  redeemAgentWithdrawal,
  rejectAgentDeposit,
  setAgentAvailability,
  setAgentPresence,
  submitWithdrawalProof,
} from '@/lib/api';
import {
  PAYMENT_METHODS,
  creditsToMinor,
  minorToCreditsInput,
  formatCredits,
  formatDateTime,
} from '@/lib/format';
import { useSession } from '@/components/session';
import { AgentSettings } from '@/components/agent/settings';
import {
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Pill,
  Sheet,
  Spinner,
  Tabs,
} from '@/components/ui';
import type {
  Agent,
  Commission,
  Deposit,
  FloatRequest,
  VerificationStatus,
  Withdrawal,
  WithdrawalProof,
} from '@/lib/types';

type Tab = 'deposits' | 'withdrawals' | 'earnings' | 'settings';

const STATUS_TONE: Record<string, 'mint' | 'gold' | 'warn' | 'danger' | 'neutral'> = {
  PENDING: 'warn',
  PROCESSING: 'gold',
  ESCROWED: 'gold',
  CREDITED: 'mint',
  PAID: 'mint',
  SETTLED: 'mint',
  REJECTED: 'danger',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
};

const PROOF_TONE: Record<VerificationStatus, 'mint' | 'gold' | 'blue' | 'danger' | 'neutral'> = {
  NOT_REQUIRED: 'neutral',
  PENDING: 'gold',
  VERIFIED: 'mint',
  FAILED: 'danger',
  MANUAL: 'blue',
};

const PROOF_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_PROOF_BYTES = 4_500_000;

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export default function AgentPage() {
  const { agent, setAgent } = useSession();
  const [tab, setTab] = useState<Tab>('deposits');
  const [profile, setProfile] = useState<Agent | null>(agent);
  const [deposits, setDeposits] = useState<Deposit[] | null>(null);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[] | null>(null);
  const [commissions, setCommissions] = useState<Commission[] | null>(null);
  const [floats, setFloats] = useState<FloatRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [proofs, setProofs] = useState<Record<string, WithdrawalProof[]>>({});
  const [proofTarget, setProofTarget] = useState<Withdrawal | null>(null);
  const [proofReference, setProofReference] = useState('');
  const [proofAmount, setProofAmount] = useState('');
  const [proofSender, setProofSender] = useState('');
  const [proofReceiver, setProofReceiver] = useState('');
  const [proofPaidAt, setProofPaidAt] = useState('');
  const [proofNotes, setProofNotes] = useState('');
  const [proofShot, setProofShot] = useState<{ contentType: string; base64: string; name: string } | null>(
    null,
  );
  const [proofBusy, setProofBusy] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);

  // Manual-code flows
  const [code, setCode] = useState('');
  const [payoutCode, setPayoutCode] = useState('');
  const [creditTarget, setCreditTarget] = useState<Deposit | null>(null);
  const [creditAmount, setCreditAmount] = useState('');
  const [redeemTarget, setRedeemTarget] = useState<Withdrawal | null>(null);
  const [actionNote, setActionNote] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const [profileResult, depositQueue, withdrawalQueue, commissionList, floatList] =
      await Promise.allSettled([
        fetchAgentProfile(),
        fetchAgentDeposits(),
        fetchAgentWithdrawals(),
        fetchAgentCommissions(40),
        fetchAgentFloatRequests(10),
      ]);
    if (profileResult.status === 'fulfilled') {
      setProfile(profileResult.value.agent);
      setAgent(profileResult.value.agent);
    }
    if (depositQueue.status === 'fulfilled') setDeposits(depositQueue.value);
    if (withdrawalQueue.status === 'fulfilled') {
      setWithdrawals(withdrawalQueue.value);
      const processing = withdrawalQueue.value.filter((item) => item.status === 'PROCESSING');
      const entries = await Promise.all(
        processing.map(async (item) => {
          const items = await fetchAgentWithdrawalProofs(item.id).catch(() => [] as WithdrawalProof[]);
          return [item.id, items] as const;
        }),
      );
      setProofs(Object.fromEntries(entries));
    }
    if (commissionList.status === 'fulfilled') setCommissions(commissionList.value);
    if (floatList.status === 'fulfilled') setFloats(floatList.value);
    const failed = [depositQueue, withdrawalQueue].some((result) => result.status === 'rejected');
    setError(failed ? 'Some agent queues could not be loaded. Pull to refresh in a moment.' : null);
  }, [setAgent]);

  useEffect(() => {
    void loadAll();
    const timer = setInterval(() => void loadAll(), 15_000);
    return () => clearInterval(timer);
  }, [loadAll]);

  if (!agent) {
    return (
      <EmptyState
        title="Agent portal is invite-only"
        body="Your account is not linked to an agent profile. Players can still deposit and withdraw through the public agent network from the wallet tab."
      />
    );
  }

  const current = profile ?? agent;
  const togglePresence = async () => {
    setPresenceBusy(true);
    try {
      const next = await setAgentPresence(!current.isOnline);
      setProfile(next);
      setAgent(next);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not update presence.');
    } finally {
      setPresenceBusy(false);
    }
  };

  const toggleAvailability = async () => {
    setAvailabilityBusy(true);
    try {
      const next = await setAgentAvailability(!current.acceptingTasks);
      setProfile(next);
      setAgent(next);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not update availability.');
    } finally {
      setAvailabilityBusy(false);
    }
  };

  const openProof = (withdrawal: Withdrawal) => {
    setProofTarget(withdrawal);
    setProofReference('');
    setProofAmount(minorToCreditsInput(withdrawal.netAmount));
    setProofSender('');
    setProofReceiver('');
    setProofPaidAt('');
    setProofNotes('');
    setProofShot(null);
    setProofError(null);
  };

  const attachProofShot = async (file: File | null) => {
    setProofShot(null);
    setProofError(null);
    if (!file) return;
    if (!PROOF_IMAGE_TYPES.includes(file.type)) {
      setProofError('Use a PNG, JPEG or WebP image.');
      return;
    }
    if (file.size > MAX_PROOF_BYTES) {
      setProofError('That image is too large (max 4.5 MB).');
      return;
    }
    setProofShot({
      contentType: file.type,
      base64: await fileToBase64(file),
      name: file.name,
    });
  };

  const submitProof = async () => {
    if (!proofTarget) return;
    if (!proofReference.trim() && !proofShot) {
      setProofError('Enter the transaction reference or attach a receipt screenshot.');
      return;
    }
    let minor: number | undefined;
    if (proofAmount.trim()) {
      const parsed = creditsToMinor(proofAmount);
      if (parsed === null) {
        setProofError('Enter an amount like 1250 or 12.50.');
        return;
      }
      minor = parsed;
    }
    setProofBusy(true);
    setProofError(null);
    try {
      await submitWithdrawalProof(proofTarget.id, {
        reference: proofReference.trim() || undefined,
        paidAmount: minor,
        senderAccount: proofSender.trim() || undefined,
        receiverAccount: proofReceiver.trim() || undefined,
        paidAt: proofPaidAt ? new Date(proofPaidAt).toISOString() : undefined,
        notes: proofNotes.trim() || undefined,
        screenshotBase64: proofShot?.base64,
      });
      setNotice(`Proof sent for payout ${proofTarget.payoutCode}. Staff will verify it shortly.`);
      setProofTarget(null);
      await loadAll();
    } catch (cause) {
      setProofError(cause instanceof ApiError ? cause.message : 'Could not submit the proof.');
    } finally {
      setProofBusy(false);
    }
  };

  const runAction = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(success);
      await loadAll();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Action failed. Try again.');
    } finally {
      setBusyKey(null);
    }
  };

  const claimByCode = () => {
    const value = code.trim();
    if (!/^\d{6}$/.test(value)) {
      setError('Deposit codes are six digits.');
      return;
    }
    void runAction('claim-code', () => claimAgentDeposit(value), `Deposit ${value} is now yours to credit.`);
  };

  const creditByCode = () => {
    const value = code.trim();
    if (!/^\d{6}$/.test(value)) {
      setError('Deposit codes are six digits.');
      return;
    }
    void runAction(
      'credit-code',
      () => creditAgentDeposit({ code: value }),
      `Deposit ${value} credited to the player.`,
    );
  };

  const redeemByCode = () => {
    const value = payoutCode.trim();
    if (!/^\d{6}$/.test(value)) {
      setError('Payout codes are six digits.');
      return;
    }
    void runAction(
      'redeem-code',
      () => redeemAgentWithdrawal(value),
      `Payout ${value} settled and commission booked.`,
    );
  };

  const submitCredit = async () => {
    if (!creditTarget) return;
    setActionBusy(true);
    setActionError(null);
    try {
      let minor: number | undefined;
      if (creditAmount.trim()) {
        const parsed = creditsToMinor(creditAmount);
        if (parsed === null) {
          throw new ApiError(400, 'INVALID_AMOUNT', 'Enter an amount like 50 or 12.50.');
        }
        minor = parsed;
      }
      await creditAgentDeposit({
        code: creditTarget.code,
        creditedAmount: minor,
        note: actionNote.trim() || undefined,
      });
      setCreditTarget(null);
      setCreditAmount('');
      setActionNote('');
      setNotice(`Deposit ${creditTarget.code} credited.`);
      await loadAll();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'Credit failed.');
    } finally {
      setActionBusy(false);
    }
  };

  const submitRedeem = async () => {
    if (!redeemTarget) return;
    const target = redeemTarget;
    setActionBusy(true);
    setActionError(null);
    try {
      await redeemAgentWithdrawal(target.payoutCode, actionNote.trim() || undefined);
      setRedeemTarget(null);
      setActionNote('');
      setNotice(`Payout ${target.payoutCode} marked as paid. Attach the proof to settle it.`);
      await loadAll();
      openProof(target);
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'Redemption failed.');
    } finally {
      setActionBusy(false);
    }
  };

  const openDeposits = deposits ?? [];
  const openWithdrawals = withdrawals ?? [];
  const earningList = commissions ?? [];

  return (
    <div className="space-y-4">
      <Panel className="overflow-hidden">
        <div className="flex items-start justify-between gap-3 border-b border-line/70 px-4 py-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-mint/80">
              Agent portal
            </p>
            <h1 className="mt-0.5 font-display text-xl font-black tracking-tight">
              {current.displayName ?? current.agentCode}
            </h1>
            <p className="text-[11px] text-muted">
              {current.tier} · {current.region}
              {current.city ? ` · ${current.city}` : ''} · ★ {Number(current.ratingAvg).toFixed(1)} (
              {current.ratingCount})
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Button
              size="sm"
              variant={current.isOnline ? 'primary' : 'outline'}
              loading={presenceBusy}
              onClick={() => void togglePresence()}
            >
              {current.isOnline ? 'Online' : 'Offline'}
            </Button>
            <Button
              size="sm"
              variant={current.acceptingTasks ? 'gold' : 'outline'}
              loading={availabilityBusy}
              onClick={() => void toggleAvailability()}
            >
              {current.acceptingTasks ? 'Accepting tasks' : 'Paused'}
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-px bg-line/60 sm:grid-cols-4">
          <div className="bg-panel px-3 py-2.5">
            <p className="text-[9px] uppercase tracking-widest text-muted">Float</p>
            <p className="font-display text-base font-bold text-gold">
              {current.floatAvailable ? formatCredits(current.floatAvailable) : '—'}
            </p>
          </div>
          <div className="bg-panel px-3 py-2.5">
            <p className="text-[9px] uppercase tracking-widest text-muted">Float escrow</p>
            <p className="font-display text-base font-bold">
              {current.floatEscrow ? formatCredits(current.floatEscrow) : '—'}
            </p>
          </div>
          <div className="bg-panel px-3 py-2.5">
            <p className="text-[9px] uppercase tracking-widest text-muted">Commission</p>
            <p className="font-display text-base font-bold text-mint">
              {current.commissionEarned ? formatCredits(current.commissionEarned) : '—'}
            </p>
          </div>
          <div className="bg-panel px-3 py-2.5">
            <p className="text-[9px] uppercase tracking-widest text-muted">Completed</p>
            <p className="font-display text-base font-bold">
              {current.completedDeposits} <span className="text-[10px] text-muted">in</span>{' '}
              {current.completedWithdrawals} <span className="text-[10px] text-muted">out</span>
            </p>
          </div>
        </div>
      </Panel>

      {notice ? (
        <p className="rounded-xl border border-mint/30 bg-mint/10 px-3 py-2 text-xs text-mint">{notice}</p>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Panel className="p-4">
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
          Serve a code directly
        </h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="Deposit code"
              className="h-10 w-full rounded-xl border border-line bg-ink/60 px-3 text-sm tracking-[0.2em] focus:border-mint/60 focus:outline-none"
            />
            <Button
              size="sm"
              variant="outline"
              loading={busyKey === 'claim-code'}
              onClick={claimByCode}
            >
              Claim
            </Button>
            <Button
              size="sm"
              variant="gold"
              loading={busyKey === 'credit-code'}
              onClick={creditByCode}
            >
              Credit
            </Button>
          </div>
          <div className="flex gap-2">
            <input
              value={payoutCode}
              onChange={(event) =>
                setPayoutCode(event.target.value.replace(/\D/g, '').slice(0, 6))
              }
              inputMode="numeric"
              placeholder="Payout code"
              className="h-10 w-full rounded-xl border border-line bg-ink/60 px-3 text-sm tracking-[0.2em] focus:border-mint/60 focus:outline-none"
            />
            <Button
              size="sm"
              variant="gold"
              loading={busyKey === 'redeem-code'}
              onClick={redeemByCode}
            >
              Redeem
            </Button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          Credit moves ETB from your float to the player. Redeem pays an escrowed withdrawal and
          books your commission.
        </p>
      </Panel>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'deposits', label: 'Deposits', badge: openDeposits.length || undefined },
          { value: 'withdrawals', label: 'Payouts', badge: openWithdrawals.length || undefined },
          { value: 'earnings', label: 'Earnings' },
          { value: 'settings', label: 'Settings' },
        ]}
      />

      {tab === 'deposits' ? (
        <Panel className="p-4">
          {deposits === null ? (
            <div className="flex justify-center py-6">
              <Spinner className="h-5 w-5 text-mint" />
            </div>
          ) : openDeposits.length === 0 ? (
            <EmptyState title="No open deposits" body="New player requests appear here in real time." />
          ) : (
            <ul className="space-y-2">
              {openDeposits.map((deposit) => {
                const mine = deposit.agentProfileId === current.id;
                const unassigned = deposit.agentProfileId === null;
                return (
                  <li key={deposit.id} className="rounded-xl border border-line/70 bg-ink/40 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-display text-xl font-black tracking-[0.2em]">{deposit.code}</p>
                        <p className="mt-0.5 text-[11px] text-muted">
                          {formatCredits(deposit.amount)} ETB ·{' '}
                          {PAYMENT_METHODS.find((item) => item.value === deposit.method)?.label} ·{' '}
                          {deposit.createdAt ? formatDateTime(deposit.createdAt) : ''}
                        </p>
                        {deposit.playerNote ? (
                          <p className="mt-1 text-[11px] text-text/80">“{deposit.playerNote}”</p>
                        ) : null}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Pill tone={STATUS_TONE[deposit.status] ?? 'neutral'}>
                          {deposit.status.toLowerCase()}
                        </Pill>
                        {deposit.verificationStatus !== 'NOT_REQUIRED' ? (
                          <Pill
                            tone={
                              deposit.verificationStatus === 'VERIFIED'
                                ? 'mint'
                                : deposit.verificationStatus === 'FAILED'
                                  ? 'danger'
                                  : 'gold'
                            }
                          >
                            receipt {deposit.verificationStatus.toLowerCase()}
                          </Pill>
                        ) : null}
                        {unassigned ? <Pill tone="blue">unclaimed</Pill> : mine ? <Pill tone="mint">yours</Pill> : null}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {unassigned ? (
                        <Button
                          size="sm"
                          variant="outline"
                          loading={busyKey === `claim-${deposit.id}`}
                          onClick={() =>
                            void runAction(
                              `claim-${deposit.id}`,
                              () => claimAgentDeposit(deposit.code),
                              `Deposit ${deposit.code} claimed.`,
                            )
                          }
                        >
                          Claim
                        </Button>
                      ) : null}
                      {unassigned || mine ? (
                        <>
                          <Button
                            size="sm"
                            variant="gold"
                            onClick={() => {
                              setCreditTarget(deposit);
                              setCreditAmount(minorToCreditsInput(deposit.amount));
                              setActionNote('');
                              setActionError(null);
                            }}
                          >
                            Credit
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            loading={busyKey === `reject-${deposit.id}`}
                            onClick={() =>
                              void runAction(
                                `reject-${deposit.id}`,
                                () => rejectAgentDeposit(deposit.code, 'Rejected by agent'),
                                `Deposit ${deposit.code} rejected.`,
                              )
                            }
                          >
                            Reject
                          </Button>
                        </>
                      ) : null}
                      <span className="self-center text-[10px] text-muted">
                        expires {formatDateTime(deposit.expiresAt)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      ) : null}

      {tab === 'withdrawals' ? (
        <Panel className="p-4">
          {withdrawals === null ? (
            <div className="flex justify-center py-6">
              <Spinner className="h-5 w-5 text-mint" />
            </div>
          ) : openWithdrawals.length === 0 ? (
            <EmptyState
              title="No payouts assigned"
              body="Players pick an agent when they request a cash-out. Their payout codes land here."
            />
          ) : (
            <ul className="space-y-2">
              {openWithdrawals.map((withdrawal) => {
                const latest = proofs[withdrawal.id]?.[0] ?? null;
                return (
                  <li key={withdrawal.id} className="rounded-xl border border-line/70 bg-ink/40 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-display text-xl font-black tracking-[0.2em]">
                          {withdrawal.payoutCode}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted">
                          {formatCredits(withdrawal.amount)} ETB · net{' '}
                          {formatCredits(withdrawal.netAmount)} ETB ·{' '}
                          {PAYMENT_METHODS.find((item) => item.value === withdrawal.method)?.label}
                        </p>
                        {withdrawal.playerNote ? (
                          <p className="mt-1 text-[11px] text-text/80">“{withdrawal.playerNote}”</p>
                        ) : null}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Pill tone={STATUS_TONE[withdrawal.status] ?? 'neutral'}>
                          {withdrawal.status.toLowerCase()}
                        </Pill>
                        {withdrawal.status === 'PROCESSING' ? (
                          latest ? (
                            <Pill tone={PROOF_TONE[latest.status] ?? 'neutral'}>
                              proof {latest.status.toLowerCase()}
                            </Pill>
                          ) : (
                            <Pill tone="warn">proof required</Pill>
                          )
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[10px] text-muted">
                        expires {formatDateTime(withdrawal.expiresAt)}
                      </span>
                      {withdrawal.status === 'ESCROWED' ? (
                        <Button
                          size="sm"
                          variant="gold"
                          onClick={() => {
                            setRedeemTarget(withdrawal);
                            setActionNote('');
                            setActionError(null);
                          }}
                        >
                          Hand over cash & redeem
                        </Button>
                      ) : withdrawal.status === 'PROCESSING' &&
                        (!latest || latest.status === 'FAILED') ? (
                        <Button size="sm" variant="outline" onClick={() => openProof(withdrawal)}>
                          {latest ? 'Resubmit proof' : 'Submit payment proof'}
                        </Button>
                      ) : null}
                      {withdrawal.status === 'PROCESSING' &&
                      (latest?.status === 'PENDING' || latest?.status === 'MANUAL') ? (
                        <span className="text-[10px] text-gold">Awaiting staff verification</span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      ) : null}

      {tab === 'earnings' ? (
        <div className="space-y-3">
          <Panel className="p-4">
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
              Commission ledger
            </h2>
            {commissions === null ? (
              <Spinner className="mx-auto my-6 h-5 w-5 text-mint" />
            ) : earningList.length === 0 ? (
              <p className="mt-2 text-xs text-muted">No commissions booked yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line/60">
                {earningList.map((commission) => (
                  <li key={commission.id} className="flex items-center justify-between gap-2 py-2">
                    <div>
                      <p className="text-xs font-semibold">
                        {commission.kind === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'} · {commission.bps} bps
                      </p>
                      <p className="text-[10px] text-muted">
                        base {formatCredits(commission.baseAmount)} · {formatDateTime(commission.createdAt)}
                      </p>
                    </div>
                    <span className="font-display text-sm font-bold text-mint">
                      +{formatCredits(commission.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel className="p-4">
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
              Float requests
            </h2>
            {floats === null ? (
              <Spinner className="mx-auto my-6 h-5 w-5 text-mint" />
            ) : floats.length === 0 ? (
              <p className="mt-2 text-xs text-muted">
                No float movements. A platform admin tops up agents from the back office.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-line/60">
                {floats.map((request) => (
                  <li key={request.id} className="flex items-center justify-between gap-2 py-2">
                    <div>
                      <p className="text-xs font-semibold capitalize">
                        {request.direction.toLowerCase()} · {formatCredits(request.amount)} ETB
                      </p>
                      <p className="text-[10px] text-muted">{formatDateTime(request.createdAt)}</p>
                    </div>
                    <Pill tone={STATUS_TONE[request.status] ?? 'neutral'}>
                      {request.status.toLowerCase()}
                    </Pill>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      ) : null}

      {tab === 'settings' ? <AgentSettings /> : null}

      <Sheet open={creditTarget !== null} title="Credit deposit" onClose={() => setCreditTarget(null)}>
        {creditTarget ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              Code <span className="font-bold tracking-widest text-text">{creditTarget.code}</span> ·
              requested {formatCredits(creditTarget.amount)} ETB
            </p>
            {creditTarget.verificationStatus !== 'NOT_REQUIRED' ? (
              <p className="text-[11px] text-muted">
                Receipt check: {creditTarget.verificationStatus.toLowerCase()}
                {creditTarget.verificationMessage ? ` — ${creditTarget.verificationMessage}` : ''}
              </p>
            ) : null}
            <Input
              label="Credited amount (ETB)"
              inputMode="decimal"
              value={creditAmount}
              onChange={(event) => setCreditAmount(event.target.value)}
              hint="Defaults to the requested amount. Cannot exceed it."
            />
            <Input
              label="Note (optional)"
              value={actionNote}
              onChange={(event) => setActionNote(event.target.value)}
            />
            {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}
            <Button className="w-full" loading={actionBusy} onClick={() => void submitCredit()}>
              Credit player
            </Button>
          </div>
        ) : null}
      </Sheet>

      <Sheet open={redeemTarget !== null} title="Redeem payout" onClose={() => setRedeemTarget(null)}>
        {redeemTarget ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-ink/50 p-3 text-xs">
              <p>
                Payout code{' '}
                <span className="font-display font-bold tracking-[0.25em] text-gold">
                  {redeemTarget.payoutCode}
                </span>
              </p>
              <p className="mt-1 text-muted">
                Give the player {formatCredits(redeemTarget.netAmount)} ETB in cash before
                confirming. The payout is held until you attach the payment proof.
              </p>
            </div>
            <Input
              label="Note (optional)"
              value={actionNote}
              onChange={(event) => setActionNote(event.target.value)}
            />
            {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}
            <Button className="w-full" variant="gold" loading={actionBusy} onClick={() => void submitRedeem()}>
              Cash paid — continue to proof
            </Button>
          </div>
        ) : null}
      </Sheet>

      <Sheet open={proofTarget !== null} title="Submit payment proof" onClose={() => setProofTarget(null)}>
        {proofTarget ? (
          <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            <div className="rounded-xl bg-ink/50 p-3 text-xs">
              <p>
                Payout code{' '}
                <span className="font-display font-bold tracking-[0.25em] text-gold">
                  {proofTarget.payoutCode}
                </span>
              </p>
              <p className="mt-1 text-muted">
                Paid {formatCredits(proofTarget.amount)} ETB · player receives{' '}
                {formatCredits(proofTarget.netAmount)} ETB. Add the transfer reference, account
                details and a screenshot so staff can verify.
              </p>
            </div>
            <Input
              label="Transaction reference"
              value={proofReference}
              onChange={(event) => setProofReference(event.target.value)}
              placeholder="FT… / bank reference"
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Amount paid (ETB)"
                inputMode="decimal"
                value={proofAmount}
                onChange={(event) => setProofAmount(event.target.value)}
              />
              <Input
                label="Paid at"
                type="datetime-local"
                value={proofPaidAt}
                onChange={(event) => setProofPaidAt(event.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Sender account"
                value={proofSender}
                onChange={(event) => setProofSender(event.target.value)}
                hint="Your paying account"
              />
              <Input
                label="Receiver account"
                value={proofReceiver}
                onChange={(event) => setProofReceiver(event.target.value)}
                hint="Player's destination"
              />
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
                Receipt screenshot
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => void attachProofShot(event.target.files?.[0] ?? null)}
                className="block w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-raised file:px-3 file:py-2 file:text-xs file:font-semibold file:text-text"
              />
              <span className="mt-1 block text-[10px] text-muted">
                {proofShot ? `Attached: ${proofShot.name}` : 'PNG, JPEG or WebP up to 4.5 MB.'}
              </span>
            </label>
            <Input
              label="Notes (optional)"
              value={proofNotes}
              onChange={(event) => setProofNotes(event.target.value)}
            />
            {proofError ? <ErrorNote>{proofError}</ErrorNote> : null}
            <Button className="w-full" variant="gold" loading={proofBusy} onClick={() => void submitProof()}>
              Submit proof for verification
            </Button>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
