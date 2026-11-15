'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  createBonusPromotion,
  deleteBonusPromotion,
  fetchAdminBonuses,
  fetchAdminReferrals,
  fetchAdminSettings,
  fetchBonusPromotions,
  grantBonus,
  updateBonusPromotion,
  updateBonusSettings,
  updateReferralSettings,
} from '@/lib/api';
import { creditsToMinor, formatCredits, formatDateTime, formatStake } from '@/lib/format';
import {
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Pill,
  Select,
  Sheet,
} from '@/components/ui';
import type {
  AdminReferralRow,
  AdminSettings,
  BonusPromotion,
  BonusWithPlayer,
  PageMeta,
} from '@/lib/types';
import { LoadingBlock, Pager, SectionTitle } from './shared';

const STATUS_TONE: Record<string, 'mint' | 'gold' | 'neutral'> = {
  ACTIVE: 'gold',
  COMPLETED: 'mint',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
};

export function BonusesTab() {
  return (
    <div className="space-y-4">
      <ProgrammeSettings />
      <PromoCodes />
      <GrantedBonuses />
      <TopReferrers />
    </div>
  );
}

function ProgrammeSettings() {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [percent, setPercent] = useState('');
  const [minRake, setMinRake] = useState('');
  const [multiplier, setMultiplier] = useState('');
  const [expiryDays, setExpiryDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchAdminSettings();
      setSettings(next);
      setPercent((next.referral.commissionBps / 100).toString());
      setMinRake((Number(next.referral.minRakeToPay) / 100).toString());
      setMultiplier(String(next.bonus.defaultWageringMultiplier));
      setExpiryDays(String(next.bonus.defaultExpiryDays));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the programme settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings) {
    return (
      <Panel>
        <LoadingBlock />
      </Panel>
    );
  }

  const save = async () => {
    setError(null);
    setNotice(null);
    const pct = Number(percent);
    const rake = creditsToMinor(minRake || '0');
    const mult = Number(multiplier);
    const days = Number(expiryDays);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) {
      setError('Referral share must be between 0% and 50%.');
      return;
    }
    if (rake === null) {
      setError('The minimum rake must look like 1 or 0.50.');
      return;
    }
    if (!Number.isInteger(mult) || mult < 1 || mult > 100) {
      setError('The wagering multiplier must be a whole number from 1 to 100.');
      return;
    }
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setError('The bonus expiry must be 1–365 days.');
      return;
    }
    setBusy(true);
    try {
      await Promise.all([
        updateReferralSettings({ commissionBps: Math.round(pct * 100), minRakeToPay: rake }),
        updateBonusSettings({ defaultWageringMultiplier: mult, defaultExpiryDays: days }),
      ]);
      setNotice('Programme settings saved.');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the settings.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="overflow-hidden">
      <div className="border-b border-line/60 px-4 py-3">
        <SectionTitle>Programme settings</SectionTitle>
        <p className="mt-1 text-[11px] text-muted">
          Wagering target = bonus amount × multiplier. Referrers are paid a share of the rake their
          invited players generate, settled with each round.
        </p>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <Input
          label="Referral share (%)"
          inputMode="decimal"
          value={percent}
          onChange={(event) => setPercent(event.target.value)}
          hint="Share of rake paid to the referrer. 2.5 = 2.5%."
        />
        <Input
          label="Minimum rake to pay (ETB)"
          inputMode="decimal"
          value={minRake}
          onChange={(event) => setMinRake(event.target.value)}
          hint="Skip payouts below this rake."
        />
        <Input
          label="Default wagering multiplier"
          inputMode="numeric"
          value={multiplier}
          onChange={(event) => setMultiplier(event.target.value)}
          hint="Applies to admin grants unless overridden."
        />
        <Input
          label="Default bonus expiry (days)"
          inputMode="numeric"
          value={expiryDays}
          onChange={(event) => setExpiryDays(event.target.value)}
        />
      </div>
      <div className="space-y-2 px-4 pb-4">
        <ErrorNote>{error}</ErrorNote>
        {notice ? (
          <p className="rounded-xl border border-mint/30 bg-mint/10 px-3 py-2 text-xs text-mint">
            {notice}
          </p>
        ) : null}
        <Button loading={busy} onClick={() => void save()}>
          Save settings
        </Button>
      </div>
    </Panel>
  );
}

