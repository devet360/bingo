'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  fetchAdminBingoRooms,
  updateAdminBingoRoom,
  type BingoRoomPatch,
} from '@/lib/api';
import { creditsToMinor, formatCredits, formatStake, minorToCreditsInput } from '@/lib/format';
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
import type { AdminBingoRoom } from '@/lib/types';
import { LoadingBlock, SectionTitle } from './shared';

type RoomStatus = 'OPEN' | 'MAINTENANCE' | 'CLOSED';

interface RoomDraft {
  name: string;
  status: RoomStatus;
  stakePerCard: string;
  fixedPrize: string;
  maxCardsPerPlayer: string;
  minPlayersToStart: string;
  rakeBps: string;
  purchaseWindowSecs: string;
  lockWindowSecs: string;
  drawIntervalMs: string;
  claimWindowSecs: string;
  pressWindowSecs: string;
  autoDaubEnabled: boolean;
  allowAutoBingoPress: boolean;
  runnerUpEnabled: boolean;
  runnerUpPrize: string;
  runnerUpWindowSecs: string;
  bonusTiers: string;
}

function toDraft(room: AdminBingoRoom['room']): RoomDraft {
  return {
    name: room.name,
    status: (room.status as RoomStatus) ?? 'OPEN',
    stakePerCard: minorToCreditsInput(room.stakePerCard),
    fixedPrize: minorToCreditsInput(room.fixedPrize),
    maxCardsPerPlayer: String(room.maxCardsPerPlayer),
    minPlayersToStart: String(room.minPlayersToStart),
    rakeBps: String(room.rakeBps),
    purchaseWindowSecs: String(room.timings.purchaseWindowSecs),
    lockWindowSecs: String(room.timings.lockWindowSecs),
    drawIntervalMs: String(room.timings.drawIntervalMs),
    claimWindowSecs: String(room.timings.claimWindowSecs),
    pressWindowSecs: String(room.timings.pressWindowSecs),
    autoDaubEnabled: room.autoDaubEnabled,
    allowAutoBingoPress: room.allowAutoBingoPress,
    runnerUpEnabled: room.runnerUpEnabled,
    runnerUpPrize: minorToCreditsInput(room.runnerUpPrize),
    runnerUpWindowSecs: String(room.runnerUpWindowSecs),
    bonusTiers: room.bonusTiers.map((tier) => `${tier.minCards}:${tier.bonusCards}`).join(', '),
  };
}

function parseBonusTiers(
  input: string,
): Array<{ minCards: number; bonusCards: number }> | null {
  const text = input.trim();
  if (!text) return [];
  const tiers: Array<{ minCards: number; bonusCards: number }> = [];
  for (const part of text.split(',')) {
    const match = /^\s*(\d{1,3})\s*[:=]\s*(\d{1,3})\s*$/.exec(part);
    if (!match) return null;
    const minCards = Number(match[1]);
    const bonusCards = Number(match[2]);
    if (minCards < 1 || minCards > 100 || bonusCards > 100) return null;
    tiers.push({ minCards, bonusCards });
  }
  return tiers.length > 10 ? null : tiers;
}

function intField(input: string): number | null {
  const text = input.trim();
  if (!/^\d{1,7}$/.test(text)) return null;
  return Number(text);
}

