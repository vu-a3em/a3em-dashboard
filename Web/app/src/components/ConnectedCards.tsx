import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forecast,
  formatAllocationUnit,
  judgeReadiness,
  recommendAllocationUnit,
  serializeConfig,
  validateFormatRequest,
  type CardReadinessReport,
  type DeploymentConfig,
  type FirmwareProfile,
  type ReadinessStatus,
  type ReadinessVerdict,
} from '@a3em/config-schema';
import {
  checkReadinessOfCards,
  ejectDevice,
  HelperError,
  prepareCards,
  requestChallenge,
  type HelperDevice,
  type PreparedCard,
  type PrepareTarget,
  type TaskProgress,
} from '../lib/helper';
import type { Helper } from '../lib/useHelper';

/**
 * The cards plugged into this computer, through the card helper.
 *
 * Two things happen here that the folder picker cannot do. **Readiness**: one check per card
 * that says whether it can go into a recorder — its layout compared byte for byte with the
 * reference, whether its capacity is real, whether it is locked, empty, configured for this
 * deployment, and has room for it. **Preparation**: every card at once is tested for a
 * counterfeit capacity, timed for write speed, erased, formatted with the reference layout at
 * this deployment's cluster size, verified, and given its unit's configuration — one
 * administrator prompt for the whole batch, but a confirmation for each card, in the helper's
 * own words, because erasing the wrong card is the one mistake here that cannot be undone.
 */

export interface PreparedUnit {
  label: string;
  node: string;
  ok: boolean;
  /** A one-line summary, or the reason it failed. */
  note: string;
}

interface Confirmation {
  device: string;
  label: string;
  description: string;
  confirmed: boolean;
}

type CardState =
  | { kind: 'readiness'; report: CardReadinessReport; verdict: ReadinessVerdict }
  | { kind: 'prepared'; result: PreparedCard; report: CardReadinessReport | null; verdict: ReadinessVerdict | null }
  | { kind: 'error'; message: string };

const MARK: Record<ReadinessStatus, string> = { pass: '✓', warn: '!', fail: '✕', unknown: '?' };

/** What this deployment asks of a card of this size. */
function planFor(config: DeploymentConfig, firmware: FirmwareProfile, sizeBytes: number) {
  const plan = forecast({ config, firmware, sdCardCapacityGb: sizeBytes / 1e9 });
  const allocation = recommendAllocationUnit({ config, clipsPerPhase: plan.clipWeights, cardCapacityBytes: sizeBytes });
  const required = plan.cardBytesPerDay * plan.deploymentDays;
  return { allocationUnitBytes: allocation.recommendedBytes, requiredBytes: Number.isFinite(required) ? required : null };
}