interface PromoDraft {
  code: string;
  name: string;
  mode: 'FIXED' | 'PERCENT';
  value: string;
  maxBonus: string;
  minDeposit: string;
  multiplier: string;
  expiresInDays: string;
  maxRedemptions: string;
  enabled: boolean;
  startsAt: string;
  endsAt: string;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function emptyPromo(): PromoDraft {
  return {
    code: '',
    name: '',
    mode: 'FIXED',
    value: '',
    maxBonus: '',
    minDeposit: '',
    multiplier: '1',
    expiresInDays: '7',
    maxRedemptions: '',
    enabled: true,
    startsAt: '',
    endsAt: '',
  };
}

function toPromoDraft(promo: BonusPromotion): PromoDraft {
  return {
    code: promo.code,
    name: promo.name,
    mode: promo.percentBps !== null ? 'PERCENT' : 'FIXED',
    value:
      promo.percentBps !== null
        ? String(promo.percentBps / 100)
        : promo.fixedAmount
          ? String(Number(promo.fixedAmount) / 100)
          : '',
    maxBonus: promo.maxBonus ? String(Number(promo.maxBonus) / 100) : '',
    minDeposit: promo.minDeposit ? String(Number(promo.minDeposit) / 100) : '',
    multiplier: String(promo.wageringMultiplier),
    expiresInDays: String(promo.expiresInDays),
    maxRedemptions: promo.maxRedemptions === null ? '' : String(promo.maxRedemptions),
    enabled: promo.enabled,
    startsAt: toLocalInput(promo.startsAt),
    endsAt: toLocalInput(promo.endsAt),
  };
}

function PromoCodes() {
  const [promos, setPromos] = useState<BonusPromotion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BonusPromotion | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setPromos(await fetchBonusPromotions());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load promo codes.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (promo: BonusPromotion) => {
    try {
      await updateBonusPromotion(promo.id, { enabled: !promo.enabled });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update the promo code.');
    }
  };

  const remove = async (promo: BonusPromotion) => {
    if (!window.confirm(`Delete promo code ${promo.code}?`)) return;
    try {
      await deleteBonusPromotion(promo.id);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete the promo code.');
    }
  };

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line/60 px-4 py-3">
        <div>
          <SectionTitle>Promo codes</SectionTitle>
          <p className="mt-1 text-[11px] text-muted">
            Fixed codes grant a set amount; percentage codes apply to deposits credited since the
            code opened, capped by the maximum.
          </p>
        </div>
        <Button size="sm" variant="gold" onClick={() => setCreating(true)}>
          New code
        </Button>
      </div>
      {error ? (
        <div className="px-4 pt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {promos === null ? (
        <LoadingBlock />
      ) : promos.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No promo codes" body="Create a code to reward deposits or run a campaign." />
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {promos.map((promo) => (
            <li key={promo.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-md bg-raised px-2 py-0.5 font-mono text-xs font-bold tracking-wider">
                    {promo.code}
                  </span>
                  <Pill tone={promo.enabled ? 'mint' : 'neutral'}>{promo.enabled ? 'live' : 'off'}</Pill>
                  <Pill tone="gold">{promo.wageringMultiplier}× wagering</Pill>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {promo.percentBps !== null
                    ? `${(promo.percentBps / 100).toFixed(0)}% of deposits${
                        promo.maxBonus ? ` · cap ${formatCredits(promo.maxBonus)}` : ''
                      }`
                    : `${formatCredits(promo.fixedAmount ?? '0')} ETB`}
                  {promo.minDeposit ? ` · min deposit ${formatStake(promo.minDeposit)}` : ''} ·{' '}
                  {promo.redemptionCount}/{promo.maxRedemptions ?? '∞'} redeemed · expires in{' '}
                  {promo.expiresInDays}d
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" variant="outline" onClick={() => setEditing(promo)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void toggle(promo)}>
                  {promo.enabled ? 'Pause' : 'Enable'}
                </Button>
                <Button size="sm" variant="danger" onClick={() => void remove(promo)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <PromoSheet
        open={creating || editing !== null}
        promo={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          void load();
        }}
      />
    </Panel>
  );
}

function PromoSheet({
  open,
  promo,
  onClose,
  onSaved,
}: {
  open: boolean;
  promo: BonusPromotion | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<PromoDraft>(emptyPromo());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(promo ? toPromoDraft(promo) : emptyPromo());
    setError(null);
  }, [open, promo]);

  if (!open) return null;
  const patch = (next: Partial<PromoDraft>) => setDraft({ ...draft, ...next });

  const save = async () => {
    setError(null);
    const code = draft.code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
      setError('The code must be 3–32 letters, digits, - or _.');
      return;
    }
    if (!draft.name.trim()) {
      setError('Give the promotion a name.');
      return;
    }
    const value = Number(draft.value);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter the bonus value.');
      return;
    }
    const mult = Number(draft.multiplier);
    const days = Number(draft.expiresInDays);
    if (!Number.isInteger(mult) || mult < 1 || mult > 100) {
      setError('The wagering multiplier must be 1–100.');
      return;
    }
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setError('The expiry must be 1–365 days.');
      return;
    }

    let fixedAmount: number | null = null;
    let percentBps: number | null = null;
    if (draft.mode === 'PERCENT') {
      if (value > 100) {
        setError('A percentage cannot exceed 100%.');
        return;
      }
      percentBps = Math.round(value * 100);
    } else {
      fixedAmount = creditsToMinor(draft.value);
      if (fixedAmount === null) {
        setError('The amount must look like 25 or 12.50.');
        return;
      }
    }
    const maxBonus = draft.maxBonus.trim() ? creditsToMinor(draft.maxBonus) : null;
    const minDeposit = draft.minDeposit.trim() ? creditsToMinor(draft.minDeposit) : null;
    if (maxBonus === null && draft.maxBonus.trim()) {
      setError('The cap must look like 100 or 99.50.');
      return;
    }
    if (minDeposit === null && draft.minDeposit.trim()) {
      setError('The minimum deposit must look like 50 or 49.50.');
      return;
    }
    const maxRedemptions = draft.maxRedemptions.trim() ? Number(draft.maxRedemptions) : null;
    if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) {
      setError('The redemption cap must be a positive whole number.');
      return;
    }

    const body = {
      code,
      name: draft.name.trim(),
      percentBps,
      fixedAmount,
      maxBonus,
      minDeposit,
      wageringMultiplier: mult,
      expiresInDays: days,
      enabled: draft.enabled,
      startsAt: draft.startsAt ? new Date(draft.startsAt).toISOString() : null,
      endsAt: draft.endsAt ? new Date(draft.endsAt).toISOString() : null,
      maxRedemptions,
    };
    setBusy(true);
    try {
      if (promo) await updateBonusPromotion(promo.id, body);
      else await createBonusPromotion(body);
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the promo code.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open title={promo ? `Edit ${promo.code}` : 'New promo code'} onClose={onClose}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Code"
            value={draft.code}
            onChange={(event) => patch({ code: event.target.value.toUpperCase() })}
            placeholder="BINGO251"
          />
          <Input
            label="Name"
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder="Welcome bonus"
          />
          <Select
            label="Reward type"
            value={draft.mode}
            onChange={(event) => patch({ mode: event.target.value as 'FIXED' | 'PERCENT' })}
          >
            <option value="FIXED">Fixed amount</option>
            <option value="PERCENT">% of deposits</option>
          </Select>
          <Input
            label={draft.mode === 'PERCENT' ? 'Percentage' : 'Amount (ETB)'}
            inputMode="decimal"
            value={draft.value}
            onChange={(event) => patch({ value: event.target.value })}
          />
          {draft.mode === 'PERCENT' ? (
            <>
              <Input
                label="Minimum deposit (ETB)"
                inputMode="decimal"
                value={draft.minDeposit}
                onChange={(event) => patch({ minDeposit: event.target.value })}
              />
              <Input
                label="Maximum bonus (ETB)"
                inputMode="decimal"
                value={draft.maxBonus}
                onChange={(event) => patch({ maxBonus: event.target.value })}
              />
            </>
          ) : null}
          <Input
            label="Wagering multiplier"
            inputMode="numeric"
            value={draft.multiplier}
            onChange={(event) => patch({ multiplier: event.target.value })}
            hint="Play-through = bonus × multiplier."
          />
          <Input
            label="Expires in (days)"
            inputMode="numeric"
            value={draft.expiresInDays}
            onChange={(event) => patch({ expiresInDays: event.target.value })}
          />
          <Input
            label="Max redemptions"
            inputMode="numeric"
            value={draft.maxRedemptions}
            onChange={(event) => patch({ maxRedemptions: event.target.value })}
            hint="Blank = unlimited."
          />
          <Select
            label="Enabled"
            value={draft.enabled ? 'ON' : 'OFF'}
            onChange={(event) => patch({ enabled: event.target.value === 'ON' })}
          >
            <option value="ON">Live</option>
            <option value="OFF">Paused</option>
          </Select>
          <Input
            label="Starts at"
            type="datetime-local"
            value={draft.startsAt}
            onChange={(event) => patch({ startsAt: event.target.value })}
          />
          <Input
            label="Ends at"
            type="datetime-local"
            value={draft.endsAt}
            onChange={(event) => patch({ endsAt: event.target.value })}
          />
        </div>
        <div className="rounded-xl border border-gold/25 bg-gold/5 px-3 py-2 text-[11px] text-muted">
          A percentage code uses deposits credited since the code started; the cap protects the
          platform from oversized payouts.
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button className="w-full" loading={busy} onClick={() => void save()}>
          {promo ? 'Save promo code' : 'Create promo code'}
        </Button>
      </div>
    </Sheet>
  );
}

function GrantedBonuses() {
  const [rows, setRows] = useState<BonusWithPlayer[] | null>(null);
  const [page, setPage] = useState<PageMeta | null>(null);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);

