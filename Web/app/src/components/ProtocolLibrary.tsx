import { useEffect, useRef, useState } from 'react';
import { Pane } from './Pane';
import {
  matchesProtocol,
  type DeploymentConfig,
  type Protocol,
  type ProtocolProvenance,
} from '@a3em/config-schema';

/**
 * The protocol library, as a disclosure whose default state follows the workflow.
 *
 * A protocol is chosen once, at the start of a deployment, and then not touched again for
 * the rest of the session — so a grid of five cards, each with a description and two
 * buttons, held open above the settings for the whole time is most of a screen spent on a
 * decision already made.
 *
 * Rather than leaving that for the user to manage with a toggle they have to remember, the
 * open state is derived from where they are:
 *
 *  - **Nothing chosen yet** — open. This is the "first thing used rather than a filing
 *    cabinet visited afterwards" case the feature exists for.
 *  - **A choice made** — collapsed, automatically, to a summary line that still says what
 *    the deployment is based on and whether it has drifted since.
 *
 * So the common path costs no clicks at all: the pane is open when you arrive, you pick,
 * and it gets out of the way. It can still be opened and closed by hand at any time.
 *
 * The summary line absorbs what used to be a separate `basedOn` banner inside the pane, so
 * collapsing loses nothing — the provenance was already being stated, just lower down and
 * only when the pane was open.
 */
export function ProtocolLibrary({
  config,
  protocols,
  basedOn,
  onApply,
  onRemove,
  onDetach,
  onStartBlank,
}: Readonly<{
  config: DeploymentConfig;
  protocols: Protocol[];
  basedOn: ProtocolProvenance | null;
  onApply: (protocol: Protocol) => void;
  onRemove: (id: string) => void;
  onDetach: () => void;
  onStartBlank: () => void;
}>) {
  const current = basedOn ? protocols.find((protocol) => protocol.id === basedOn.protocolId) : undefined;
  // Only meaningful against a protocol that still exists — one deleted since is gone.
  const drifted = current ? !matchesProtocol(config, current) : false;

  const [open, setOpen] = useState(!basedOn);

  /**
   * Collapse when a protocol is applied from elsewhere.
   *
   * Applying is not always a click in here — `useDraft` can restore a saved deployment,
   * and the editor offers to load one found on a card. Watching the provenance rather
   * than only the button covers all of those with one rule.
   */
  const lastApplied = useRef(basedOn?.protocolId ?? null);
  useEffect(() => {
    const applied = basedOn?.protocolId ?? null;
    if (applied !== lastApplied.current) {
      lastApplied.current = applied;
      if (applied) setOpen(false);
    }
  }, [basedOn]);

  /** Choosing anything — including the blank configuration — is a decision made. */
  const choose = (run: () => void) => {
    run();
    setOpen(false);
  };

  // Built here rather than inline: a nested ternary inside the markup is where this kind
  // of label quietly stops matching what the banner below it says.
  let summary = 'Blank configuration';
  if (basedOn) {
    summary = `${basedOn.name} v${basedOn.version}${drifted ? ' — changed since' : ''}`;
  }

  return (
    /*
      Controlled, unlike every other pane: this one's state is derived from the workflow
      rather than chosen, so it must not be remembered across sessions. It used to be a
      hand-rolled `<button aria-expanded>` with its own caret and a "Change"/"Hide" label
      — the same job as Pane, done twice, which is how it ended up with a black heading in
      dark mode when the shared version did not. The summary line survives as the note,
      because that is the part that made collapsing safe.
    */
    <Pane
      id="protocol-library"
      title="Start from a protocol"
      note={<span className={drifted ? 'drifted' : undefined}>{summary}</span>}
      open={open}
      onOpenChange={setOpen}
    >
      <div>
          <p className="hint">
            A protocol holds the recording settings you use over and over. Choosing one replaces every
            recording setting except the device label, deployment start and end dates, and the timezone,
            which are always kept as you have them.
          </p>

          {basedOn ? (
            <div className={`banner ${drifted ? 'warn' : 'ok'}`} style={{ marginBottom: 14 }}>
              <strong>
                Based on {basedOn.name} v{basedOn.version}
                {drifted ? ' — changed since' : ''}
              </strong>
              {drifted
                ? 'This deployment no longer matches the protocol. That is fine — the save options sit beside the write button.'
                : 'These settings match the protocol exactly.'}
              <button className="btn small ghost" style={{ marginTop: 8 }} onClick={onDetach}>
                Detach — keep these settings but stop tracking the protocol
              </button>
            </div>
          ) : null}

          <div className="protocol-grid">
            {/* Reachable as a choice rather than only as a starting state — once a protocol
                is applied there has to be a way back to no protocol at all. */}
            <div className={`protocol${basedOn ? '' : ' current'}`}>
              <div className="protocol-head">
                <strong>Blank configuration</strong>
              </div>
              <p className="protocol-desc">
                Default device settings, tracking no protocol.
              </p>
              <div className="protocol-actions">
                <button className="btn small" onClick={() => choose(onStartBlank)}>
                  Use this
                </button>
              </div>
            </div>

            {protocols.map((protocol) => {
              const isCurrent = protocol.id === basedOn?.protocolId;
              return (
                <div className={`protocol${isCurrent ? ' current' : ''}`} key={protocol.id}>
                  <div className="protocol-head">
                    <strong>{protocol.name}</strong>
                    <span className="chip">{protocol.builtIn ? 'Built in' : `v${protocol.version}`}</span>
                  </div>
                  <p className="protocol-desc">{protocol.description || 'No description.'}</p>
                  <div className="protocol-actions">
                    <button className="btn small" onClick={() => choose(() => onApply(protocol))}>
                      {isCurrent ? 'Re-apply' : 'Use this'}
                    </button>
                    {!protocol.builtIn ? (
                      <button
                        className="btn small ghost"
                        // Deleting is not choosing: the pane stays open, because the next
                        // thing you do is almost certainly pick a different one.
                        onClick={() => onRemove(protocol.id)}
                        aria-label={`Delete ${protocol.name}`}
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
      </div>
    </Pane>
  );
}
