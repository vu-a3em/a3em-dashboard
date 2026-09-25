import { useMemo, useState } from 'react';
import type { OffloadTask } from '../lib/useOffloadTask';
import { RECORDING_VERDICT_LABELS, describeCorrection, planRename } from '@a3em/config-schema';
import type { CorrectionState } from '../App';
import { useClockCorrection } from '../lib/useClockCorrection';
import { CARD_ACCESS_SUPPORTED } from '../lib/card';
import { diagnoseVolume } from '../lib/helper';
import { acceptTails, longestClip, useRecoveredTails } from '../lib/tails';
import type { Helper } from '../lib/useHelper';
import { HelperOffer } from '../components/HelperOffer';
import {
  buildSkipManifest,
  checkIntegrity,
  copyCard,
  repairWavHeaders,
} from '../lib/transfer';
import type { useCard } from '../lib/useCard';
import type { CardDevice } from '../lib/useCardDevice';
import { RecoverHint } from '../components/RecoverHint';
import { isUndeployed, NotDeployed } from '../components/NotDeployed';

type Card = ReturnType<typeof useCard>;

/**
 * Checking a card and copying it off.
 *
 * The failure this exists for: a bulk copy meets a corrupt file, stops, and looks like
 * it succeeded. So the check runs first and says what is wrong, and the copy continues
 * past anything it cannot read and reports exactly what it left behind.
 */
