'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  createPaymentAccount,
  fetchAgentProfile,
  fetchDepositProviders,
  fetchPaymentAccounts,
  updateAgentSettings,
  updatePaymentAccount,
} from '@/lib/api';
import { PAYMENT_METHODS, creditsToMinor, minorToCreditsInput } from '@/lib/format';
import { useSession } from '@/components/session';
import {
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Panel,
  Pill,
  Select,
  Sheet,
  Spinner,
} from '@/components/ui';
import type { Agent, DepositProvider, PaymentAccount, PaymentMethod } from '@/lib/types';

interface AccountDraft {
  id: string | null;
  method: PaymentMethod;
  provider: string;
  accountName: string;
  accountNumber: string;
  instructions: string;
  minAmount: string;
  maxAmount: string;
}

const EMPTY_DRAFT: AccountDraft = {
  id: null,
  method: 'MOBILE_MONEY',
  provider: '',
  accountName: '',
  accountNumber: '',
  instructions: '',
  minAmount: '',
  maxAmount: '',
};

export function AgentSettings() {
  const { setAgent } = useSession();
  const [profile, setProfile] = useState<Agent | null>(null);
  const [accounts, setAccounts] = useState<PaymentAccount[] | null>(null);
  const [providers, setProviders] = useState<DepositProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [autoEnabled, setAutoEnabled] = useState(false);
  const [threshold, setThreshold] = useState('');
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);

  const [draft, setDraft] = useState<AccountDraft | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [profileResult, accountList] = await Promise.all([
        fetchAgentProfile(),
        fetchPaymentAccounts(),
      ]);
      setProfile(profileResult.agent);
      setAgent(profileResult.agent);
      setAutoEnabled(profileResult.agent.autoDepositEnabled);
      setThreshold(minorToCreditsInput(profileResult.agent.autoDepositThreshold));
      setAccounts(accountList);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load settings.');
    }
  }, [setAgent]);

  useEffect(() => {
    void load();
    fetchDepositProviders()
      .then(setProviders)
      .catch(() => undefined);
  }, [load]);

  const saveAuto = async () => {
    setAutoError(null);
    let minor: number | null = null;
    if (autoEnabled) {
      minor = creditsToMinor(threshold);
      if (minor === null) {
        setAutoError('Enter a threshold like 50 or 12.50.');
        return;
      }
    }
    setAutoBusy(true);
    try {
      const next = await updateAgentSettings(
        autoEnabled
          ? { autoDepositEnabled: true, autoDepositThreshold: minor }
          : { autoDepositEnabled: false },
      );
      setProfile(next);
      setAgent(next);
      setNotice(
        next.autoDepositEnabled
          ? 'Automatic verification is on for verified receipts within your threshold.'
          : 'Automatic verification is off. You will confirm every deposit.',
      );
    } catch (caught) {
      setAutoError(caught instanceof ApiError ? caught.message : 'Could not save the setting.');
    } finally {
      setAutoBusy(false);
    }
  };

  const toggleAccount = async (account: PaymentAccount) => {
    setBusy(true);
    setError(null);
    try {
      await updatePaymentAccount(account.id, { isActive: !account.isActive });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update the account.');
    } finally {
      setBusy(false);
    }
  };

  const openCreate = () => {
    setDraft({ ...EMPTY_DRAFT });
    setDraftError(null);
  };

  const openEdit = (account: PaymentAccount) => {
    setDraft({
      id: account.id,
      method: account.method,
      provider: account.provider ?? '',
      accountName: account.accountName,
      accountNumber: account.accountNumber,
      instructions: account.instructions ?? '',
      minAmount: minorToCreditsInput(account.minAmount),
      maxAmount: minorToCreditsInput(account.maxAmount),
    });
    setDraftError(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    setDraftError(null);
    if (!draft.accountName.trim() || !draft.accountNumber.trim()) {
      setDraftError('Account name and number are required.');
      return;
    }
    let minMinor: number | null = null;
    let maxMinor: number | null = null;
    if (draft.minAmount.trim()) {
      minMinor = creditsToMinor(draft.minAmount);
      if (minMinor === null) {
        setDraftError('The minimum must look like 10 or 7.50.');
        return;
      }
    }
    if (draft.maxAmount.trim()) {
      maxMinor = creditsToMinor(draft.maxAmount);
      if (maxMinor === null) {
        setDraftError('The maximum must look like 100 or 99.50.');
        return;
      }
    }
    if (minMinor !== null && maxMinor !== null && minMinor > maxMinor) {
      setDraftError('The minimum cannot be greater than the maximum.');
      return;
    }
    setDraftBusy(true);
    try {
      const payload = {
        method: draft.method,
        provider: draft.provider || null,
        accountName: draft.accountName.trim(),
        accountNumber: draft.accountNumber.trim(),
        instructions: draft.instructions.trim() || null,
        minAmount: minMinor,
        maxAmount: maxMinor,
      };
      if (draft.id) await updatePaymentAccount(draft.id, payload);
      else await createPaymentAccount(payload);
      setDraft(null);
      setNotice('Payment account saved.');
      await load();
    } catch (caught) {
      setDraftError(caught instanceof ApiError ? caught.message : 'Could not save the account.');
    } finally {
      setDraftBusy(false);
    }
  };

  const providerName = (code: string | null | undefined) =>
    code ? providers.find((item) => item.code === code)?.name ?? code : null;

  const currentThreshold = profile?.autoDepositThreshold;

  return (
    <div className="space-y-3">
      {notice ? (
        <p className="rounded-xl border border-mint/30 bg-mint/10 px-3 py-2 text-xs text-mint">{notice}</p>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Panel className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
              Automatic deposit verification
            </h2>
            <p className="mt-1 text-[11px] text-muted">
              When a payer submits a bank receipt for you and the amount is within your threshold, the
              platform verifies it and credits the player without you touching the code. Larger deposits
              still wait for your credit action.
            </p>
          </div>
          <Pill tone={autoEnabled ? 'mint' : 'neutral'}>{autoEnabled ? 'on' : 'off'}</Pill>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Select
            label="Mode"
            value={autoEnabled ? 'ON' : 'OFF'}
            onChange={(event) => setAutoEnabled(event.target.value === 'ON')}
          >
            <option value="OFF">Manual — I credit every deposit</option>
            <option value="ON">Automatic up to a threshold</option>
          </Select>
          <Input
            label="Threshold (ETB)"
            inputMode="decimal"
            placeholder="50"
            disabled={!autoEnabled}
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            hint={
              currentThreshold
                ? `Currently ${minorToCreditsInput(currentThreshold)} ETB`
                : 'Deposits at or below this amount verify automatically.'
            }
          />
        </div>
        {autoError ? (
          <div className="mt-3">
            <ErrorNote>{autoError}</ErrorNote>
          </div>
        ) : null}
        <Button className="mt-3 w-full" loading={autoBusy} onClick={() => void saveAuto()}>
          Save verification settings
        </Button>
      </Panel>

      <Panel className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
              Payment accounts
            </h2>
            <p className="mt-1 text-[11px] text-muted">
              Players pay into these accounts. The receiving number is matched against the bank receipt
              before a deposit is auto-credited.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={openCreate}>
            Add account
          </Button>
        </div>

        {accounts === null ? (
          <div className="flex justify-center py-6">
            <Spinner className="h-5 w-5 text-mint" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="No payment accounts"
              body="Add the mobile-money or bank account players should pay into."
            />
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {accounts.map((account) => (
              <li key={account.id} className="rounded-xl border border-line/70 bg-ink/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {account.accountName}{' '}
                      <span className="font-mono text-xs font-normal text-muted">
                        {account.accountNumber}
                      </span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {PAYMENT_METHODS.find((item) => item.value === account.method)?.label}
                      {account.provider ? ` · ${providerName(account.provider)}` : ''}
                      {account.minAmount || account.maxAmount
                        ? ` · ${account.minAmount ? minorToCreditsInput(account.minAmount) : '0'}–${
                            account.maxAmount ? minorToCreditsInput(account.maxAmount) : '∞'
                          } ETB`
                        : ''}
                    </p>
                    {account.instructions ? (
                      <p className="mt-1 text-[11px] text-text/80">{account.instructions}</p>
                    ) : null}
                  </div>
                  <Pill tone={account.isActive === false ? 'danger' : 'mint'}>
                    {account.isActive === false ? 'inactive' : 'active'}
                  </Pill>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => openEdit(account)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant={account.isActive === false ? 'ghost' : 'danger'}
                    loading={busy}
                    onClick={() => void toggleAccount(account)}
                  >
                    {account.isActive === false ? 'Reactivate' : 'Deactivate'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Sheet
        open={draft !== null}
        title={draft?.id ? 'Edit payment account' : 'New payment account'}
        onClose={() => setDraft(null)}
      >
        {draft ? (
          <div className="space-y-3">
            <Select
              label="Method"
              value={draft.method}
              onChange={(event) =>
                setDraft({ ...draft, method: event.target.value as PaymentMethod })
              }
            >
              {PAYMENT_METHODS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <Select
              label="Provider (optional)"
              value={draft.provider}
              onChange={(event) => setDraft({ ...draft, provider: event.target.value })}
            >
              <option value="">Any / not linked</option>
              {providers.map((provider) => (
                <option key={provider.code} value={provider.code}>
                  {provider.name}
                </option>
              ))}
            </Select>
            <Input
              label="Account name"
              value={draft.accountName}
              onChange={(event) => setDraft({ ...draft, accountName: event.target.value })}
            />
            <Input
              label="Account number"
              value={draft.accountNumber}
              onChange={(event) => setDraft({ ...draft, accountNumber: event.target.value })}
              hint="Mobile money number or bank account players pay into."
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Min ETB (optional)"
                inputMode="decimal"
                value={draft.minAmount}
                onChange={(event) => setDraft({ ...draft, minAmount: event.target.value })}
              />
              <Input
                label="Max ETB (optional)"
                inputMode="decimal"
                value={draft.maxAmount}
                onChange={(event) => setDraft({ ...draft, maxAmount: event.target.value })}
              />
            </div>
            <Input
              label="Instructions (optional)"
              value={draft.instructions}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              hint="Shown to players on the deposit page."
            />
            {draftError ? <ErrorNote>{draftError}</ErrorNote> : null}
            <Button className="w-full" loading={draftBusy} onClick={() => void saveDraft()}>
              Save account
            </Button>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