  const load = useCallback(async (nextPage: number) => {
    try {
      const result = await fetchAdminBonuses({ page: nextPage });
      setRows(result.data);
      setPage(result.page);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load bonuses.');
    }
  }, []);

  useEffect(() => {
    void load(index);
  }, [load, index]);

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line/60 px-4 py-3">
        <div>
          <SectionTitle>Granted bonuses</SectionTitle>
          <p className="mt-1 text-[11px] text-muted">
            Admin grants use the programme default multiplier and expiry unless overridden.
          </p>
        </div>
        <Button size="sm" variant="gold" onClick={() => setGranting(true)}>
          Grant bonus
        </Button>
      </div>
      {error ? (
        <div className="px-4 pt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {rows === null ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No bonuses granted yet" />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-line/60">
            {rows.map((bonus) => (
              <li key={bonus.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-sm font-semibold">{bonus.playerName}</p>
                    <Pill tone={STATUS_TONE[bonus.status] ?? 'neutral'}>
                      {bonus.status.toLowerCase()}
                    </Pill>
                    <Pill tone="neutral">{bonus.kind === 'PROMO_CODE' ? 'code' : 'grant'}</Pill>
                  </div>
                  <p className="text-[11px] text-muted">
                    {bonus.playerPhone ?? '—'} · {formatCredits(bonus.amount)} ETB · wagered{' '}
                    {formatStake(bonus.wagered)}/{formatStake(bonus.target)} ·{' '}
                    {formatDateTime(bonus.createdAt)}
                  </p>
                </div>
                <p className="text-[11px] text-muted">
                  {bonus.completedAt ? `released ${formatDateTime(bonus.completedAt)}` : `expires ${formatDateTime(bonus.expiresAt)}`}
                </p>
              </li>
            ))}
          </ul>
          <div className="px-4 py-3">
            <Pager page={page} onPage={setIndex} />
          </div>
        </>
      )}
      <GrantSheet
        open={granting}
        onClose={() => setGranting(false)}
        onSaved={() => {
          setGranting(false);
          void load(index);
        }}
      />
    </Panel>
  );
}

