'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  checkReceipt,
  fetchReceiptCheckerProviders,
  type ReceiptLookupInput,
} from '@/lib/api';
import { Button, ErrorNote, Input, Panel, Pill, Select, Spinner } from '@/components/ui';
import type { DepositProvider, ReceiptLookupResult, ReceiptLookupStatus } from '@/lib/types';

const MAX_PAYLOAD_BYTES = 4_500_000;

const STATUS_TONE: Record<ReceiptLookupStatus, 'mint' | 'danger' | 'gold' | 'warn' | 'neutral'> = {
  VERIFIED: 'mint',
  FAILED: 'danger',
  NOT_FOUND: 'danger',
  NOT_MATCHED: 'danger',
  NOT_VERIFIED: 'warn',
  UNREACHABLE: 'gold',
  UNSUPPORTED: 'neutral',
  INVALID_REFERENCE: 'danger',
};

const PAYLOAD_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
};

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function money(value: number | undefined, currency?: string): string | undefined {
  if (value === undefined) return undefined;
  return `${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency ?? 'ETB'}`;
}

function DetailField({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9px] font-bold uppercase tracking-widest text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-xs text-text">{value || '—'}</dd>
    </div>
  );
}

/**
 * Read-only receipt lookup shared by the staff consoles and the agent portal.
 * It reads the bank's receipt by reference; no deposit is created or changed.
 */
