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
  fetchAgentWithdrawals,
  redeemAgentWithdrawal,
  rejectAgentDeposit,
  setAgentPresence,
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
  Withdrawal,
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
    if (withdrawalQueue.status === 'fulfilled') setWithdrawals(withdrawalQueue.value);
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
    setActionBusy(true);
    setActionError(null);
    try {
      await redeemAgentWithdrawal(redeemTarget.payoutCode, actionNote.trim() || undefined);
      setRedeemTarget(null);
      setActionNote('');
      setNotice(`Payout ${redeemTarget.payoutCode} redeemed.`);
      await loadAll();
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
          <Button
            size="sm"
            variant={current.isOnline ? 'primary' : 'outline'}
            loading={presenceBusy}
            onClick={() => void togglePresence()}
          >
            {current.isOnline ? 'Online' : 'Offline'}
          </Button>
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
          Credit moves credits from your float to the player. Redeem pays an escrowed withdrawal and
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
                          {formatCredits(deposit.amount)} cr ·{' '}
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
              {openWithdrawals.map((withdrawal) => (
                <li key={withdrawal.id} className="rounded-xl border border-line/70 bg-ink/40 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-display text-xl font-black tracking-[0.2em]">
                        {withdrawal.payoutCode}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted">
                        {formatCredits(withdrawal.amount)} cr · net{' '}
                        {formatCredits(withdrawal.netAmount)} ·{' '}
                        {PAYMENT_METHODS.find((item) => item.value === withdrawal.method)?.label}
                      </p>
                      {withdrawal.playerNote ? (
                        <p className="mt-1 text-[11px] text-text/80">“{withdrawal.playerNote}”</p>
                      ) : null}
                    </div>
                    <Pill tone={STATUS_TONE[withdrawal.status] ?? 'neutral'}>
                      {withdrawal.status.toLowerCase()}
                    </Pill>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
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
                    ) : null}
                  </div>
                </li>
              ))}
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
                        {request.direction.toLowerCase()} · {formatCredits(request.amount)} cr
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
              requested {formatCredits(creditTarget.amount)} credits
            </p>
            {creditTarget.verificationStatus !== 'NOT_REQUIRED' ? (
              <p className="text-[11px] text-muted">
                Receipt check: {creditTarget.verificationStatus.toLowerCase()}
                {creditTarget.verificationMessage ? ` — ${creditTarget.verificationMessage}` : ''}
              </p>
            ) : null}
            <Input
              label="Credited amount (credits)"
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
                Give the player {formatCredits(redeemTarget.netAmount)} credits in cash before
                confirming — redemption is final.
              </p>
            </div>
            <Input
              label="Note (optional)"
              value={actionNote}
              onChange={(event) => setActionNote(event.target.value)}
            />
            {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}
            <Button className="w-full" variant="gold" loading={actionBusy} onClick={() => void submitRedeem()}>
              Cash paid — settle payout
            </Button>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