function GrantSheet({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [userId, setUserId] = useState('');
  const [amount, setAmount] = useState('');
  const [multiplier, setMultiplier] = useState('');
  const [days, setDays] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUserId('');
    setAmount('');
    setMultiplier('');
    setDays('');
    setNote('');
    setError(null);
  }, [open]);

  if (!open) return null;

  const save = async () => {
    setError(null);
    const minor = creditsToMinor(amount);
    if (!/^[0-9a-f-]{36}$/i.test(userId.trim())) {
      setError('Paste the player UUID from the Users tab.');
      return;
    }
    if (minor === null) {
      setError('The amount must look like 25 or 12.50.');
      return;
    }
    const mult = multiplier.trim() ? Number(multiplier) : undefined;
    if (mult !== undefined && (!Number.isInteger(mult) || mult < 1 || mult > 100)) {
      setError('The multiplier must be 1–100.');
      return;
    }
    const expiry = days.trim() ? Number(days) : undefined;
    if (expiry !== undefined && (!Number.isInteger(expiry) || expiry < 1 || expiry > 365)) {
      setError('The expiry must be 1–365 days.');
      return;
    }
    setBusy(true);
    try {
      await grantBonus({
        userId: userId.trim(),
        amount: minor,
        multiplier: mult,
        expiresInDays: expiry,
        note: note.trim() || undefined,
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not grant the bonus.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open title="Grant a bonus" onClose={onClose}>
      <div className="space-y-3">
        <Input
          label="Player UUID"
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
        />
        <Input
          label="Amount (ETB)"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Wagering multiplier"
            inputMode="numeric"
            value={multiplier}
            onChange={(event) => setMultiplier(event.target.value)}
            hint="Blank = programme default."
          />
          <Input
            label="Expires in (days)"
            inputMode="numeric"
            value={days}
            onChange={(event) => setDays(event.target.value)}
            hint="Blank = programme default."
          />
        </div>
        <Input label="Internal note" value={note} onChange={(event) => setNote(event.target.value)} />
        <div className="rounded-xl border border-line bg-raised/40 px-3 py-2 text-[11px] text-muted">
          The player must clear play-through of amount × multiplier before the grant becomes
          withdrawable. The bonus cannot be staked directly.
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button className="w-full" loading={busy} onClick={() => void save()}>
          Grant bonus
        </Button>
      </div>
    </Sheet>
  );
}

function TopReferrers() {
  const [rows, setRows] = useState<AdminReferralRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setRows(await fetchAdminReferrals());
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Could not load referral payouts.');
      }
    })();
  }, []);

  return (
    <Panel className="overflow-hidden">
      <div className="border-b border-line/60 px-4 py-3">
        <SectionTitle>Top referrers</SectionTitle>
        <p className="mt-1 text-[11px] text-muted">Commission paid from rake, by referrer.</p>
      </div>
      {error ? (
        <div className="px-4 pt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {rows === null ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No referral commission paid yet" />
        </div>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-muted">
            <tr className="border-b border-line/60">
              <th className="px-4 py-2 font-semibold">Referrer</th>
              <th className="px-2 py-2 font-semibold">Payments</th>
              <th className="px-2 py-2 font-semibold">Rake base</th>
              <th className="px-4 py-2 text-right font-semibold">Earned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.referrerId} className="border-b border-line/40 last:border-0">
                <td className="px-4 py-2">
                  <p className="font-semibold text-text">{row.referrerName ?? '—'}</p>
                  <p className="text-[10px] text-muted">{row.referrerPhone ?? row.referrerId}</p>
                </td>
                <td className="px-2 py-2 text-muted">{row.payments}</td>
                <td className="px-2 py-2 text-muted">{formatCredits(row.rakeBase)}</td>
                <td className="px-4 py-2 text-right font-semibold text-mint">
                  {formatCredits(row.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
