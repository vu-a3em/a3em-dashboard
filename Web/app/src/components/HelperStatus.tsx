import { useEffect, useRef, useState } from 'react';
import type { Helper } from '../lib/useHelper';
import { EXTENSION_STORE_URL, installGuide } from '../lib/helperInstall';

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
      {task.note}
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

  if (helper.status === 'checking' || helper.status === 'unsupported') {
    // Browser capability is already stated by CardStatus. Saying it twice adds noise
    // without adding information.
    return null;
  }

  return (
    <>
      <div className="rail-foot-row">
        <span className="rail-foot-label">Card tools</span>
        {helper.status === 'absent' ? (
          <button className="rail-foot-action" onClick={() => setShowGuide(true)}>
            Enable…
          </button>
        ) : (
          <span
            className={`rail-foot-value ${helper.status === 'incomplete' ? 'warn' : 'ok'}`}
            title={
              helper.status === 'incomplete'
                ? `The helper runs on ${helper.identity?.platform} but implements no card operations yet.`
                : `Card helper ${helper.identity?.version} on ${helper.identity?.platform}`
            }
          >
            {helper.status === 'incomplete' ? `unavailable on ${helper.identity?.platform}` : 'ready'}
          </span>
        )}
      </div>
      {showGuide ? <InstallGuideDialog onClose={() => setShowGuide(false)} /> : null}
    </>
  );
}

/**
 * What to install, for the operating system the browser is running on.
 *
 * States the platform caveat first where there is one. Someone on Windows following three
 * installation steps to reach a tool that cannot do anything yet would rightly be annoyed,
 * and finding that out at the end is worse than being told at the start.
 */
function InstallGuideDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const guide = installGuide();
  const dialog = useRef<HTMLDialogElement>(null);

  /**
   * A real `<dialog>` opened with `showModal`, rather than a div with `role="dialog"`.
   *
   * The platform gives focus trapping, Escape to close, inertness of the page behind, and
   * the `::backdrop` pseudo-element — all of which a hand-rolled overlay has to
   * reimplement and usually gets wrong. `close` fires for Escape as well as for the
   * button, so there is one path out.
   */
  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    element.showModal();
    element.addEventListener('close', onClose);
    return () => element.removeEventListener('close', onClose);
  }, [onClose]);

  return (
    <dialog className="modal" ref={dialog} aria-label="Enable card tools">
      <h2>Enable card tools</h2>
      <p className="hint">
        These tools provide low-level access to an SD card, allowing this dashboard to format
        correctly, recover one that will not mount, eject safely, and warn you when a card may be
        unusable for deployment. Everything in the dashboard works without these tools, but it may
        require additional steps to get your cards properly configured. Instructions to enable these
        tools are as follows:
      </p>

      {guide.caveat ? (
        <div className="banner warn" style={{ marginTop: 12 }}>
          {guide.caveat}
        </div>
      ) : null}

      <p className="stat-label" style={{ marginTop: 16 }}>
        Setting up on {guide.osLabel}
      </p>

      <ol className="install-steps">
        {guide.steps.map((step) => (
          <li key={step.title}>
            <strong>{step.title}</strong>
            <div className="hint">{step.detail}</div>
            {step.command ? <code className="install-command">{step.command}</code> : null}
          </li>
        ))}
      </ol>

      <div className="modal-actions">
        {EXTENSION_STORE_URL ? (
          <a className="btn primary" href={EXTENSION_STORE_URL} target="_blank" rel="noreferrer">
            Open the Chrome Web Store
          </a>
        ) : null}
        <button className="btn" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
