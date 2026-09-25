import { useEffect, useState } from 'react';
import { formatAllocationUnit } from '@a3em/config-schema';
import { mountVolume, type FilesystemFinding, type FsckReport, type ImageReport } from '../lib/helper';
import { checkCardFilesystem, copyCardToImage } from '../lib/cardImage';
import { useKept } from '../lib/keptState';
import { acceptTails, useRecoveredTails, type RecoveredTail } from '../lib/tails';
import type { CardDevice } from '../lib/useCardDevice';
import type { Helper } from '../lib/useHelper';
import { Activity, useCardLogs, without } from './CardActivity';
import { RepairDialog, useCardRepair } from './CardRepair';
import { Pane } from './Pane';
import { TabLink } from './TabLink';

/** What was found and made for one card. */
export interface Found {
  image?: ImageReport;
  fsck?: FsckReport;
  repaired?: FsckReport;
}

/**
 * The card open in the dashboard, as hardware.
 *
 * Everything else on the Review page is about what the card holds. This is about the card:
 * whether the recorder would accept it as it is formatted, which card it is — its maker,
 * serial number and date of manufacture, where the reader passes them on — and what this
 * computer found when it prepared it. And the things only the helper can do to it: check its
 * filesystem without changing anything, copy all of it, sector by sector, to an image file
 * wherever the person chooses, repair it where a check found something, and eject it. A card
 * that will not open at all is "Recover card"'s instead.
 *
 * Shown only when the card helper has matched the open folder to a card (`useCardDevice`).
 */

