import { useMemo, useRef, useState } from 'react';
import type { OffloadTask } from '../lib/useOffloadTask';
import { RECORDING_VERDICT_LABELS, describeCorrection, planRename } from '@a3em/config-schema';
import type { CorrectionState } from '../App';
import { useClockCorrection } from '../lib/useClockCorrection';
import { CARD_ACCESS_SUPPORTED } from '../lib/card';
import { chooseCopyFolder, copyViaHelper, diagnoseVolume, helperCanCopy } from '../lib/helper';
import { copyCardViaHelper } from '../lib/helperCopy';
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
    The controller for the copy in flight.

    A copy of a full card is tens of thousands of files and can run for a long time, and
    until now the only way out was closing the tab - which leaves a half-written folder and
    no account of what made it. `copyCard` already stops between files when its signal
    aborts and reports `canceled`, so the whole of this is giving the operator the signal.
  */
  const abort = useRef<AbortController | null>(null);
  // A copy stops at the next file boundary, which on a large clip is not instant, so the
  // button reports that it was heard rather than appearing to do nothing.
  const [stopping, setStopping] = useState(false);

  /*
    Correcting the clock as the files are COPIED, rather than renaming them on the card.

    Same arithmetic as before, applied to the destination instead of the source: the card
    keeps the names the device wrote, so there is nothing to undo, and a correction that
    later proves wrong costs another copy rather than a lost original.
  */
  const { correction } = useClockCorrection(card, correctionState);
  const [applyCorrection, setApplyCorrection] = useState(true);
  // Data in logs and IMU files past the size the card lists for them, found by a filesystem check of this card.
  const { tails, setTails } = useRecoveredTails(cardDevice.device, cardDevice.volumeId);
  // Which button is waiting on that filesystem check, so the note appears beside it.
  const [looking, setLooking] = useState<'check' | 'copy' | null>(null);
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
          With the A3EM Card Helper, a small program with a browser extension, checking and copying also find log and IMU data that a recorder wrote but never added to the file’s size on the card, as happens when it loses power or is reset, and the card can be ejected from here once it is copied.
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

  /*
    Data the recorder wrote to logs and IMU files past the size the card lists for them.

    Only the card helper can see it, by checking the filesystem, which asks for the password
    once. It is part of what a check reports as well as what a copy recovers: the check says
    what the copy will do, so leaving this to the copy made the check's account incomplete and
    had its findings appear only once copying began. A check already made of this card, here or
    on "Review card", is used instead of asking again. Without the helper, or the password, the
    answer is that nothing is found and the copy takes the files as the card lists them.
  */
  const findTails = async (purpose: 'check' | 'copy') => {
    if (tails) return tails;
    if (!cardDevice.device || !cardDevice.volumeId) return [];
    setLooking(purpose);
    try {
      const found = await diagnoseVolume(cardDevice.volumeId);
      const accepted = found.engine === 'a3em' ? acceptTails(found.tails, longestClip(card.existingConfig)) : [];
      setTails(accepted);
      return accepted;
    } catch {
      return [];
    } finally {
      setLooking(null);
    }
  };

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
    await findTails('check');
  };

  const runCopy = async () => {
    setError(null);
    setResult(null);
    setRepair(null);
    try {
      /*
        Two ways to copy, and the destination is chosen differently by each.

        Where the helper can do it, it does: Chrome writes every file through a `.crswap`
        temporary and a rename, which on Windows costs a card of recordings several
        filesystem operations and a flush apiece, all crossing the browser's permission
        boundary. The helper is a sequential read and write.

        Its folder has to come from its own dialog. A File System Access handle carries no
        path, so a folder picked here is one the helper cannot write into — which is why
        this one picker looks like the system's rather than the browser's.
      */
      const native = helperCanCopy(helper.identity) && Boolean(cardDevice.volumeId);
      let destination: FileSystemDirectoryHandle | null = null;
      let nativePath = '';
      if (native) {
        nativePath = await chooseCopyFolder(cardDevice.volumeId!);
      } else {
        const picker = window as unknown as {
          showDirectoryPicker: (o?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
        };
        destination = await picker.showDirectoryPicker({ mode: 'readwrite' });
      }

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

      // What the check found past files' listed sizes, to go into their copies (see findTails)
      const recovered = await findTails('copy');

      const controller = new AbortController();
      abort.current = controller;
      setStopping(false);
      const additions = new Map(recovered.map((tail) => [tail.path, tail]));
      // Clips the device never closed, to be mended in the copy so the card's own header is
      // left as the device wrote it. Keyed by source path, which is what both copies see.
      const repairs = new Map(
        (findings?.recoverable ?? []).filter((file) => file.repair).map((file) => [file.path, file.repair!]),
      );

      const copyResult = native
        ? await copyCardViaHelper(card.contents!.entries, cardDevice.volumeId!, nativePath, {
            onProgress: setProgress,
            signal: controller.signal,
            renameTo,
            additions,
            // The helper mends headers as it writes; the browser path needs a second pass.
            repairs,
          })
        : await copyCard(card.contents!.entries, destination!, {
            onProgress: setProgress,
            signal: controller.signal,
            renameTo,
            additions,
          });
      setResult(copyResult);

      // What was copied before a stop still needs its report and its repairs, so a canceled
      // run leaves a folder that says what is in it rather than one that does not.
      const landed = new Set(copyResult.skipped.map((skip) => skip.path));
      const mended = [...repairs.keys()].filter((path) => !landed.has(path));
      if (mended.length) {
        setRepair(
          native
            ? // Written during the copy, so a file that landed was mended with it.
              { repaired: mended.length, failed: [] }
            : await repairWavHeaders(
                destination!,
                // Destination paths, not source ones: a renamed copy is no longer where the
                // check found it, and repairing by the original path would miss every file.
                mended.map((path) => ({ path: renameTo?.get(path) ?? path, repair: repairs.get(path)! })),
              ),
        );
      }

      // The account of what was skipped goes next to the copy, so it survives the session
      // rather than living only on screen. It depends on what the copy did, so the helper
      // is asked to deposit it afterwards rather than handed it at the start.
      if (copyResult.skippedTotal || copyResult.recovered.length) {
        const manifest = buildSkipManifest(copyResult, card.name ?? 'card');
        if (native) {
          await copyViaHelper(cardDevice.volumeId!, nativePath, [], { report: manifest });
        } else {
          const handle = await destination!.getFileHandle('a3em-copy-report.txt', { create: true });
          const writable = await handle.createWritable();
          await writable.write(manifest);
          await writable.close();
        }
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      abort.current = null;
      setStopping(false);
      setProgress(null);
    }
  };

  const totalBytes = layout.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  // A copy where every file failed is a different outcome from one that left a few behind
  const nothingCopied = Boolean(result && !result.canceled && result.skippedTotal && !result.copied && !result.alreadyPresent);
  // A file whose data is recovered into its copy is not lost, though the card records it empty.
  const recoveredPaths = new Set((tails ?? []).map((tail) => tail.path));
  const lost = report ? report.problems.filter((problem) => !recoveredPaths.has(problem.path)) : [];

  return (
    <>
      <HelperOffer helper={helper}>
        With the A3EM Card Helper, a small program with a browser extension, checking and copying also find log and IMU data that a recorder wrote but never added to the file’s size on the card, as happens when it loses power or is reset, and the card can be ejected from here once it is copied.
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
          manually to see what can be repaired and what will be skipped. With the A3EM Card Helper, it also
          checks the filesystem for log and IMU data the card does not list, which may ask for your password.
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
          <button className="btn" onClick={() => void runCheck()} disabled={Boolean(looking)}>
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

            {looking === 'check' ? (
              <p className="stat-note" style={{ marginTop: 14 }}>
                Asking the A3EM Card Helper to check the filesystem for log and IMU data the card does not list.
                It may ask for your password.
              </p>
            ) : null}

            {tails?.length ? (
              <div className="banner ok" style={{ marginTop: 14, marginBottom: 0 }}>
                <strong>
                  {tails.length === 1 ? '1 file has' : `${tails.length.toLocaleString()} files have`} more data than
                  the card lists
                </strong>
                The recorder wrote this data, then stopped before updating {tails.length === 1 ? 'the file’s' : 'the files’'}{' '}
                size on the card, as happens when it loses power or is reset. Copying includes it in{' '}
                {tails.length === 1 ? 'the copy' : 'the copies'}; the files on the card are not changed.
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

        {looking === 'copy' ? (
          <p className="stat-note">
            Asking the A3EM Card Helper to check the filesystem for log and IMU data the card does not list, to include
            it in the copies. It may ask for your password.
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
            <button
              className="btn small"
              onClick={() => {
                setStopping(true);
                abort.current?.abort();
              }}
              disabled={stopping}
            >
              {stopping ? 'Stopping after this file…' : 'Stop copying'}
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={() => void runCopy()} disabled={!CARD_ACCESS_SUPPORTED || Boolean(looking)}>
            Choose destination and copy {(totalBytes / 1024 ** 3).toFixed(2)} GB
          </button>
        )}

        {result ? (
          <>
            <div
              className={`banner ${nothingCopied ? 'crit' : result.skippedTotal ? 'warn' : 'ok'}`}
              style={{ marginTop: 16, marginBottom: 14 }}
            >
              <strong>
                {result.canceled ? 'Copy canceled before finishing' : nothingCopied ? 'Nothing was copied' : 'Copy finished'}
              </strong>
              {nothingCopied
                ? 'Every file failed. The reasons are below, and in a3em-copy-report.txt in the destination folder.'
                : result.skippedTotal
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
                  {result.recovered.length === 1 ? '1 copy includes' : `${result.recovered.length.toLocaleString()} copies include`}{' '}
                  data the card does not list
                </strong>
                Data the recorder wrote past {result.recovered.length === 1 ? 'the file’s' : 'each file’s'} size on the
                card, added to the end of the copy. The files on the card still show the shorter size;
                a3em-copy-report.txt lists these.
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
                value={`${result.skippedTotal.toLocaleString()}${result.skippedTotalIsMinimum ? '+' : ''}`}
                tone={result.skippedTotal ? 'crit' : undefined}
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
                {result.skippedTotal > 100 ? (
                  <p className="stat-note">
                    Showing the first 100 of {result.skippedTotal.toLocaleString()}
                    {result.skippedTotalIsMinimum ? ' or more' : ''}
                    {result.skippedTotal > result.skipped.length
                      ? ` — the report file lists the first ${result.skipped.length.toLocaleString()}.`
                      : ' — the report file has them all.'}
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
