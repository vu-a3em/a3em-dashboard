import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONFIG_FILE_NAME,
  formatAllocationUnit,
  type CardReadinessReport,
  type DeploymentConfig,
  type FirmwareProfile,
  type PreparationPlan,
  type ReadinessStatus,
  type ReadinessVerdict,
} from '@a3em/config-schema';
import { ejectDevice, HelperError, requestChallenge, type HelperDevice, type PreparedCard } from '../lib/helper';
import { cardCondition } from '../lib/cardCondition';
import { eraseAndPrepare, judgeCard, planFor, readCards as readThroughHelper, summarize, writeUnitSettings } from '../lib/cardPreparation';
import { ConfirmDialog, listed, type Confirmation } from './EraseConfirm';
import { useKept } from '../lib/keptState';
import { useDeviceWatch, type Helper } from '../lib/useHelper';
import { Activity, useCardLogs, without } from './CardActivity';

/**
 * The cards plugged into this computer, through the card helper.
 *
 * Two buttons, in order. **Check this card** finds out, changing nothing, whether a card can
 * go into a recorder: its layout compared byte for byte with the reference, whether its
 * capacity is real, whether it is locked, empty, configured for this unit, and has room for
 * the deployment. **Prepare this card** then does the least that makes it ready, and only once
 * it has been checked, since that is what decides it (`planPreparation`):
 *
 *  - writing the unit's `_a3em.cfg`, when that is all that is missing — nothing erased, and no
 *    folder picker to choose the card in again;
 *  - or erasing the card and setting it up again — capacity test, write timing, the reference
 *    layout at this deployment's cluster size, verified, then the configuration — when its
 *    layout, format, contents or free space call for it. One administrator prompt for the
 *    whole batch, but a confirmation for each card, in the helper's own words, because erasing
 *    the wrong card is the one mistake here that cannot be undone.
 *
 * Two buttons with a rule between them read as three choices of which one was right. One that
 * works out the answer, and says what it will do before doing it, leaves nothing to get wrong.
 *
 * All of it can take a while, so each card keeps a running log of what is being done to it
 * (`CardActivity`). The list keeps itself current: a card appears when it is inserted.
 */

export interface PreparedUnit {
  label: string;
  node: string;
  /** The card's device, so a folder open on it can be let go of or read again. */
  device: string;
  /** Whether it was erased, which a folder open on it does not survive. */
  erased: boolean;
  ok: boolean;
  /** A one-line summary, or the reason it failed. */
  note: string;
}

/** The card as last read, and what was last done to it here. */
interface CardState {
  report: CardReadinessReport | null;
  outcome?: { kind: 'prepared'; result: PreparedCard } | { kind: 'settings' };
}

const MARK: Record<ReadinessStatus, string> = { pass: '✓', warn: '!', fail: '✕', unknown: '?' };

