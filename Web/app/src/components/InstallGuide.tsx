import { useEffect, useRef } from 'react';
import { EXTENSION_STORE_URL, installGuide, withoutExtension } from '../lib/helperInstall';

/**
 * What to install, for the operating system the browser is running on.
 *
 * States the platform caveat first where there is one. Someone on Windows following three
 * installation steps to reach a tool that cannot do anything yet would rightly be annoyed,
 * and finding that out at the end is worse than being told at the start.
 */
export function InstallGuideDialog({
  outdated,
  update,
  onClose,
}: Readonly<{
  outdated: boolean;
  /** A newer release than the one installed, which still works with this dashboard. */
  update?: { installed: string; latest: string };
  onClose: () => void;
}>) {
  const guide = installGuide();
  // A helper that answered came through the extension, so only the helper needs installing.
  const replacing = outdated || Boolean(update);
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
    <dialog className="modal" ref={dialog} aria-label={outdated || update ? 'Update the A3EM Card Helper' : 'Install the A3EM Card Helper'}>
      <h2>{outdated || update ? 'Update the A3EM Card Helper' : 'Install the A3EM Card Helper'}</h2>
      <p className="hint">
        The A3EM Card Helper gives the dashboard low-level access to SD cards: it tests that a card really holds
        what it claims, formats it with the exact layout the recorder expects, checks that a card is ready to
        deploy, and ejects it safely. Everything else in the dashboard works without it. It comes in two pieces, a
        small program and a browser extension. Neither sends anything over the internet; see the{' '}
        <a href="privacy.html" target="_blank" rel="noopener">
          privacy policy
        </a>
        .
      </p>

      {outdated ? (
        <div className="banner warn" style={{ marginTop: 12 }}>
          The A3EM Card Helper on this computer is older than this dashboard. Install the current one below; it
          replaces the old one.
        </div>
      ) : update ? (
        <div className="banner ok" style={{ marginTop: 12 }}>
          <strong>A3EM Card Helper {update.latest} is available</strong>
          This computer has {update.installed}, which still works. Install the new one below to get its fixes and
          improvements; it replaces the old one, and the browser extension stays as it is.
        </div>
      ) : null}

      {guide.caveat ? (
        <div className="banner warn" style={{ marginTop: 12 }}>
          {guide.caveat}
        </div>
      ) : null}

      <p className="stat-label" style={{ marginTop: 16 }}>
        Setting up on {guide.osLabel}
      </p>

      <ol className="install-steps">
        {(replacing ? withoutExtension(guide.steps) : guide.steps).map((step) => (
          <li key={step.title}>
            <strong>{step.title}</strong>
            <div className="hint">{step.detail}</div>
            {step.command ? <code className="install-command">{step.command}</code> : null}
            {step.link ? (
              <a className="btn small install-link" href={step.link.href} target="_blank" rel="noreferrer">
                {step.link.label}
              </a>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="modal-actions">
        {EXTENSION_STORE_URL && !replacing ? (
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