export function ReceiptChecker({ scope }: { scope: 'staff' | 'agent' }) {
  const [providers, setProviders] = useState<DepositProvider[] | null>(null);
  const [providerCode, setProviderCode] = useState('');
  const [reference, setReference] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [attachment, setAttachment] = useState<{
    contentType: string;
    base64: string;
    name: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReceiptLookupResult | null>(null);

  const loadProviders = useCallback(async () => {
    try {
      const rows = await fetchReceiptCheckerProviders(scope);
      setProviders(rows);
      setProviderCode((current) => current || rows.find((row) => row.enabled)?.code || '');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the providers.');
      setProviders([]);
    }
  }, [scope]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const selected = useMemo(
    () => providers?.find((provider) => provider.code === providerCode) ?? null,
    [providers, providerCode],
  );

  const wallets = (providers ?? []).filter((provider) => provider.method === 'MOBILE_MONEY');
  const others = (providers ?? []).filter((provider) => provider.method !== 'MOBILE_MONEY');

  const pickAttachment = async (file: File | null) => {
    setError(null);
    if (!file) {
      setAttachment(null);
      return;
    }
    if (file.size > MAX_PAYLOAD_BYTES) {
      setError('That file is too large. Attach the saved receipt page or PDF, up to 4.5 MB.');
      return;
    }
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    const contentType = file.type || PAYLOAD_TYPES[extension] || 'application/octet-stream';
    try {
      const base64 = await fileToBase64(file);
      setAttachment({ contentType, base64, name: file.name });
    } catch {
      setError('That file could not be read.');
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) {
      setError('Choose a provider first.');
      return;
    }
    if (!reference.trim()) {
      setError('Enter the receipt reference or transaction ID.');
      return;
    }
    const body: ReceiptLookupInput = {
      providerCode: selected.code,
      reference: reference.trim(),
    };
    if (selected.accountDigits && accountNumber.trim()) body.accountNumber = accountNumber.trim();
    if (selected.requiresPhone) body.phoneNumber = phoneNumber.trim();
    if (attachment) {
      body.payload = { contentType: attachment.contentType, bodyBase64: attachment.base64 };
    }

    setBusy(true);
    setError(null);
    try {
      setResult(await checkReceipt(scope, body));
    } catch (caught) {
      setResult(null);
      setError(caught instanceof ApiError ? caught.message : 'The receipt could not be checked.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Panel className="p-4">
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted">
          Receipt checker
        </h2>
        <p className="mt-1 text-xs text-muted">
          Read what the bank shows for a receipt. This does not create a deposit or change one.
        </p>

        <form className="mt-3 space-y-3" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Provider"
              value={providerCode}
              onChange={(event) => {
                setProviderCode(event.target.value);
                setResult(null);
                setAccountNumber('');
                setPhoneNumber('');
              }}
            >
              <option value="">Choose a provider</option>
              {wallets.length > 0 ? (
                <optgroup label="Mobile wallets">
                  {wallets.map((provider) => (
                    <option key={provider.code} value={provider.code}>
                      {provider.supported ? provider.name : `${provider.name} (manual)`}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {others.length > 0 ? (
                <optgroup label="Banks">
                  {others.map((provider) => (
                    <option key={provider.code} value={provider.code}>
                      {provider.supported ? provider.name : `${provider.name} (manual)`}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Select>

            <Input
              label="Reference / transaction ID"
              placeholder="Paste the receipt link or the reference"
              hint={selected?.refHint ?? undefined}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />

            {selected?.requiresPhone ? (
              <Input
                label="Payer phone"
                inputMode="tel"
                placeholder="09XXXXXXXX"
                value={phoneNumber}
                onChange={(event) => setPhoneNumber(event.target.value)}
              />
            ) : null}

            {selected?.accountDigits ? (
              <Input
                label="Receiving account"
                inputMode="numeric"
                hint={`Optional. The last ${selected.accountDigits} digits are enough.`}
                value={accountNumber}
                onChange={(event) => setAccountNumber(event.target.value)}
              />
            ) : null}
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
              Bank response (optional)
            </span>
            <input
              type="file"
              accept=".pdf,.html,.htm,.json,application/pdf,text/html,application/json"
              onChange={(event) => void pickAttachment(event.target.files?.[0] ?? null)}
              className="block w-full cursor-pointer rounded-xl border border-line bg-ink/60 px-3 py-2 text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-raised file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-text"
            />
            <p className="mt-1 text-[11px] text-muted">
              Attach the saved receipt page, the M-Pesa PDF, or the bank's JSON response. A
              screenshot cannot be read.
            </p>
            {attachment ? (
              <p className="mt-1 text-[11px] text-mint">Attached: {attachment.name}</p>
            ) : null}
            {selected?.clientSide ? (
              <p className="mt-1 text-[11px] text-gold">
                {selected.name} answers only Ethiopian IPs. Open the receipt link from an
                Ethiopian connection, or attach the saved page or PDF.
              </p>
            ) : null}
          </div>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="flex justify-end">
            <Button type="submit" loading={busy} disabled={!selected}>
              Check receipt
            </Button>
          </div>
        </form>
      </Panel>

      {busy ? (
        <Panel className="p-4">
          <div className="flex items-center gap-3 text-xs text-muted">
            <Spinner className="h-4 w-4 text-mint" />
            Checking with {selected?.name ?? 'the provider'}…
          </div>
        </Panel>
      ) : null}

      {result && !busy ? <ReceiptResultCard result={result} /> : null}
    </div>
  );
}

function ReceiptResultCard({ result }: { result: ReceiptLookupResult }) {
  const parsed = result.parsed;
  const currency = parsed?.currency ?? 'ETB';
  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line/60 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-semibold">{result.provider.name}</p>
            <Pill tone={STATUS_TONE[result.status]}>{result.status.toLowerCase().replaceAll('_', ' ')}</Pill>
            <span className="text-[10px] uppercase tracking-wide text-muted">
              {result.source.toLowerCase()}
            </span>
          </div>
          <p className="mt-0.5 break-all font-mono text-[11px] text-muted">{result.reference}</p>
          <p className="mt-1 text-xs text-text/80">{result.message}</p>
        </div>
        {result.url ? (
          <a
            href={result.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-line px-2.5 py-1.5 text-[11px] font-semibold text-mint hover:border-mint/50"
          >
            Open bank receipt
          </a>
        ) : null}
      </div>

      {result.usedBy ? (
        <p className="border-b border-line/60 bg-danger/10 px-4 py-2 text-xs text-danger">
          This reference is already attached to deposit{' '}
          <span className="font-mono font-semibold">{result.usedBy.depositCode ?? '—'}</span>
          {result.usedBy.depositStatus ? ` (${result.usedBy.depositStatus.toLowerCase()})` : ''}.
          A receipt can fund one deposit only.
        </p>
      ) : null}

      {parsed ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-3">
          <DetailField label="Amount" value={money(parsed.amount, currency)} />
          <DetailField label="Transaction status" value={parsed.transactionStatus} />
          <DetailField label="Date" value={parsed.date} />
          <DetailField label="Sender" value={parsed.senderName} />
          <DetailField label="Sender account" value={parsed.senderAccount} />
          <DetailField label="Receiver" value={parsed.receiverName} />
          <DetailField label="Receiver account" value={parsed.receiverAccount} />
          <DetailField label="Transaction type" value={parsed.transactionType} />
          <DetailField label="Settled amount" value={money(parsed.settledAmount, currency)} />
          <DetailField label="Service fee" value={money(parsed.serviceFee, currency)} />
          <DetailField label="Total paid" value={money(parsed.totalPaid, currency)} />
          <DetailField label="Invoice no." value={parsed.invoiceNumber} />
          <DetailField label="Order ID" value={parsed.orderId} />
          <DetailField label="Branch" value={parsed.branch} />
          <DetailField label="Channel" value={parsed.paymentChannel} />
          <DetailField label="Amount in words" value={parsed.amountInWords} />
          <DetailField label="Reason" value={parsed.reason} />
        </dl>
      ) : (
        <p className="px-4 py-3 text-xs text-muted">
          The bank did not return readable receipt fields for this reference.
        </p>
      )}

      <p className="border-t border-line/60 px-4 py-2 text-[10px] text-muted">
        Checked by {result.source.toLowerCase()} at {new Date(result.checkedAt).toLocaleString()} ·
        nothing was stored
      </p>
    </Panel>
  );
}