/** The unit's label as the volume's name, where exFAT allows it; otherwise the formatter's default. */
function volumeLabelFor(label: string): string {
  const trimmed = label.trim();
  return trimmed && validateFormatRequest({ device: 'x', allocationUnitBytes: 32768, label: trimmed }).length === 0
    ? trimmed
    : 'A3EM';
}

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
}: Readonly<{
  helper: Helper;
  config: DeploymentConfig;
  firmware: FirmwareProfile;
  /** Unit labels waiting for a card, in order. Empty outside a batch. */
  labels: string[];
  /** Every unit label in the batch, prepared or not, to recognise a card already given one. */
  known: string[];
  onPrepared: (units: PreparedUnit[]) => void;
}>) {
  const devices = helper.devices;
  const [assigned, setAssigned] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, CardState>>({});
  const [confirming, setConfirming] = useState<Confirmation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = helper.task !== null;

  /*
    A unit for every card: the one chosen or prepared here; else the unit whose label the card
    already carries; else the next unit still waiting; else the configuration's own label.
  */
  const chosen: Record<string, string> = {};
  for (const device of devices) {
    const carried = device.volumes[0]?.label;
    const label = assigned[device.id] ?? (carried && known.includes(carried) ? carried : undefined);
    if (label) chosen[device.id] = label;
  }
  const queue = labels.filter((label) => !Object.values(chosen).includes(label));
  for (const device of devices) chosen[device.id] ??= queue.shift() ?? (config.deviceLabel.trim() || 'A3EM');
  const labelOf = (device: HelperDevice) => chosen[device.id]!;

  const plans = useMemo(
    () => Object.fromEntries(devices.map((device) => [device.id, planFor(config, firmware, device.sizeBytes)])),
    [devices, config, firmware],
  );

  const expectationFor = (device: HelperDevice, label: string) => ({
    configText: serializeConfig({ ...config, deviceLabel: label }),
    volumeLabel: volumeLabelFor(label),
    allocationUnitBytes: plans[device.id]?.allocationUnitBytes ?? null,
    requiredBytes: plans[device.id]?.requiredBytes ?? null,
  });

  const check = async (ids: string[]) => {
    setError(null);
    try {
      const reports = await helper.runTask(
        'readiness',
        ids.length > 1 ? `Checking ${ids.length} cards` : 'Checking the card',
        (onProgress) => checkReadinessOfCards(ids, true, onProgress),
      );
      setStates((previous) => {
        const next = { ...previous };
        for (const report of reports) {
          const device = devices.find((candidate) => candidate.id === report.device.id);
          if (!device) continue;
          next[device.id] = {
            kind: 'readiness',
            report,
            verdict: judgeReadiness(report, expectationFor(device, labelOf(device))),
          };
        }
        return next;
      });
    } catch (failure) {
      setError(message(failure));
    }
  };

  /** Step one: the helper describes each card, and each description must be confirmed. */
  const askToPrepare = async (ids: string[]) => {
    setError(null);
    try {
      const entries = await Promise.all(
        ids.map(async (id) => {
          const challenge = await requestChallenge(id, 'prepare');
          const device = devices.find((candidate) => candidate.id === id)!;
          return { device: id, label: labelOf(device), description: challenge.description, confirmed: false };
        }),
      );
      setConfirming(entries);
    } catch (failure) {
      setError(message(failure));
    }
  };

  /**
   * Step two: fresh grants, checked against what was confirmed, then one operation for all.
   *
   * A grant lasts a minute, and confirming six cards can take longer, so new ones are asked
   * for now. Each must describe exactly what the person confirmed; a card swapped in the
   * meantime describes itself differently and stops the whole batch before anything is erased.
   */
  const prepare = async (entries: Confirmation[]) => {
    setConfirming(null);
    setError(null);
    try {
      const targets: PrepareTarget[] = [];
      for (const entry of entries) {
        const challenge = await requestChallenge(entry.device, 'prepare');
        if (challenge.description !== entry.description) {
          setError(`A card changed since you confirmed it. Nothing was erased. It now reads: ${challenge.description}`);
          return;
        }
        targets.push({
          device: entry.device,
          grant: challenge.token,
          allocationUnitBytes: plans[entry.device]!.allocationUnitBytes,
          label: volumeLabelFor(entry.label),
          config: serializeConfig({ ...config, deviceLabel: entry.label }),
        });
      }
      const results = await helper.runTask(
        'prepare',
        entries.length > 1 ? `Preparing ${entries.length} cards` : 'Preparing the card',
        (onProgress) => prepareCards(targets, {}, onProgress),
      );
      // Each card is now that unit, whatever order the batch is in.
      setAssigned((previous) => ({ ...previous, ...Object.fromEntries(entries.map((entry) => [entry.device, entry.label])) }));
      await helper.rescan();

      // Read each prepared card back, so what is shown is the card as it now is.
      const good = results.filter((result) => !result.error).map((result) => result.device);
      let reports: CardReadinessReport[] = [];
      if (good.length) {
        try {
          reports = await checkReadinessOfCards(good, false);
        } catch {
          reports = [];
        }
      }
      setStates((previous) => {
        const next = { ...previous };
        for (const result of results) {
          const entry = entries.find((candidate) => candidate.device === result.device)!;
          const device = devices.find((candidate) => candidate.id === result.device);
          let report = reports.find((candidate) => candidate.device.id === result.device) ?? null;
          // The layout was verified moments ago by the preparation itself; reading it again
          // would only cost another password prompt.
          if (report && !report.layout && result.layout) report = { ...report, layout: result.layout, layoutSkipped: undefined };
          next[result.device] = {
            kind: 'prepared',
            result,
            report,
            verdict: report && device ? judgeReadiness(report, expectationFor(device, entry.label)) : null,
          };
        }
        return next;
      });
      onPrepared(
        results.map((result) => {
          const entry = entries.find((candidate) => candidate.device === result.device)!;
          const node = devices.find((device) => device.id === result.device)?.node ?? result.device;
          return { label: entry.label, node, ok: !result.error, note: result.error ?? summarise(result) };
        }),
      );
    } catch (failure) {
      if (failure instanceof HelperError && failure.code === 'cancelled') {
        setError('Administrator access was not given, so nothing was changed.');
      } else {
        setError(message(failure));
      }
    }
  };

  const eject = async (id: string) => {
    setError(null);
    try {
      await ejectDevice(id);
      setStates((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
      await helper.rescan();
    } catch (failure) {
      setError(message(failure));
    }
  };

  const allIds = devices.map((device) => device.id);
  const progress = helper.task?.progress ?? null;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Cards connected to this computer</h2>
        <button className="btn small" disabled={busy} onClick={() => void helper.rescan()}>
          Rescan
        </button>
      </div>
      <p className="hint">
        Card readers and built-in SD slots appear here; other drives never do. Preparing a card tests that it
        really holds what it claims, erases it, formats it with the layout the recorder expects, checks the
        result, and writes its unit’s configuration.
      </p>

      {error ? (
        <div className="banner crit" role="alert">
          {error}
        </div>
      ) : null}

      {devices.length === 0 ? (
        <p className="muted">No cards are connected.</p>
      ) : (
        <>
          <div className="connected-cards">
            {devices.map((device) => {
              const state = states[device.id];
              const plan = plans[device.id];
              const volume = device.volumes[0];
              const deviceProgress = progress && (!progress.device || progress.device === device.id) ? progress : null;
              return (
                <div key={device.id} className="connected-card">
                  <div className="connected-card-head">
                    <div>
                      <strong>{volume?.label ?? 'No readable volume'}</strong>{' '}
                      <span className="muted mono">
                        {device.node} · {size(device.sizeBytes)} · {device.bus}
                      </span>
                      {device.writeProtected ? <span className="chip crit">Locked</span> : null}
                      {device.compatibility && !device.compatibility.usable ? (
                        <span className="chip crit" title={device.compatibility.issues[0]?.message}>
                          The recorder would erase it
                        </span>
                      ) : null}
                    </div>
                    <div className="connected-card-actions">
                      <label className="muted" htmlFor={`unit-${device.id}`}>
                        Unit
                      </label>
                      {labels.length ? (
                        <select
                          id={`unit-${device.id}`}
                          value={labelOf(device)}
                          disabled={busy}
                          onChange={(event) => setAssigned({ ...assigned, [device.id]: event.target.value })}
                        >
                          {[...new Set([labelOf(device), ...labels])].map((label) => (
                            <option key={label} value={label}>
                              {label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="mono">{labelOf(device)}</span>
                      )}
                      <button className="btn small" disabled={busy} onClick={() => void check([device.id])}>
                        Check readiness
                      </button>
                      <button className="btn small" disabled={busy} onClick={() => void askToPrepare([device.id])}>
                        Prepare…
                      </button>
                      <button className="btn small" disabled={busy} onClick={() => void eject(device.id)}>
                        Eject
                      </button>
                    </div>
                  </div>
                  {plan ? (
                    <p className="card-help">
                      Preparing formats it with {formatAllocationUnit(plan.allocationUnitBytes)} clusters, this
                      deployment’s recommendation for a card this size.
                    </p>
                  ) : null}
                  {deviceProgress && helper.task ? <TaskLine progress={deviceProgress} /> : null}
                  {state ? <CardResult state={state} /> : null}
                </div>
              );
            })}
          </div>
          {devices.length > 1 ? (
            <div className="connected-card-batch">
              <button className="btn" disabled={busy} onClick={() => void check(allIds)}>
                Check all {devices.length}
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void askToPrepare(allIds)}>
                Prepare all {devices.length}…
              </button>
            </div>
          ) : null}
          <p className="card-help">
            Checking and preparing read the card directly, so your computer asks for an administrator password —
            once for all the cards in one go.
          </p>
        </>
      )}

      {confirming ? (
        <ConfirmDialog
          entries={confirming}
          onChange={setConfirming}
          onCancel={() => setConfirming(null)}
          onConfirm={(entries) => void prepare(entries)}
        />
      ) : null}
    </div>
  );
}

function summarise(result: PreparedCard): string {
  const parts = [];
  if (result.capacity) parts.push(result.capacity.genuine ? 'capacity genuine' : 'capacity FAKE');
  if (result.latency) parts.push(`writes ${result.latency.verdict === 'ok' ? 'steady' : result.latency.verdict}`);
  if (result.layout?.reference) parts.push('layout verified');
  if (result.configWritten) parts.push('configuration written');
  return parts.join(', ');
}

const STAGE: Record<string, string> = {
  release: 'Releasing',
  capacity: 'Testing capacity',
  latency: 'Timing writes',
  format: 'Formatting',
  verify: 'Verifying',
  mount: 'Mounting',
  inspect: 'Reading',
};

function TaskLine({ progress }: Readonly<{ progress: TaskProgress }>) {
  const fraction = progress.totalBytes ? (progress.bytesCopied ?? 0) / progress.totalBytes : null;
  return (
    <div className="connected-card-task" role="status" aria-live="polite">
      <span>
        {progress.stage ? `${STAGE[progress.stage] ?? progress.stage}: ` : ''}
        {progress.note}
      </span>
      {fraction !== null ? (
        <div className="meter">
          <i style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function CardResult({ state }: Readonly<{ state: CardState }>) {
  if (state.kind === 'error') return <p className="batch-label-problem">{state.message}</p>;
  const verdict = state.verdict;
  const report = state.report;
  return (
    <div className="card-result">
      {state.kind === 'prepared' ? (
        state.result.error ? (
          <div className="banner crit">
            <strong>Not prepared</strong> {state.result.error}
          </div>
        ) : (
          <div className="banner ok">
            <strong>Prepared</strong> {summarise(state.result)}.
          </div>
        )
      ) : null}
      {verdict ? (
        <>
          <p className={`readiness-verdict ${verdict.status}`}>
            {verdict.status === 'ready'
              ? 'Ready to deploy'
              : verdict.status === 'attention'
                ? 'Usable, with the notes below'
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
        </>
      ) : null}
      {report?.identity ? <Identity identity={report.identity} /> : null}
    </div>
  );
}

function Identity({ identity }: Readonly<{ identity: NonNullable<CardReadinessReport['identity']> }>) {
  if (identity.source === 'card') {
    const parts = [identity.manufacturer, identity.product && `“${identity.product}”`, identity.serial && `serial ${identity.serial}`, identity.manufactured && `made ${identity.manufactured}`];
    return <p className="card-help">Card: {parts.filter(Boolean).join(' · ')}</p>;
  }
  return identity.reader ? <p className="card-help">Read through: {identity.reader}. The card’s own identity is not visible through this reader.</p> : null;
}

/**
 * One confirmation per card, in the helper's words.
 *
 * The helper's description names the device node, size, bus and what is on it now — the
 * details that tell two identical cards apart, or a card from the drive plugged in beside it.
 */
function ConfirmDialog({
  entries,
  onChange,
  onCancel,
  onConfirm,
}: Readonly<{
  entries: Confirmation[];
  onChange: (entries: Confirmation[]) => void;
  onCancel: () => void;
  onConfirm: (entries: Confirmation[]) => void;
}>) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    element.showModal();
    element.addEventListener('close', onCancel);
    return () => element.removeEventListener('close', onCancel);
  }, [onCancel]);
  const all = entries.every((entry) => entry.confirmed);
  return (
    <dialog className="modal" ref={dialog} aria-label="Confirm which cards to erase">
      <h2>{entries.length > 1 ? `Erase and prepare ${entries.length} cards?` : 'Erase and prepare this card?'}</h2>
      <p className="hint">
        Everything on {entries.length > 1 ? 'these cards' : 'this card'} will be erased. Tick each one to confirm it
        is the card you mean.
      </p>
      <ul className="confirm-list">
        {entries.map((entry, index) => (
          <li key={entry.device}>
            <label>
              <input
                type="checkbox"
                checked={entry.confirmed}
                onChange={(event) =>
                  onChange(entries.map((e, i) => (i === index ? { ...e, confirmed: event.target.checked } : e)))
                }
              />
              <span>
                {entry.description}
                <br />
                <span className="muted">Becomes unit {entry.label}.</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="modal-actions">
        <button className="btn danger" disabled={!all} onClick={() => onConfirm(entries)}>
          {entries.length > 1 ? `Erase and prepare ${entries.length} cards` : 'Erase and prepare'}
        </button>
        <button className="btn" onClick={() => dialog.current?.close()}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