export function OffloadCard({
  card,
  task,
  correction: correctionState,
  cardDevice,
  helper,
  onRecover,
}: Readonly<{
  card: Card;
  /** For saying what the card tools would add here, where they are not installed. */
  helper: Helper;
  task: OffloadTask;
  correction: CorrectionState;
  /** The physical card the open folder is on, where the card helper can tell, to eject it. */
  cardDevice: CardDevice;
  onRecover: () => void;
}>) {
  // Held in App so that a check or copy in flight survives switching to another section
  const { report, setReport, checking, setChecking, progress, setProgress, result, setResult, repair, setRepair, error, setError } = task;

  /*
    Correcting the clock as the files are COPIED, rather than renaming them on the card.

    Same arithmetic as before, applied to the destination instead of the source: the card
    keeps the names the device wrote, so there is nothing to undo, and a correction that
    later proves wrong costs another copy rather than a lost original.
  */
  const { correction } = useClockCorrection(card, correctionState);
  const [applyCorrection, setApplyCorrection] = useState(true);
  // What logs and IMU files hold past their recorded end, found by a filesystem check of this card.
  const { tails, setTails } = useRecoveredTails(cardDevice.device, cardDevice.volumeId);
  const [looking, setLooking] = useState(false);
  const renamePlan = useMemo(
    () => (correction && card.contents ? planRename(card.contents.layout, correction) : null),
    [correction, card.contents],
  );
  const renameTo = useMemo(() => {
    if (!applyCorrection || !renamePlan) return undefined;
    return new Map(renamePlan.entries.map((entry) => [entry.from, entry.to]));
  }, [applyCorrection, renamePlan]);

  // The loading panel above already says a card is being read; a second pane saying
  // there is no card contradicts it.
  if (card.status === 'scanning') return null;
  if (card.status !== 'ready' || !card.contents) {
    return (
      <div className="card">
        <h2>No card connected</h2>
        <p className="hint">Connect a card to check it for damage and copy its recordings off.</p>
        <RecoverHint available={cardDevice.available} onRecover={onRecover} />
        <HelperOffer helper={helper} as="note">
          With the A3EM Card Helper, a small program with a browser extension, copying also recovers what a recorder wrote before it lost power but had not yet recorded, and the card can be ejected from here once it is copied.
        </HelperOffer>
      </div>
    );
  }

  const { layout, unreadable } = card.contents;
  if (isUndeployed(layout) && !unreadable.length) {
    return <NotDeployed name={card.name} layout={layout} config={card.existingConfig} configText={card.contents.configText} nothing="nothing to check or copy" />;
  }

  // Counted the way the check counts: the self-test capture at the card root is checked too,
  // so a button offering one number fewer than the report then showed looked like a miscount.
  const checkableCount = (card.contents?.layout.files ?? []).filter(
    (file) => file.kind === 'audio' || file.kind === 'imu' || file.kind === 'self-test-clip',
  ).length;

  const runCheck = async () => {
    setError(null);
    setChecking({ done: 0, total: 0 });
    try {
      setReport(
        await checkIntegrity(layout.files, card.contents!.entries, {
          onProgress: (done, total) => setChecking({ done, total }),
          correctWavChunkSize: card.cardFirmware.capabilities.correctWavChunkSize,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setChecking(null);
    }
  };

  const runCopy = async () => {
    setError(null);
    setResult(null);
    setRepair(null);
    try {
      const picker = window as unknown as {
        showDirectoryPicker: (o?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
      };
      const destination = await picker.showDirectoryPicker({ mode: 'readwrite' });

      /*
        The repair below works from the check's findings, so without one nothing is
        repaired — a copy run on its own silently skipped the mending it appears to
        promise. Run the check first when it has not been run, rather than making the
        order something the user has to know.
      */
      let findings = report;
      if (!findings) {
        setChecking({ done: 0, total: 0 });
        try {
          findings = await checkIntegrity(layout.files, card.contents!.entries, {
            onProgress: (done, total) => setChecking({ done, total }),
            correctWavChunkSize: card.cardFirmware.capabilities.correctWavChunkSize,
          });
          setReport(findings);
        } finally {
          setChecking(null);
        }
      }

      /*
        What the recorder wrote past files' recorded ends, to go into their copies. The card
        helper finds it while checking the filesystem, which asks for the password once; a check
        already made of this card on "Review card" is used instead. Without the helper, or the
        password, the copy goes ahead with the files as the card records them.
      */
      let recovered = tails;
      if (!recovered && cardDevice.device && cardDevice.volumeId) {
        setLooking(true);
        try {
          const found = await diagnoseVolume(cardDevice.volumeId);
          recovered = found.engine === 'a3em' ? acceptTails(found.tails, longestClip(card.existingConfig)) : [];
          setTails(recovered);
        } catch {
          recovered = [];
        } finally {
          setLooking(false);
        }
      }

      const copyResult = await copyCard(card.contents!.entries, destination, {
        onProgress: setProgress,
        renameTo,
        additions: new Map((recovered ?? []).map((tail) => [tail.path, tail])),
      });
      setResult(copyResult);

      // Mend the copies of any clip the device never closed. Done here rather than on the
      // card so the original is never written to, and only for files the copy step did not
      // skip — a file that failed to copy has nothing at the destination to repair.
      const landed = new Set(copyResult.skipped.map((skip) => skip.path));
      const targets = (findings?.recoverable ?? [])
        .filter((file) => file.repair && !landed.has(file.path))
        // Destination paths, not source ones: a renamed copy is no longer where the
        // check found it, and repairing by the original path would miss every file.
        .map((file) => ({ path: renameTo?.get(file.path) ?? file.path, repair: file.repair! }));
      if (targets.length) setRepair(await repairWavHeaders(destination, targets));

      // Write the account of what was skipped next to the copy, so it survives the
      // session rather than living only on screen.
      if (copyResult.skipped.length || copyResult.recovered.length) {
        const manifest = await destination.getFileHandle('a3em-copy-report.txt', { create: true });
        const writable = await manifest.createWritable();
        await writable.write(buildSkipManifest(copyResult, card.name ?? 'card'));
        await writable.close();
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setProgress(null);
    }
  };

  const totalBytes = layout.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  // A file whose data is recovered into its copy is not lost, though the card records it empty.
  const recoveredPaths = new Set((tails ?? []).map((tail) => tail.path));
  const lost = report ? report.problems.filter((problem) => !recoveredPaths.has(problem.path)) : [];

  return (
    <>
      <HelperOffer helper={helper}>
        With the A3EM Card Helper, a small program with a browser extension, copying also recovers what a recorder wrote before it lost power but had not yet recorded, and the card can be ejected from here once it is copied.
      </HelperOffer>
      {unreadable.length ? (
        <div className="banner crit">
          <strong>
            {unreadable.length.toLocaleString()} {unreadable.length === 1 ? 'item' : 'items'} could not be read
            while scanning
          </strong>
          The copy below will skip these and continue rather than stopping.
        </div>
      ) : null}

      <div className="card">
        <h2>Check recordings</h2>
        <p className="hint">
          Examines every file for corruption. Copying runs this automatically, but you can run it
          manually to see what can be repaired and what will be skipped.
        </p>

        {card.deviceInfo ? null : (
          // Worth stating outright. The original firmware overstated every WAV's audio
          // length by four bytes, and judging those recordings by the corrected rule would
          // condemn every last one of them. Saying so beats silently applying it.
          <p className="help">
            This card has no device file, so it was written by the original firmware.
            Recordings are checked against that older firmware's known quirks — including the
            audio length every WAV of that era overstates by four bytes.
          </p>
        )}

        {checking ? (
          <>
            <div className="meter">
              <i
                style={{
                  width: `${checking.total ? (checking.done / checking.total) * 100 : 0}%`,
                  background: 'var(--primary)',
                }}
              />
            </div>
            <p className="stat-note">
              Checked {checking.done.toLocaleString()} of {checking.total.toLocaleString()}
            </p>
          </>
        ) : (
          <button className="btn" onClick={() => void runCheck()}>
            Check {checkableCount.toLocaleString()} recordings
          </button>
        )}

        {report ? (
          <>
            <div className="grid stats" style={{ marginTop: 16 }}>
              <Stat label="Checked" value={report.checked.toLocaleString()} />
              <Stat label="Sound" value={report.byVerdict.ok.toLocaleString()} />
              <Stat
                label="Repairable"
                value={report.recoverable.length.toLocaleString()}
                tone={report.recoverable.length ? 'warn' : 'ok'}
              />
              <Stat label="Lost" value={lost.length.toLocaleString()} tone={lost.length ? 'crit' : 'ok'} />
            </div>

            {report.recoverable.length ? (
              // Deliberately above the losses. This is the good news, and it is the part
              // someone can actually act on — the audio is all there.
              <div className="banner warn" style={{ marginTop: 14, marginBottom: 0 }}>
                <strong>
                  {report.recoverable.length.toLocaleString()}{' '}
                  {report.recoverable.length === 1 ? 'recording was' : 'recordings were'} never closed
                  properly
                </strong>
                The audio in them is intact — the device lost power mid-clip and never wrote down how
                long each file was, so players see them as empty. Copy the card below and these will be
                repaired in the copy.
              </div>
            ) : null}

            {tails?.length ? (
              <div className="banner ok" style={{ marginTop: 14, marginBottom: 0 }}>
                <strong>
                  {tails.length === 1 ? '1 file holds' : `${tails.length.toLocaleString()} files hold`} more than the
                  card records
                </strong>
                What the recorder wrote before it lost power, and had not yet recorded. Copying adds it to{' '}
                {tails.length === 1 ? 'the file’s copy' : 'their copies'}; the card is not changed.
                <ul className="finding-paths">
                  {tails.map((tail) => (
                    <li key={tail.path}>
                      <span className="mono">{tail.path}</span> — {tail.summary}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {lost.length ? (
              <div className="scroll-x" style={{ marginTop: 14 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Problem</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lost.slice(0, 100).map((problem) => (
                      <tr key={problem.path}>
                        <td className="mono">{problem.path.split('/').pop()}</td>
                        <td>
                          <span className="chip crit">{RECORDING_VERDICT_LABELS[problem.verdict]}</span>
                        </td>
                        <td>{problem.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {lost.length > 100 ? (
                  <p className="stat-note">
                    Showing the first 100 of {lost.length.toLocaleString()}.
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="banner ok" style={{ marginTop: 14, marginBottom: 0 }}>
                <strong>No recordings were lost</strong>
                Nothing on this card is zero-length, cut short, or damaged.
              </div>
            )}
          </>
        ) : null}
      </div>

      <div className="card">
        <h2>Copy to a folder</h2>
        <p className="hint">
          Copies everything, repairing where possible and skipping anything unreadable. Re-running
          skips files already copied, so an interrupted transfer resumes rather than starting over.
        </p>

        {/*
          Offered where the copy is, not on the review page: the correction is decided
          while reading the card, but it is only ever APPLIED here, to the copy.
        */}
        {renamePlan && renamePlan.entries.length ? (
          <label className="check" style={{ marginBottom: 14 }}>
            <input
              type="checkbox"
              checked={applyCorrection}
              onChange={(event) => setApplyCorrection(event.target.checked)}
            />
            <span>
              Name the copies by their corrected times —{' '}
              <span className="mono">{correction ? describeCorrection(correction) : ''}</span>
              <span className="help" style={{ display: 'block', marginTop: 2 }}>
                {renamePlan.entries.length.toLocaleString()} recordings renamed in the copy.
                {renamePlan.skipped.length
                  ? ` ${renamePlan.skipped.length.toLocaleString()} have no timestamp and keep their names.`
                  : ''}{' '}
                The card itself is never written to.
              </span>
            </span>
          </label>
        ) : null}

        {looking ? (
          <p className="stat-note">
            Asking the card helper for what logs and IMU files hold past their recorded end, to add it to their
            copies. It may ask for your password.
          </p>
        ) : null}

        {progress ? (
          <>
            <div className="meter">
              <i
                style={{
                  width: `${progress.bytesTotal ? (progress.bytesDone / progress.bytesTotal) * 100 : 0}%`,
                  background: 'var(--primary)',
                }}
              />
            </div>
            <p className="stat-note">
              {progress.filesDone.toLocaleString()} of {progress.filesTotal.toLocaleString()} files ·{' '}
              {(progress.bytesDone / 1024 ** 3).toFixed(2)} of {(progress.bytesTotal / 1024 ** 3).toFixed(2)} GB
            </p>
            <p className="stat-note mono">{progress.currentPath}</p>
          </>
        ) : (
          <button className="btn primary" onClick={() => void runCopy()} disabled={!CARD_ACCESS_SUPPORTED}>
            Choose destination and copy {(totalBytes / 1024 ** 3).toFixed(2)} GB
          </button>
        )}

        {result ? (
          <>
            <div
              className={`banner ${result.skipped.length ? 'warn' : 'ok'}`}
              style={{ marginTop: 16, marginBottom: 14 }}
            >
              <strong>
                {result.canceled ? 'Copy canceled before finishing' : 'Copy finished'}
              </strong>
              {result.skipped.length
                ? 'Everything below was left behind. The same list is saved as a3em-copy-report.txt in the destination folder.'
                : 'Everything on the card transferred.'}
              {/* The next thing anyone does with a copied card is take it out. */}
              {cardDevice.device && !result.canceled ? (
                <div style={{ marginTop: 8 }}>
                  <button className="btn small" onClick={() => void cardDevice.eject()}>
                    Eject {card.name}
                  </button>
                </div>
              ) : null}
            </div>

            {result.recovered.length ? (
              <div className="banner ok" style={{ marginTop: 0, marginBottom: 14 }}>
                <strong>
                  {result.recovered.length === 1 ? '1 copy holds' : `${result.recovered.length.toLocaleString()} copies hold`}{' '}
                  what the card had not recorded
                </strong>
                What the recorder wrote past {result.recovered.length === 1 ? 'the file’s' : 'the files’'} recorded end,
                added in place. The card still gives the shorter length; a3em-copy-report.txt lists these.
                <ul className="finding-paths">
                  {result.recovered.map((entry) => (
                    <li key={entry.path}>
                      <span className="mono">{entry.path}</span> — {entry.summary}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {repair ? (
              <div
                className={`banner ${repair.failed.length ? 'warn' : 'ok'}`}
                style={{ marginTop: 0, marginBottom: 14 }}
              >
                <strong>
                  {repair.repaired.toLocaleString()}{' '}
                  {repair.repaired === 1 ? 'recording' : 'recordings'} repaired in the copy
                </strong>
                {repair.failed.length
                  ? `${repair.failed.length.toLocaleString()} could not be repaired and were left exactly as copied.`
                  : 'They now play at their full length. The originals on the card were not modified.'}
              </div>
            ) : null}

            <div className="grid stats">
              <Stat label="Copied" value={result.copied.toLocaleString()} tone="ok" />
              <Stat label="Already there" value={result.alreadyPresent.toLocaleString()} />
              <Stat
                label="Skipped"
                value={result.skipped.length.toLocaleString()}
                tone={result.skipped.length ? 'crit' : undefined}
              />
              <Stat label="Transferred" value={`${(result.bytesCopied / 1024 ** 3).toFixed(2)} GB`} />
            </div>

            {result.skipped.length ? (
              <div className="scroll-x" style={{ marginTop: 14 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>File left behind</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.skipped.slice(0, 100).map((skip) => (
                      <tr key={skip.path}>
                        <td className="mono">{skip.path}</td>
                        <td>{skip.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.skipped.length > 100 ? (
                  <p className="stat-note">
                    Showing the first 100 of {result.skipped.length.toLocaleString()} — the report file
                    has them all.
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {error ? (
          <div className="banner crit" style={{ marginTop: 16, marginBottom: 0 }}>
            <strong>Copy failed</strong>
            {error}
          </div>
        ) : null}
      </div>
    </>
  );
}

function Stat({ label, value, tone }: Readonly<{ label: string; value: string; tone?: 'ok' | 'warn' | 'crit' }>) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </div>
    </div>
  );
}