function YesNo({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  hint?: string;
}) {
  return (
    <div>
      <Select
        label={label}
        value={value ? 'ON' : 'OFF'}
        onChange={(event) => onChange(event.target.value === 'ON')}
      >
        <option value="ON">On</option>
        <option value="OFF">Off</option>
      </Select>
      {hint ? <p className="mt-1 text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

const VARIANT_LABEL: Record<string, string> = {
  US_75: '75-ball',
  UK_90: '90-ball',
};

export function BingoRoomsTab() {
  const [rooms, setRooms] = useState<AdminBingoRoom[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<AdminBingoRoom | null>(null);

  const load = useCallback(async () => {
    try {
      setRooms(await fetchAdminBingoRooms());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load bingo rooms.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel className="overflow-hidden">
      <div className="border-b border-line/60 px-4 py-3">
        <SectionTitle>Bingo rooms</SectionTitle>
        <p className="mt-1 text-[11px] text-muted">
          Main rooms are slow 75-ball games with a guaranteed prize, manual marking and an optional
          runner-up race. Fast rooms draw quickly, auto-daub and pay a share of the pot.
        </p>
      </div>
      {error ? (
        <div className="p-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {rooms === null ? (
        <LoadingBlock />
      ) : rooms.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No bingo rooms configured" />
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {rooms.map((entry) => {
            const { room, round } = entry;
            return (
              <li key={room.code} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-sm font-semibold">{room.name}</p>
                    <Pill tone={room.mode === 'MAIN' ? 'gold' : 'blue'}>
                      {room.mode.toLowerCase()}
                    </Pill>
                    <Pill
                      tone={
                        room.status === 'OPEN'
                          ? 'mint'
                          : room.status === 'MAINTENANCE'
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {room.status.toLowerCase()}
                    </Pill>
                    {room.runnerUpEnabled ? <Pill tone="mint">runner-up</Pill> : null}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {room.code} · {VARIANT_LABEL[room.variant] ?? room.variant} ·{' '}
                    {formatStake(room.stakePerCard)} ETB per card · max {room.maxCardsPerPlayer}{' '}
                    cards
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {room.fixedPrize
                      ? `${formatCredits(room.fixedPrize)} ETB fixed prize`
                      : 'Pot-funded prize'}
                    {room.runnerUpEnabled
                      ? ` · runner-up ${formatCredits(room.runnerUpPrize)} ETB`
                      : ''}{' '}
                    · sales {room.timings.purchaseWindowSecs}s · draw{' '}
                    {room.timings.drawIntervalMs / 1_000}s · press {room.timings.pressWindowSecs}s
                  </p>
                  {room.bonusTiers.length ? (
                    <p className="mt-0.5 text-[11px] text-muted">
                      Bonus cards:{' '}
                      {room.bonusTiers
                        .map((tier) => `${tier.minCards} → +${tier.bonusCards}`)
                        .join(', ')}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-[11px] text-muted">
                    {round
                      ? `Round #${round.roundNumber} · ${round.status.replaceAll('_', ' ').toLowerCase()}`
                      : 'No active round'}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setTarget(entry)}>
                  Configure
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <RoomSheet
        entry={target}
        onClose={() => setTarget(null)}
        onSaved={() => {
          setTarget(null);
          void load();
        }}
      />
    </Panel>
  );
}

function RoomSheet({
  entry,
  onClose,
  onSaved,
}: {
  entry: AdminBingoRoom | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<RoomDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(entry ? toDraft(entry.room) : null);
    setError(null);
  }, [entry]);

  if (!entry || !draft) return null;
  const { room } = entry;
  const isMain = room.mode === 'MAIN';

  const patch = (next: Partial<RoomDraft>) => setDraft({ ...draft, ...next });

  const save = async () => {
    setError(null);
    if (!draft.name.trim()) {
      setError('A display name is required.');
      return;
    }

    const stakeMinor = creditsToMinor(draft.stakePerCard);
    if (stakeMinor === null) {
      setError('The stake must look like 10 or 7.50.');
      return;
    }

    let fixedMinor: number | null = null;
    if (draft.fixedPrize.trim()) {
      fixedMinor = creditsToMinor(draft.fixedPrize);
      if (fixedMinor === null) {
        setError('The fixed prize must look like 25000 or 25000.50.');
        return;
      }
    }

    let runnerUpMinor: number | null = null;
    if (draft.runnerUpPrize.trim()) {
      runnerUpMinor = creditsToMinor(draft.runnerUpPrize);
      if (runnerUpMinor === null) {
        setError('The runner-up prize must look like 5000 or 5000.50.');
        return;
      }
    }
    if (draft.runnerUpEnabled && runnerUpMinor === null) {
      setError('Set a runner-up prize before enabling the runner-up window.');
      return;
    }

    const maxCards = intField(draft.maxCardsPerPlayer);
    if (maxCards === null || maxCards < 1 || maxCards > 30) {
      setError('Cards per player must be a whole number between 1 and 30.');
      return;
    }
    const minPlayers = intField(draft.minPlayersToStart);
    if (minPlayers === null || minPlayers < 1 || minPlayers > 1000) {
      setError('Minimum players must be between 1 and 1000.');
      return;
    }
    const rakeBps = intField(draft.rakeBps);
    if (rakeBps === null || rakeBps > 10_000) {
      setError('Rake must be between 0 and 10000 basis points.');
      return;
    }
    const salesSecs = intField(draft.purchaseWindowSecs);
    if (salesSecs === null || salesSecs < 10 || salesSecs > 1_800) {
      setError('The sales window must be between 10 and 1800 seconds.');
      return;
    }
    const lockSecs = intField(draft.lockWindowSecs);
    if (lockSecs === null || lockSecs < 1 || lockSecs > 120) {
      setError('The lock window must be between 1 and 120 seconds.');
      return;
    }
    const drawMs = intField(draft.drawIntervalMs);
    if (drawMs === null || drawMs < 1_000 || drawMs > 60_000) {
      setError('The draw interval must be between 1000 and 60000 ms.');
      return;
    }
    const claimSecs = intField(draft.claimWindowSecs);
    if (claimSecs === null || claimSecs < 5 || claimSecs > 600) {
      setError('The claim window must be between 5 and 600 seconds.');
      return;
    }
    const pressSecs = intField(draft.pressWindowSecs);
    if (pressSecs === null || pressSecs < 5 || pressSecs > 600) {
      setError('The press window must be between 5 and 600 seconds.');
      return;
    }
    const runnerUpSecs = intField(draft.runnerUpWindowSecs);
    if (runnerUpSecs === null || runnerUpSecs < 5 || runnerUpSecs > 600) {
      setError('The runner-up window must be between 5 and 600 seconds.');
      return;
    }

    const tiers = parseBonusTiers(draft.bonusTiers);
    if (tiers === null) {
      setError('Bonus tiers look like "5:1, 10:3" — min cards : free cards, up to 10 tiers.');
      return;
    }

    const body: BingoRoomPatch = {
      name: draft.name.trim(),
      status: draft.status,
      stakePerCard: stakeMinor,
      fixedPrize: fixedMinor,
      maxCardsPerPlayer: maxCards,
      minPlayersToStart: minPlayers,
      rakeBps,
      purchaseWindowSecs: salesSecs,
      lockWindowSecs: lockSecs,
      drawIntervalMs: drawMs,
      claimWindowSecs: claimSecs,
      pressWindowSecs: pressSecs,
      autoDaubEnabled: draft.autoDaubEnabled,
      allowAutoBingoPress: draft.allowAutoBingoPress,
      runnerUpEnabled: draft.runnerUpEnabled,
      runnerUpPrize: runnerUpMinor,
      runnerUpWindowSecs: runnerUpSecs,
      bonusTiers: tiers,
    };

    setBusy(true);
    try {
      await updateAdminBingoRoom(room.code, body);
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the room.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open title={`Configure ${room.name}`} onClose={onClose}>
      <div className="space-y-4">
        {isMain ? (
          <p className="rounded-xl border border-gold/25 bg-gold/5 px-3 py-2 text-[11px] text-gold">
            Main rooms advertise the fixed prize from the first ball. Surplus above the prize goes to
            the rake; a shortfall is covered by treasury.
          </p>
        ) : (
          <p className="rounded-xl border border-blue/25 bg-blue/5 px-3 py-2 text-[11px] text-blue">
            Fast rooms pay a share of card sales and declare the winner from the server — no manual
            press or runner-up window.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Name"
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
          <Select
            label="Status"
            value={draft.status}
            onChange={(event) => patch({ status: event.target.value as RoomStatus })}
          >
            <option value="OPEN">Open</option>
            <option value="MAINTENANCE">Maintenance</option>
            <option value="CLOSED">Closed</option>
          </Select>
        </div>

        <div>
          <SectionTitle>Stakes &amp; prizes</SectionTitle>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Input
              label="Stake per card (ETB)"
              value={draft.stakePerCard}
              inputMode="decimal"
              onChange={(event) => patch({ stakePerCard: event.target.value })}
            />
            <Input
              label="Fixed prize (ETB)"
              value={draft.fixedPrize}
              inputMode="decimal"
              placeholder={isMain ? '25000' : 'blank = pot'}
              onChange={(event) => patch({ fixedPrize: event.target.value })}
            />
            <Input
              label="Rake (bps)"
              value={draft.rakeBps}
              inputMode="numeric"
              hint="Only applies to the pool in fast rooms."
              onChange={(event) => patch({ rakeBps: event.target.value })}
            />
            <Input
              label="Min players to start"
              value={draft.minPlayersToStart}
              inputMode="numeric"
              onChange={(event) => patch({ minPlayersToStart: event.target.value })}
            />
          </div>
        </div>

        <div>
          <SectionTitle>Cards</SectionTitle>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Input
              label="Max cards per player"
              value={draft.maxCardsPerPlayer}
              inputMode="numeric"
              hint="1–30. Cards beyond the limit are refused at registration."
              onChange={(event) => patch({ maxCardsPerPlayer: event.target.value })}
            />
            <Input
              label="Bonus tiers"
              value={draft.bonusTiers}
              placeholder="5:1, 10:3"
              hint="Min cards registered : free cards awarded."
              onChange={(event) => patch({ bonusTiers: event.target.value })}
            />
            <YesNo
              label="Auto-daub"
              value={draft.autoDaubEnabled}
              onChange={(next) => patch({ autoDaubEnabled: next })}
              hint="Players can still pick manual marking per card."
            />
            <YesNo
              label="Allow auto BINGO press"
              value={draft.allowAutoBingoPress}
              onChange={(next) => patch({ allowAutoBingoPress: next })}
              hint="Hides the auto-press toggle when off. Manual press is always available."
            />
          </div>
        </div>

        <div>
          <SectionTitle>Runner-up</SectionTitle>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <YesNo
              label="Runner-up window"
              value={draft.runnerUpEnabled}
              onChange={(next) => patch({ runnerUpEnabled: next })}
              hint="After the main winner, players race for the last drawn number."
            />
            <Input
              label="Runner-up prize (ETB)"
              value={draft.runnerUpPrize}
              inputMode="decimal"
              placeholder="5000"
              onChange={(event) => patch({ runnerUpPrize: event.target.value })}
            />
            <Input
              label="Runner-up window (s)"
              value={draft.runnerUpWindowSecs}
              inputMode="numeric"
              onChange={(event) => patch({ runnerUpWindowSecs: event.target.value })}
            />
          </div>
        </div>

        <div>
          <SectionTitle>Timing</SectionTitle>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Input
              label="Sales window (s)"
              value={draft.purchaseWindowSecs}
              inputMode="numeric"
              onChange={(event) => patch({ purchaseWindowSecs: event.target.value })}
            />
            <Input
              label="Lock window (s)"
              value={draft.lockWindowSecs}
              inputMode="numeric"
              onChange={(event) => patch({ lockWindowSecs: event.target.value })}
            />
            <Input
              label="Draw interval (ms)"
              value={draft.drawIntervalMs}
              inputMode="numeric"
              hint="16000 for main, 4000 for fast."
              onChange={(event) => patch({ drawIntervalMs: event.target.value })}
            />
            <Input
              label="Claim window (s)"
              value={draft.claimWindowSecs}
              inputMode="numeric"
              onChange={(event) => patch({ claimWindowSecs: event.target.value })}
            />
            <Input
              label="Press window (s)"
              value={draft.pressWindowSecs}
              inputMode="numeric"
              onChange={(event) => patch({ pressWindowSecs: event.target.value })}
            />
          </div>
        </div>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save room
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
