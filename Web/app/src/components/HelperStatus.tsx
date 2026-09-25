import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps } from 'react';
import type { Helper } from '../lib/useHelper';
import { helperUpdateAvailable, LATEST_HELPER_RELEASE } from '../lib/helper';

/**
 * The card helper, in two places, because it is two different kinds of thing.
 *
 * **Ambient capability** — whether card tools exist at all — belongs in the rail foot with
 * the firmware version. It is answered once, rarely changes, and nothing about it is
 * urgent. It sat in the top bar first, beside Rescan and Disconnect, where a full-size
 * button for an optional feature competed with the controls people actually came to press.
 *
 * **A running operation** — a format, a repair, an image — belongs in the top bar, because
 * it is time-critical and that is where someone looks to find out what the app is doing to
 * their card right now.
 *
 * Splitting them is the whole point: they were one component only because they came from
 * one hook.
 */

// ---------------------------------------------------------------------------
// Top bar: only while something is running
// ---------------------------------------------------------------------------

/**
 * A running operation.
 *
 * Shows elapsed time even where there is no measurable progress, because that is the
 * common case — `fsck` reports nothing until it finishes, and a spinner with no number
 * beside it is indistinguishable from a hung page after the first thirty seconds.
 */
export function HelperTaskChip({ helper }: Readonly<{ helper: Helper }>) {
  const task = helper.task;
  if (!task) return null;

  const progress = task.progress;
  const elapsed = progress?.elapsedMs ?? Date.now() - task.startedAt;
  const percent =
    progress?.totalBytes && progress.bytesCopied != null && progress.totalBytes > 0
      ? Math.floor((progress.bytesCopied / progress.totalBytes) * 100)
      : null;

  return (
    <span className="chip" role="status" aria-live="polite">
      <span className="dot" />
      {/* The helper's notes are sentences; here each is followed by a separator instead. */}
      {task.note.replace(/\.\s*$/, '')}
      {percent !== null ? ` · ${percent}%` : ''}
      {` · ${formatElapsed(elapsed)}`}
      {progress?.badSectors ? ` · ${progress.badSectors} unreadable sectors` : ''}
    </span>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

// ---------------------------------------------------------------------------
// Rail foot: the ambient capability
// ---------------------------------------------------------------------------

/**
 * Whether card tools are available, as a quiet line at the bottom of the rail.
 *
 * Silent when there is nothing to offer and nothing wrong. Most users will never install
 * the helper and the dashboard is fully usable without it, so this is a small standing
 * offer rather than a notice — nagging about an optional capability on every page load
 * teaches people to stop reading the chrome, which is where real card problems appear.
 */
export function HelperRailStatus({ helper }: Readonly<{ helper: Helper }>) {
  const [showGuide, setShowGuide] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  // What the helper found missing on this computer, such as a Linux package it relies on.
  const issues = helper.status === 'ready' ? (helper.identity?.issues ?? []) : [];
  const problems = issues.filter((issue) => issue.severity === 'problem').length;
  // A newer release than the one installed, which this one still works with.
  const update = helper.status === 'ready' && helperUpdateAvailable(helper.identity?.version);

  if (helper.status === 'unsupported') {
    // Browser capability is already stated by CardStatus. Saying it twice adds noise
    // without adding information.
    return null;
  }

  if (helper.status === 'checking') {
    // Said rather than left blank: asking the helper what it can see takes a moment, and an
    // empty space where the status belongs reads as something having gone wrong.
    return (
      <div className="rail-foot-row">
        <span className="rail-foot-label">A3EM Card Helper</span>
        <span className="rail-foot-value muted">Loading…</span>
      </div>
    );
  }

  return (
    <>
      <div className="rail-foot-row">
        <span className="rail-foot-label">A3EM Card Helper</span>
        {helper.status === 'absent' || helper.status === 'outdated' ? (
          <button
            className="rail-foot-action"
            title={helper.status === 'outdated' ? `A3EM Card Helper ${helper.identity?.version} is older than this dashboard.` : undefined}
            onClick={() => setShowGuide(true)}
          >
            {helper.status === 'outdated' ? 'Update…' : 'Enable…'}
          </button>
        ) : update || issues.length ? (
          <span className="rail-foot-value ok" title={`A3EM Card Helper ${helper.identity?.version} on ${helper.identity?.platform}`}>
            ready
            {update ? (
              <>
                {' · '}
                <button
                  className="rail-foot-action"
                  title={`A3EM Card Helper ${LATEST_HELPER_RELEASE} is available; this computer has ${helper.identity?.version}.`}
                  onClick={() => setShowGuide(true)}
                >
                  update available
                </button>
              </>
            ) : null}
            {issues.length ? (
              <>
                {' · '}
                <button className={`rail-foot-action ${problems ? 'warn' : ''}`} onClick={() => setShowIssues(true)}>
                  {problems
                    ? `${problems} ${problems === 1 ? 'problem' : 'problems'}`
                    : `${issues.length} ${issues.length === 1 ? 'note' : 'notes'}`}
                </button>
              </>
            ) : null}
          </span>
        ) : (
          <span
            className={`rail-foot-value ${helper.status === 'incomplete' ? 'warn' : 'ok'}`}
            title={
              helper.status === 'incomplete'
                ? `The helper runs on ${helper.identity?.platform} but implements no card operations yet.`
                : `A3EM Card Helper ${helper.identity?.version} on ${helper.identity?.platform}`
            }
          >
            {helper.status === 'incomplete' ? `unavailable on ${helper.identity?.platform}` : 'ready'}
          </span>
        )}
      </div>
      {showGuide ? (
        <InstallGuideDialog
          outdated={helper.status === 'outdated'}
          update={update ? { installed: helper.identity?.version ?? '', latest: LATEST_HELPER_RELEASE } : undefined}
          onClose={() => setShowGuide(false)}
        />
      ) : null}
      {showIssues ? <SystemIssuesDialog issues={issues} onClose={() => setShowIssues(false)} /> : null}
    </>
  );
}

/**
 * What the helper found missing on this computer, and what to install.
 *
 * Checked when the helper starts, so a missing package is said once, in the rail, rather than
 * as a puzzling failure the first time someone presses the button that needs it.
 */
function SystemIssuesDialog({
  issues,
  onClose,
}: Readonly<{ issues: Array<{ severity: 'problem' | 'note'; message: string }>; onClose: () => void }>) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    element.showModal();
    element.addEventListener('close', onClose);
    return () => element.removeEventListener('close', onClose);
  }, [onClose]);
  const problems = issues.filter((issue) => issue.severity === 'problem');
  const notes = issues.filter((issue) => issue.severity !== 'problem');
  return (
    <dialog className="modal" ref={dialog} aria-label="A3EM Card Helper on this computer">
      <h2>A3EM Card Helper on this computer</h2>
      <p className="hint">
        The A3EM Card Helper is installed and working, but this computer is missing things some of its tools rely on.
      </p>
      {problems.length ? (
        <div className="banner warn">
          <strong>{problems.length === 1 ? 'Needs fixing' : `${problems.length} things need fixing`}</strong>
          <ul className="findings">
            {problems.map((issue) => (
              <li key={issue.message}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {notes.length ? (
        <ul className="findings">
          {notes.map((issue) => (
            <li key={issue.message} className="hint">
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="modal-actions">
        <button className="btn" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}

/*
  The install guide, loaded on its own, since most visits never open it. It is fetched once the
  dashboard knows it could be wanted rather than when it is opened, as the helper's screens are
  (`helperViews`): a page that has lost its connection since can still show it.
*/
export const loadInstallGuide = () => import('./InstallGuide');
const Guide = lazy(() => loadInstallGuide().then((module) => ({ default: module.InstallGuideDialog })));

/** What to install, for the operating system the browser is running on: see `InstallGuide`. */
export function InstallGuideDialog(props: ComponentProps<typeof Guide>) {
  return (
    <Suspense fallback={null}>
      <Guide {...props} />
    </Suspense>
  );
}