function size(bytes: number): string {
  return bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB` : `${(bytes / 1e9).toFixed(1)} GB`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ConnectedCards({
  helper,
  config,
  firmware,
  labels,
  known,
  onPrepared,
  onRecover,
}: Readonly<{
  helper: Helper;
  config: DeploymentConfig;
  firmware: FirmwareProfile;
  /** Unit labels waiting for a card, in order. Empty outside a batch. */
  labels: string[];
  /** Every unit label in the batch, prepared or not, to recognize a card already given one. */
  known: string[];
  onPrepared: (units: PreparedUnit[]) => void;
  /** Opens the recovery screen, for a card whose filesystem cannot be read. */
  onRecover?: () => void;
}>) {
  const devices = helper.devices;
  // Kept while the page is open, like the logs, so a preparation still running is still showing
  // when you come back from another tab.
  const [assigned, setAssigned] = useKept<Record<string, string>>('batch:assigned', {});
  const [states, setStates] = useKept<Record<string, CardState>>('batch:states', {});
  const [confirming, setConfirming] = useState<Confirmation[] | null>(null);
  const { logs, working, now, begin, note, follow, finish, forget, prune, isWorking } = useCardLogs('batch');
  // The cards waiting in the confirmation dialog, so closing it can tell a cancel from a confirm.
  const awaiting = useRef<string[] | null>(null);
  // Cards that need only their settings, written once the ones being erased are done, and
  // whether each one's log is already running from the check that found it.
  const thenSettings = useRef<Array<{ device: HelperDevice; continuing: boolean }>>([]);
  const busy = helper.task !== null || working !== null;
  useDeviceWatch(helper, !busy);

  // A card taken out takes its results with it: one put back under the same name may not be it.
  useEffect(() => {
    const present = devices.map((device) => device.id);
    setStates((previous) => {
      const gone = Object.keys(previous).filter((id) => !present.includes(id));
      return gone.length ? without(previous, gone) : previous;
    });
    prune(present);
  }, [devices, prune, setStates]);

  /*
    A unit for every card: the one chosen or prepared here; else the unit whose label the card
    already carries; else the next unit still waiting. Only the batch's units: a card beyond
    them has none, and outside a batch no card has one — preparing needs a batch, even of one,
    so every card prepared is a unit the batch keeps track of.
  */
  const batch = known.length > 0;
  const chosen: Record<string, string | null> = {};
  for (const device of devices) {
    const carried = device.volumes[0]?.label;
    const picked = assigned[device.id];
    const label = picked && known.includes(picked) ? picked : carried && known.includes(carried) ? carried : undefined;
    if (label) chosen[device.id] = label;
  }
  const queue = labels.filter((label) => !Object.values(chosen).includes(label));
  for (const device of devices) {
    if (chosen[device.id] === undefined) chosen[device.id] = queue.shift() ?? null;
  }
  const unitOf = (device: HelperDevice) => chosen[device.id] ?? null;

  const plans = useMemo(
    () => Object.fromEntries(devices.map((device) => [device.id, planFor(config, firmware, device.sizeBytes)])),
    [devices, config, firmware],
  );

  /** A reading judged afresh, so choosing another unit changes the answer at once. */
  const judge = (device: HelperDevice, report: CardReadinessReport) => judgeCard(config, plans[device.id], report, unitOf(device));
  const judged = (device: HelperDevice): { verdict: ReadinessVerdict; plan: PreparationPlan } | null => {
    const report = states[device.id]?.report;
    return report ? judge(device, report) : null;
  };

  /**
   * Whether "Prepare this card" can be pressed, and why not where it cannot. It needs a batch
   * and a unit, not a check: pressed on a card not yet checked, it checks it first.
   */
  const readiness = (device: HelperDevice): { can: boolean; why: string } => {
    if (!batch) return { can: false, why: 'Create a batch in the “Devices in this batch” pane above first. A batch of one is fine.' };
    if (!unitOf(device)) return { can: false, why: 'Every unit in the batch already has a card.' };
    const found = judged(device);
    if (!found) return { can: true, why: 'Checks the card, then does what the check finds is needed.' };
    const { plan } = found;
    if (plan.kind === 'blocked') return { can: false, why: plan.reason };
    if (plan.kind === 'none') return { can: false, why: 'Nothing to prepare.' };
    return { can: true, why: plan.kind === 'erase' ? 'Erases the card and sets it up again.' : 'Writes this unit’s settings, erasing nothing.' };
  };

  /** Reads the cards, changing nothing, with the helper's progress in each one's log. */
  const readCards = (ids: string[]) => readThroughHelper(helper, ids, follow(ids));
  const keep = (reports: CardReadinessReport[]) =>
    setStates((previous) => ({ ...previous, ...Object.fromEntries(reports.map((report) => [report.device.id, { report }])) }));

  const check = async (ids: string[]) => {
    begin(ids, ids.length > 1 ? 'Asking the card helper to check the cards.' : 'Asking the card helper to check the card.');
    setStates((previous) => without(previous, ids));
    try {
      keep(await readCards(ids));
      finish(ids);
    } catch (failure) {
      finish(ids, message(failure));
    }
  };

  /**
   * The unit's settings, straight onto the card, erasing nothing.
   *
   * The card is read back afterward, so what is shown is what it now holds; a layout checked
   * earlier is carried over rather than read again, which would ask for a password. When the
   * card was checked just now, as part of preparing it, its log carries on from the check.
   */
  const writeSettings = async (device: HelperDevice, continuing = false) => {
    const volume = device.volumes[0];
    const label = unitOf(device);
    if (!volume || !label) return;
    const earlier = states[device.id]?.report;
    const first = `Writing unit ${label}’s settings to the card.`;
    if (continuing) note([device.id], first);
    else begin([device.id], first);
    try {
      const report = await writeUnitSettings(device, config, label, earlier ?? null, follow([device.id]));
      setAssigned((current) => ({ ...current, [device.id]: label }));
      setStates((current) => ({
        ...current,
        [device.id]: { report: report ?? current[device.id]?.report ?? null, outcome: { kind: 'settings' } },
      }));
      onPrepared([{ label, node: device.node, device: device.id, erased: false, ok: true, note: 'settings written' }]);
      finish([device.id]);
    } catch (failure) {
      finish([device.id], message(failure));
    }
  };

  /**
   * "Prepare this card", for one card or several: the least each one needs.
   *
   * A card not checked yet is checked first, with the same progress as "Check this card", and
   * its log carries on into the preparation. Then cards that need only their settings get them;
   * cards that need erasing are described by the helper and confirmed first, and the
   * settings-only ones follow once they are done — one confirmation, one password, then the rest.
   */
  const prepareSelected = async (ids: string[]) => {
    const unchecked = ids.filter((id) => !states[id]?.report);
    const reports: Record<string, CardReadinessReport> = {};
    for (const id of ids) {
      const report = states[id]?.report;
      if (report) reports[id] = report;
    }
    if (unchecked.length) {
      begin(
        unchecked,
        unchecked.length > 1 ? 'Checking the cards first, to see what preparing them needs.' : 'Checking the card first, to see what preparing it needs.',
      );
      try {
        const fresh = await readCards(unchecked);
        keep(fresh);
        for (const report of fresh) reports[report.device.id] = report;
      } catch (failure) {
        finish(unchecked, message(failure));
        return;
      }
    }
    const erase: Array<{ device: HelperDevice; label: string; fixes: string[] }> = [];
    const settings: Array<{ device: HelperDevice; continuing: boolean }> = [];
    const nothing: string[] = [];
    for (const id of ids) {
      const device = devices.find((candidate) => candidate.id === id);
      const label = device ? unitOf(device) : null;
      const report = reports[id];
      const plan = device && label && report ? judge(device, report).plan : null;
      if (device && label && plan?.kind === 'erase') erase.push({ device, label, fixes: plan.fixes });
      else if (device && plan?.kind === 'settings') settings.push({ device, continuing: unchecked.includes(id) });
      else nothing.push(id);
    }
    // A card checked just now that needs nothing: the check was all there was to do.
    finish(nothing.filter((id) => unchecked.includes(id)));
    if (!erase.length) {
      for (const { device, continuing } of settings) await writeSettings(device, continuing);
      return;
    }
    thenSettings.current = settings;
    const waiting = settings.filter((entry) => entry.continuing).map((entry) => entry.device.id);
    if (waiting.length) note(waiting, 'Waiting for the cards being erased first.');
    const eraseIds = erase.map((entry) => entry.device.id);
    const describe = 'Asking the card helper to describe the card, so you can confirm it before anything is erased.';
    const fresh = eraseIds.filter((id) => !unchecked.includes(id));
    if (fresh.length) begin(fresh, describe);
    const carried = eraseIds.filter((id) => unchecked.includes(id));
    if (carried.length) note(carried, describe);
    try {
      const entries = await Promise.all(
        erase.map(async ({ device, label, fixes }) => {
          const challenge = await requestChallenge(device.id, 'prepare');
          return { device: device.id, label, fixes, description: challenge.description, confirmed: false };
        }),
      );
      note(eraseIds, 'Waiting for you to confirm.');
      awaiting.current = eraseIds;
      setConfirming(entries);
    } catch (failure) {
      stopWaiting();
      finish(eraseIds, message(failure));
    }
  };

  /** Cards that were to get their settings after the erasing, when it is not going to happen. */
  const stopWaiting = useCallback(() => {
    const ids = thenSettings.current.map((entry) => entry.device.id);
    thenSettings.current = [];
    if (ids.length) {
      note(ids, 'Nothing was written, since the preparation was canceled.');
      finish(ids);
    }
  }, [note, finish]);

  // Stable, because the dialog listens for its own closing with it.
  const cancelConfirmation = useCallback(() => {
    setConfirming(null);
    stopWaiting();
    // Nothing was done, so there is nothing to keep a log of.
    const ids = awaiting.current;
    awaiting.current = null;
    if (ids) forget(ids);
  }, [forget, stopWaiting]);

  // Leaving the tab with the confirmation open cancels it: nothing has been done.
  useEffect(() => () => {
    if (awaiting.current) cancelConfirmation();
  }, [cancelConfirmation]);

  /**
   * Erasing, after confirmation: fresh grants, checked against what was confirmed, then one
   * operation for all.
   *
   * A grant lasts a minute, and confirming six cards can take longer, so new ones are asked
   * for now. Each must describe exactly what the person confirmed; a card swapped in the
   * meantime describes itself differently and stops the whole batch before anything is erased.
   */
  const erase = async (entries: Confirmation[]) => {
    awaiting.current = null;
    setConfirming(null);
    const ids = entries.map((entry) => entry.device);
    note(ids, 'Checking that nothing has changed since you confirmed.');
    try {
      // Each card is then read back, so what is shown is the card as it now is.
      const { results, reports } = await eraseAndPrepare(helper, entries, config, plans, follow(ids));
      // Each card is now that unit, whatever order the batch is in.
      setAssigned((previous) => ({ ...previous, ...Object.fromEntries(entries.map((entry) => [entry.device, entry.label])) }));
      setStates((previous) => {
        const next = { ...previous };
        for (const result of results) {
          const report = reports.find((candidate) => candidate.device.id === result.device) ?? null;
          next[result.device] = { report: result.error ? (previous[result.device]?.report ?? null) : report, outcome: { kind: 'prepared', result } };
        }
        return next;
      });
      onPrepared(
        results.map((result) => {
          const entry = entries.find((candidate) => candidate.device === result.device)!;
          const node = devices.find((device) => device.id === result.device)?.node ?? result.device;
          return {
            label: entry.label,
            node,
            device: result.device,
            erased: result.formatted,
            ok: !result.error,
            note: result.error ?? summarize(result),
          };
        }),
      );
      finish(ids);
    } catch (failure) {
      stopWaiting();
      finish(
        ids,
        failure instanceof HelperError && failure.code === 'cancelled'
          ? 'Administrator access was not given, so nothing was changed.'
          : message(failure),
      );
      return;
    }
    const rest = thenSettings.current;
    thenSettings.current = [];
    for (const { device, continuing } of rest) await writeSettings(device, continuing);
  };

  const eject = async (id: string) => {
    begin([id], 'Ejecting the card.');
    try {
      await ejectDevice(id);
      setStates((previous) => without(previous, [id]));
      forget([id]);
      await helper.rescan();
    } catch (failure) {
      finish([id], message(failure));
    }
  };

  const allIds = devices.map((device) => device.id);
  const needing = devices.filter((device) => readiness(device).can).map((device) => device.id);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Cards connected to this computer</h2>
        <button className="btn small" disabled={busy} onClick={() => void helper.rescan()}>
          Rescan
        </button>
      </div>
      <p className="hint">
        Card readers and built-in SD slots appear here; other drives never do. “Check this card” verifies whether a card
        is ready for deployment. “Prepare this card” checks the card, if needed, and then fully prepares it for
        deployment.
      </p>

      {devices.length === 0 ? (
        <p className="muted">No cards are connected.</p>
      ) : (
        <>
          {devices.length > 1 ? (
            <div className="connected-card-batch">
              <button className="btn" disabled={busy} onClick={() => void check(allIds)}>
                Check all {devices.length} cards
              </button>
              <button
                className="btn primary"
                disabled={busy || needing.length === 0}
                title={!batch ? 'Create a batch in the “Devices in this batch” pane above first.' : needing.length === 0 ? 'Nothing to prepare.' : undefined}
                onClick={() => void prepareSelected(needing)}
              >
                {needing.length > 0 && needing.length < devices.length
                  ? `Prepare the ${needing.length} ${needing.length === 1 ? 'card' : 'cards'} that need it`
                  : `Prepare all ${devices.length} cards`}
              </button>
            </div>
          ) : null}
          <div className="connected-cards">
            {devices.map((device) => {
              const state = states[device.id];
              const plan = plans[device.id];
              const volume = device.volumes[0];
              const log = logs[device.id];
              const running = isWorking(device.id);
              const condition = cardCondition(device);
              const erases = Boolean(device.compatibility && !device.compatibility.usable);
              const unit = unitOf(device);
              const found = judged(device);
              const prepare = readiness(device);
              return (
                <div key={device.id} className="connected-card" data-device={device.id}>
                  <div className="connected-card-head">
                    <div>
                      <strong>{volume?.label ?? 'No readable volume'}</strong>{' '}
                      <span className="muted mono">
                        {device.node} · {size(device.sizeBytes)} · {device.bus}
                      </span>
                      {device.writeProtected ? <span className="chip crit">Locked</span> : null}
                      {condition.kind === 'unreadable' ? (
                        <span className="chip crit">Cannot be opened</span>
                      ) : erases ? (
                        <span className="chip crit" title={device.compatibility?.issues[0]?.message}>
                          The recorder would erase it
                        </span>
                      ) : null}
                    </div>
                    <div className="connected-card-actions">
                      <label className="muted" htmlFor={`unit-${device.id}`}>
                        Unit
                      </label>
                      {!batch ? (
                        <span className="muted">none yet</span>
                      ) : (
                        <select
                          id={`unit-${device.id}`}
                          value={unit ?? ''}
                          disabled={busy}
                          onChange={(event) => setAssigned({ ...assigned, [device.id]: event.target.value })}
                        >
                          {unit ? null : (
                            <option value="" disabled>
                              No unit left
                            </option>
                          )}
                          {[...new Set([...(unit ? [unit] : []), ...labels])].map((label) => (
                            <option key={label} value={label}>
                              {label}
                            </option>
                          ))}
                        </select>
                      )}
                      <button className="btn small" disabled={busy} onClick={() => void check([device.id])}>
                        Check this card
                      </button>
                      <button
                        className="btn small"
                        disabled={busy || !prepare.can}
                        title={prepare.why}
                        onClick={() => void prepareSelected([device.id])}
                      >
                        Prepare this card
                      </button>
                      <button className="btn small" disabled={busy} onClick={() => void eject(device.id)}>
                        Eject
                      </button>
                    </div>
                  </div>
                  {condition.kind === 'unreadable' ? (
                    <p className="card-help">
                      The system cannot read this card’s filesystem. If it holds recordings, recover them before
                      preparing it, which erases everything.{' '}
                      {onRecover ? (
                        <button className="link-button" onClick={onRecover}>
                          Recover this card
                        </button>
                      ) : null}
                    </p>
                  ) : null}
                  {log ? <Activity log={log} running={running} now={now} /> : null}
                  {state && found && !running ? (
                    <CardResult
                      state={state}
                      verdict={found.verdict}
                      plan={found.plan}
                      unit={unit}
                      batch={batch}
                      clusters={plan ? formatAllocationUnit(plan.allocationUnitBytes) : null}
                    />
                  ) : state?.outcome?.kind === 'prepared' && state.outcome.result.error && !running ? (
                    <div className="card-result">
                      <div className="banner crit">
                        <strong>Not prepared</strong> {state.outcome.result.error}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {!batch ? (
            <p className="banner">
              To prepare a card, first create a batch in the “Devices in this batch” pane above; a batch of one is fine.
              Each card becomes one of its units. Checking a card needs no batch.
            </p>
          ) : null}
          <p className="card-help">
            These functions read the card directly, so your computer may ask for an administrator password.
          </p>
        </>
      )}

      {confirming ? (
        <ConfirmDialog
          entries={confirming}
          onChange={setConfirming}
          onCancel={cancelConfirmation}
          onConfirm={(entries) => void erase(entries)}
        />
      ) : null}
    </div>
  );
}

/**
 * What "Prepare this card" will do, said before it is pressed: everything it fixes, by the
 * titles in the list above — not only the one that made erasing necessary — and what it cannot.
 */
function planText(plan: PreparationPlan, verdict: ReadinessVerdict, unit: string | null, batch: boolean, clusters: string | null): string {
  if (!batch) return 'To prepare it, create a batch in the “Devices in this batch” pane above; a batch of one is fine.';
  if (!unit) {
    return 'Every unit in the batch already has a card, so there is no unit to prepare this one for. Add units in the “Devices in this batch” pane above.';
  }
  const cannot = (titles: string[]) => (titles.length ? ` It cannot fix ${listed(titles)}.` : '');
  switch (plan.kind) {
    case 'blocked':
      return `It cannot be prepared. ${plan.reason}`;
    case 'erase':
      return `“Prepare this card” will erase it and set it up again as unit ${unit}${clusters ? `, with ${clusters} clusters` : ''}. That fixes ${listed(plan.fixes)}.${cannot(plan.cannotFix)}`;
    case 'settings':
      return `“Prepare this card” will write unit ${unit}’s settings to it, which fixes ${listed(plan.fixes)}. Nothing needs erasing.${
        plan.leaves.length ? ` It leaves ${listed(plan.leaves)} as it is; the recorder does not mind.` : ''
      }${cannot(plan.cannotFix)}`;
    default:
      return verdict.status === 'ready'
        ? `Nothing to prepare: it is ready for unit ${unit}.`
        : 'Nothing to prepare: preparing would not change anything noted above.';
  }
}

function CardResult({
  state,
  verdict,
  plan,
  unit,
  batch,
  clusters,
}: Readonly<{
  state: CardState;
  verdict: ReadinessVerdict;
  plan: PreparationPlan;
  unit: string | null;
  batch: boolean;
  clusters: string | null;
}>) {
  const outcome = state.outcome;
  const report = state.report;
  return (
    <div className="card-result">
      {outcome?.kind === 'prepared' ? (
        outcome.result.error ? (
          <div className="banner crit">
            <strong>Not prepared</strong> {outcome.result.error}
          </div>
        ) : (
          <div className="banner ok">
            <strong>Prepared</strong> {summarize(outcome.result)}.
          </div>
        )
      ) : outcome?.kind === 'settings' ? (
        <div className="banner ok">
          <strong>Settings written</strong> Unit {unit}’s {CONFIG_FILE_NAME} is on the card.
        </div>
      ) : null}
      <p className={`readiness-verdict ${verdict.status}`}>
        {verdict.status === 'ready'
          ? 'Ready to deploy'
          : verdict.status === 'attention'
            ? 'Usable, with the caveats below'
            : 'Not ready to deploy'}
      </p>
      <ul className="readiness-checks">
        {verdict.checks.map((item) => (
          <li key={item.id} className={`readiness-check ${item.status}`}>
            <span className="readiness-mark" aria-label={item.status}>
              {MARK[item.status]}
            </span>
            <span>
              <strong>{item.title}.</strong> {item.detail}
            </span>
          </li>
        ))}
      </ul>
      {verdict.notes.map((text) => (
        <p key={text} className="card-help">
          {text}
        </p>
      ))}
      <p className={`readiness-plan ${plan.kind}`}>{planText(plan, verdict, unit, batch, clusters)}</p>
      {report?.identity ? <Identity identity={report.identity} /> : null}
    </div>
  );
}

function Identity({ identity }: Readonly<{ identity: NonNullable<CardReadinessReport['identity']> }>) {
  if (identity.source === 'card') {
    const parts = [identity.manufacturer, identity.product && `“${identity.product}”`, identity.serial && `serial ${identity.serial}`, identity.manufactured && `manufactured ${identity.manufactured}`];
    return <p className="card-help">Card: {parts.filter(Boolean).join(' · ')}</p>;
  }
  return identity.reader ? <p className="card-help">Read through: {identity.reader}. The card’s own identity is not visible through this reader.</p> : null;
}