function size(bytes: number): string {
  return bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB` : `${(bytes / 1e9).toFixed(1)} GB`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PhysicalCard({
  cardDevice,
  helper,
  onReopened,
  clipSeconds = null,
}: Readonly<{
  cardDevice: CardDevice;
  helper: Helper;
  /** After a repair, which closes the card: it is open again, so the dashboard can read it afresh. */
  onReopened?: () => void;
  /** The longest clip the card's configuration records, which no recovered IMU file exceeds. */
  clipSeconds?: number | null;
}>) {
  const { device, volumeId, details, loadDetails } = cardDevice;
  // What logs and IMU files hold past their recorded end, for "Check & copy" to add to their copies.
  const { tails, setTails } = useRecoveredTails(device, volumeId);
  const logs = useCardLogs('review');
  const { now, isWorking, working } = logs;
  // What was found and made, by card, kept while the page is open, like the log: a copy that
  // runs for an hour must still be showing when you come back from another tab.
  const [results, setResults] = useKept<Record<string, Found>>('review:results', {});
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const busy = helper.task !== null || working !== null;
  const deviceId = device?.id ?? null;
  const record = (id: string, patch: Found) => setResults((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  // Kept by device, which outlives what is on it: a card erased and prepared again, or another
  // card in the same reader, has a new volume. What was found on the old one is then let go of.
  const volumeUuid = device?.volumes.find((volume) => volume.id === volumeId)?.uuid ?? null;
  const [volumes, setVolumes] = useKept<Record<string, string>>('review:volumes', {});
  const { forget } = logs;
  useEffect(() => {
    if (!deviceId || !volumeUuid || volumes[deviceId] === volumeUuid) return;
    if (volumes[deviceId] !== undefined) {
      setResults((current) => without(current, [deviceId]));
      forget([deviceId]);
    }
    setVolumes((current) => ({ ...current, [deviceId]: volumeUuid }));
  }, [deviceId, volumeUuid, volumes, setVolumes, setResults, forget]);

  const repair = useCardRepair(helper, logs, (repaired, report) => {
    record(repaired.id, { repaired: report });
    // A repair closes the card; open it again, so it is back as it was, and read it afresh.
    if (report.clean && volumeId) {
      logs.note([repaired.id], 'Opening the card again.');
      void mountVolume(volumeId)
        .then(() => helper.rescan())
        .then(() => onReopened?.())
        .catch(() => undefined);
    }
  });

  useEffect(() => {
    if (!deviceId || details) return;
    setDetailsError(null);
    loadDetails().catch((failure: unknown) => setDetailsError(message(failure)));
  }, [deviceId, details, loadDetails]);

  if (!device) return null;
  const volume = device.volumes.find((candidate) => candidate.id === volumeId) ?? device.volumes[0];
  const identity = details?.identity;
  const prepared = details?.prepared;
  const compatibility = device.compatibility;
  const found = results[device.id] ?? {};

  const checkFilesystem = async () => {
    if (!volume) return;
    record(device.id, { fsck: undefined, repaired: undefined });
    const report = await checkCardFilesystem(device, volume.id, helper, logs);
    if (!report) return;
    record(device.id, { fsck: report });
    if (report.engine === 'a3em') setTails(acceptTails(report.tails, clipSeconds));
  };

  const copyToImage = async () => {
    const image = await copyCardToImage(device, helper, logs);
    if (image) record(device.id, { image });
  };

  const log = logs.logs[device.id];
  const running = isWorking(device.id);
  const needsRepair = Boolean(
    found.fsck &&
      !found.fsck.clean &&
      !found.repaired &&
      (found.fsck.engine === 'a3em' || !COULD_NOT_OPEN.test(found.fsck.output)),
  );

  return (
    <Pane
      id="physical-card"
      className="physical-card"
      title="The card itself"
      note={
        <span>
          {device.node} · {size(device.sizeBytes)}
          {identity?.manufacturer ? ` · ${identity.manufacturer}` : ''}
        </span>
      }
    >
      {compatibility && !compatibility.usable ? (
        <div className="banner crit">
          <strong>The recorder would erase this card</strong>
          {compatibility.issues[0]?.message} Copy anything you need off it first, then prepare it under{' '}
          <TabLink to="batch" />.
        </div>
      ) : null}
      {compatibility?.issues.filter((issue) => issue.severity !== 'critical').map((issue) => (
        <div key={issue.message} className="issue warning" style={{ marginBottom: 10 }}>
          <span className="marker">!</span>
          <span>
            {issue.message} {issue.remedy ?? ''}
          </span>
        </div>
      ))}

      <div className="grid stats">
        <Stat label="Device" value={device.node} />
        <Stat label="Capacity" value={size(device.sizeBytes)} />
        <Stat label="Read through" value={identity?.reader ?? device.bus} />
        <Stat
          label="Format"
          value={
            volume?.filesystem
              ? `${volume.filesystem === 'exfat' ? 'exFAT' : volume.filesystem}${volume.allocationUnitBytes ? `, ${formatAllocationUnit(volume.allocationUnitBytes)} clusters` : ''}`
              : 'Unreadable'
          }
        />
        <Stat label="Lock switch" value={device.writeProtected ? 'Locked' : 'Not locked'} />
        {identity?.source === 'card' ? (
          <>
            {identity.manufacturer ? <Stat label="Manufacturer" value={identity.manufacturer} /> : null}
            {identity.product ? <Stat label="Product" value={identity.product} /> : null}
            {identity.serial ? <Stat label="Serial number" value={identity.serial} /> : null}
            {identity.manufactured ? <Stat label="Manufactured" value={identity.manufactured} /> : null}
          </>
        ) : null}
      </div>

      <p className="card-help">
        {!details
          ? detailsError
            ? `The A3EM Card Helper could not read the card’s details: ${detailsError}`
            : 'Reading the card’s details…'
          : prepared
            ? [
                `Prepared on this computer on ${new Date(prepared.preparedAt).toLocaleDateString()}.`,
                prepared.capacity
                  ? prepared.capacity.genuine
                    ? `Its capacity is genuine: all ${size(prepared.capacity.claimedBytes)} kept what was written.`
                    : `Its capacity is counterfeit: only the first ${size(prepared.capacity.verifiedBytes)} kept what was written.`
                  : '',
                prepared.latency
                  ? `Writes ran at ${prepared.latency.mbPerSecond.toFixed(0)} MB/s, the slowest taking ${Math.round(prepared.latency.maxMs)} ms.`
                  : '',
              ]
                .filter(Boolean)
                .join(' ')
            : identity?.source === 'reader'
              ? 'Not prepared on this computer. The card’s own identity is not visible through this reader.'
              : 'Not prepared on this computer, so its capacity and write speed have not been tested here.'}
      </p>

      <div className="connected-card-actions" style={{ marginTop: 12 }}>
        <button className="btn small" disabled={busy || !volume} onClick={() => void checkFilesystem()}>
          Check the filesystem
        </button>
        <button className="btn small" disabled={busy} onClick={() => void copyToImage()}>
          {found.image ? 'Copy to an image file again…' : 'Copy to an image file…'}
        </button>
        {/* Offered once a check has found something to repair. */}
        {needsRepair && volume ? (
          <button className="btn small" disabled={busy || device.writeProtected} onClick={() => void repair.ask(device, volume.id)}>
            Repair…
          </button>
        ) : null}
        <button className="btn small" disabled={busy} onClick={() => void cardDevice.eject()}>
          Eject
        </button>
      </div>
      {log ? (
        <Activity log={log} running={running} now={now} onStop={logs.canStop(device.id) ? () => logs.stop(device.id) : undefined} />
      ) : null}
      {!running && found.image ? <ImageResult report={found.image} /> : null}
      {!running && found.repaired ? (
        <FsckResult report={found.repaired} />
      ) : !running && found.fsck ? (
        <FsckResult report={found.fsck} recovered={tails} />
      ) : null}
      <p className="card-help">
        Checking the filesystem and copying the card read it directly, so your computer may ask for an administrator
        password. Neither changes anything on the card; a repair does, which is why it asks first.
      </p>
      {repair.pending ? (
        <RepairDialog
          description={repair.pending.description}
          imaged={Boolean(found.image)}
          ours={found.fsck?.fixableHere ?? false}
          onCancel={repair.cancel}
          onConfirm={() => void repair.confirm()}
        />
      ) : null}
    </Pane>
  );
}

/**
 * A check that never saw the filesystem, as helper 0.2.0 on macOS reports one: fsck could not
 * open the card, which is a matter of access, not a finding about the card.
 */
export const COULD_NOT_OPEN = /Operation not permitted|Can't open|Permission denied|Access is denied/i;

/**
 * What fsck's findings mean, in words, for the ones worth explaining. Its own output stays
 * below, for anyone who wants the detail.
 */
const FINDINGS: Array<{ match: RegExp; meaning: string }> = [
  {
    // macOS's fsck_exfat, then exfatprogs's, then chkdsk's ways of saying it.
    match: /bitmap needs to be repaired|marked as free|bitmap.*(incorrect|mismatch|corrupt)|volume bitmap is incorrect/i,
    meaning:
      'The card’s record of which space is in use does not match the files on it. That usually happens when a card is taken out, or loses power, while the recorder is writing. The recordings themselves are usually intact, and a repair rebuilds that record from them — but until then, new writes could land on space a recording occupies.',
  },
  {
    match: /(main|alternate) boot region|boot (sector|region|checksum)/i,
    meaning:
      'The part of the card that describes its layout is damaged, which is why it may not open. A repair can usually restore it from the copy exFAT keeps.',
  },
];

/** What each of this helper's repairs puts right, in words. */
const REPAIRED: Record<string, string> = {
  bitmap: 'the record of which space is in use, rebuilt from the files',
  boot: 'the boot region, restored from its intact copy',
};

function listed(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function counted(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** The folder a saved file is in, on any platform. */
function folderOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
}

function Findings({ findings }: Readonly<{ findings: FilesystemFinding[] }>) {
  // Problems first: they are what decides whether to repair.
  const ordered = [...findings.filter((f) => f.severity === 'problem'), ...findings.filter((f) => f.severity !== 'problem')];
  return (
    <ul className="findings">
      {ordered.map((finding, index) => (
        <li key={`${finding.kind}-${index}`}>
          {finding.severity === 'minor' ? <span className="chip">Minor</span> : null} {finding.message}
          {finding.paths?.length ? (
            <ul className="finding-paths">
              {finding.paths.map((path) => (
                <li key={path} className="mono">
                  {path}
                </li>
              ))}
              {finding.files && finding.files > finding.paths.length ? (
                <li>and {(finding.files - finding.paths.length).toLocaleString()} more</li>
              ) : null}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * What to do about what the check found. A repair is urged only where it helps: minor findings
 * harm nothing, and preparing a card for its next deployment rebuilds its records anyway, so a
 * card already copied off needs no repair at all.
 */
function RepairAdvice({
  findings,
  fixableHere,
  recovered,
}: Readonly<{ findings: FilesystemFinding[]; fixableHere: boolean; recovered: boolean }>) {
  const one = findings.length === 1;
  const it = one ? 'it' : 'them';
  // Rebuilding the record of space in use frees what no file owns, which is where much of what is
  // recovered lies: copied first, it is in the copies whatever the repair then does.
  if (recovered && findings.some((finding) => finding.repair === 'bitmap')) {
    return (
      <p style={{ margin: '6px 0 0' }}>
        Copy the card with <TabLink to="offload" /> before any repair: the repair frees the space some of what is
        recovered above is in. {fixableHere ? `“Repair…” then fixes ${one ? 'this' : 'these'}, rewriting only the card’s own records.` : ''}
      </p>
    );
  }
  if (!findings.some((finding) => finding.severity === 'problem')) {
    return (
      <p style={{ margin: '6px 0 0' }}>
        Nothing needs doing: no recording is affected, and preparing the card for its next deployment clears {it}.
        {fixableHere ? ` “Repair…” can also clear ${it} now, rewriting only the card’s own records.` : ''}
      </p>
    );
  }
  if (fixableHere) {
    return (
      <p style={{ margin: '6px 0 0' }}>
        “Repair…” fixes {one ? 'this' : 'these'} by rewriting only the card’s own records, and changes no file. What it
        replaces is kept on this computer for 30 days. If everything on the card is already copied off, preparing the card
        for its next deployment fixes {it} too.
      </p>
    );
  }
  // Named where the system's repair may shorten or remove them.
  const atRisk = [...new Set(findings.filter((finding) => !finding.repair).flatMap((finding) => finding.paths ?? []))];
  const atRiskText = atRisk.length
    ? listed([...atRisk.slice(0, 5), ...(atRisk.length > 5 ? [`${atRisk.length - 5} more`] : [])])
    : 'files it cannot make sense of';
  return (
    <p style={{ margin: '6px 0 0' }}>
      Only the system’s repair tool can fix {one ? 'this' : 'all of these'}, and it may shorten or remove {atRiskText}.
      Copy the card first — with “Copy to an image file…”, or the recordings in <TabLink to="offload" />. Once
      everything is copied off, preparing the card for its next deployment replaces the damaged records without a repair; to repair
      it in place instead, use “Repair…”.
    </p>
  );
}

/** The helper's own check, which says what is wrong in words and names the files it touches. */
/** What logs and IMU files hold past their recorded end, and where it goes. */
function Recovered({ tails }: Readonly<{ tails: RecoveredTail[] }>) {
  return (
    <>
      <p style={{ margin: '6px 0 0' }}>
        {tails.length === 1 ? 'One file holds' : `${tails.length.toLocaleString()} files hold`} more than the card
        records: what the recorder wrote before it lost power, and had not yet recorded. <TabLink to="offload" /> adds it
        to{' '}
        {tails.length === 1 ? 'the file’s copy' : 'their copies'}; the card is not changed.
      </p>
      <ul className="finding-paths">
        {tails.map((tail) => (
          <li key={tail.path}>
            <span className="mono">{tail.path}</span> — {tail.summary}
          </li>
        ))}
      </ul>
    </>
  );
}

function OwnCheckResult({ report, recovered }: Readonly<{ report: FsckReport; recovered?: RecoveredTail[] | null }>) {
  const findings = report.findings ?? [];
  const problems = findings.filter((finding) => finding.severity === 'problem');
  const checked =
    report.files !== undefined
      ? `Checked ${counted(report.files, 'file', 'files')} in ${counted(report.directories ?? 0, 'folder', 'folders')}.`
      : '';
  const title = report.modified
    ? report.clean
      ? 'The filesystem was repaired'
      : problems.length
        ? 'The repair did not fix everything'
        : 'The filesystem was repaired, with minor issues left'
    : report.clean
      ? 'No problems found in the filesystem'
      : problems.length
        ? 'The filesystem check found problems'
        : 'The filesystem check found minor issues';
  return (
    <div className="card-result">
      <div className={`banner ${problems.length ? 'warn' : 'ok'}`}>
        <strong>{title}</strong>
        {report.modified && report.repaired?.length ? (
          <p style={{ margin: '6px 0 0' }}>
            Repaired {listed(report.repaired.map((repair) => REPAIRED[repair] ?? repair))}. No file was changed.
          </p>
        ) : null}
        {report.clean ? (
          <p style={{ margin: '6px 0 0' }}>
            {checked}{' '}
            {report.modified
              ? 'The card should open normally now.'
              : 'The structure that keeps track of the files on the card is consistent.'}
          </p>
        ) : (
          <>
            <p style={{ margin: '6px 0 0' }}>{checked}</p>
            <Findings findings={findings} />
          </>
        )}
        {!report.modified && recovered?.length ? <Recovered tails={recovered} /> : null}
        {!report.clean && !report.modified ? (
          <RepairAdvice
            findings={findings}
            fixableHere={report.fixableHere ?? false}
            recovered={Boolean(recovered?.some((tail) => tail.unowned))}
          />
        ) : null}
        {report.modified && report.saved?.length ? (
          <p style={{ margin: '6px 0 0' }}>
            What the repair replaced is kept in <span className="mono">{folderOf(report.saved[0])}</span> for 30 days,
            in case it ever needs undoing.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function FsckResult({ report, recovered }: Readonly<{ report: FsckReport; recovered?: RecoveredTail[] | null }>) {
  if (report.engine === 'a3em') return <OwnCheckResult report={report} recovered={recovered} />;
  if (!report.clean && COULD_NOT_OPEN.test(report.output)) {
    return (
      <div className="card-result">
        <div className="banner crit">
          <strong>The check could not open the card</strong>
          So nothing is known about its filesystem yet. On a Mac this is the privacy protection on removable cards, which
          the current A3EM Card Helper handles; update it and check again.
        </div>
        <details className="card-log">
          <summary>What the check reported</summary>
          <pre className="fsck-output">{report.output}</pre>
        </details>
      </div>
    );
  }
  return (
    <div className="card-result">
      <div className={`banner ${report.clean ? 'ok' : 'warn'}`}>
        <strong>
          {report.modified
            ? report.clean
              ? 'The filesystem was repaired'
              : 'The repair did not fix everything'
            : report.clean
              ? 'No problems found in the filesystem'
              : 'The filesystem check found problems'}
        </strong>
        {report.clean
          ? report.modified
            ? 'The card should open normally now.'
            : 'The structure that keeps track of the files on the card is consistent.'
          : report.modified
            ? 'Some damage remains. Keep the image file you made; a recovery tool may get more out of it.'
            : null}
        {!report.clean && !report.modified
          ? FINDINGS.filter((finding) => finding.match.test(report.output)).map((finding) => (
              <p key={finding.meaning} style={{ margin: '6px 0 0' }}>
                {finding.meaning}
              </p>
            ))
          : null}
        {!report.clean && !report.modified ? (
          <p style={{ margin: '6px 0 0' }}>
            Repairing changes the card in place, so copy anything you need off it first — with “Copy to an image file…”,
            or in <TabLink to="offload" /> — then use “Repair…”.
          </p>
        ) : null}
      </div>
      {report.output ? (
        <details className="card-log">
          <summary>What the check reported</summary>
          <pre className="fsck-output">{report.output}</pre>
        </details>
      ) : null}
    </div>
  );
}

export function ImageResult({ report }: Readonly<{ report: ImageReport }>) {
  return (
    <div className="card-result">
      <div className={`banner ${report.complete ? 'ok' : 'warn'}`}>
        <strong>
          {report.badSectors
            ? `Copied, except for ${report.badSectors.toLocaleString()} unreadable sectors`
            : report.complete
              ? 'The whole card was copied'
              : 'The copy stopped before the end'}
        </strong>
        <span className="mono">{report.destinationPath}</span>
        {report.badSectors ? ' The unreadable sectors are zeros in the image.' : ''}
      </div>
    </div>
  );
}

function Stat({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
