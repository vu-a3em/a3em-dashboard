import { useState } from 'react';
import { matchesProtocol, type DeploymentConfig, type Protocol, type ProtocolProvenance } from '@a3em/config-schema';

/**
 * Saving the current settings as a protocol, in the sticky column beside the write button.
 *
 * Placed here rather than with the library at the top of the page because of when it is
 * wanted. Choosing a protocol happens first and belongs at the top; saving one happens
 * last, after the settings are right — and by then the top of the page is far out of
 * sight. This stays on screen throughout, next to the action that ends the task.
 *
 * Deliberately not a warning. The draft is written to local storage on every change, so
 * nothing is lost by never saving a protocol; what is lost is only having these settings
 * ready for the next deployment. Dressing that up as unsaved-work would claim a danger
 * that does not exist, and would train people to dismiss the prompt.
 */
export function ProtocolSave({
  config,
  protocols,
  basedOn,
  onSaveNew,
  onSaveOver,
}: Readonly<{
  config: DeploymentConfig;
  protocols: Protocol[];
  basedOn: ProtocolProvenance | null;
  onSaveNew: (name: string, description: string) => void;
  onSaveOver: (protocol: Protocol) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<string | null>(null);

  const current = basedOn ? protocols.find((protocol) => protocol.id === basedOn.protocolId) : undefined;
  const drifted = current ? !matchesProtocol(config, current) : false;

  const save = () => {
    if (!name.trim()) return;
    onSaveNew(name, '');
    setSaved(name.trim());
    setName('');
    setOpen(false);
  };

  const saveOver = () => {
    if (!current) return;
    onSaveOver(current);
    setSaved(`${current.name} v${current.version + 1}`);
  };

  return (
    <div className="card">
      <h2>Protocol</h2>

      {current && !drifted ? (
        <p className="stat-note">
          Matches {current.name} v{current.version}.
        </p>
      ) : null}

      {drifted && current ? (
        <>
          <p className="stat-note">You have changed these settings since applying {current.name}.</p>
          {!current.builtIn ? (
            <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={saveOver}>
              Save as {current.name} v{current.version + 1}
            </button>
          ) : null}
        </>
      ) : null}

      {open ? (
        <div style={{ marginTop: 8 }}>
          <div className="field" style={{ marginBottom: 8 }}>
            <label htmlFor="save-protocol-name">Name it</label>
            <input
              id="save-protocol-name"
              value={name}
              autoFocus
              placeholder="Dawn chorus — Bear Hollow"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && save()}
            />
          </div>
          <div className="row">
            <button className="btn primary" style={{ flex: 1, justifyContent: 'center' }} disabled={!name.trim()} onClick={save}>
              Save
            </button>
            <button className="btn ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="btn"
          style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
          onClick={() => {
            setOpen(true);
            setSaved(null);
          }}
        >
          Save as a new protocol
        </button>
      )}

      {saved ? <p className="stat-note" style={{ marginTop: 7, color: 'var(--ok)' }}>Saved {saved}.</p> : null}

      <p className="stat-note" style={{ marginTop: 7 }}>
        Save this deployment's recording settings under a name so that you can reuse them again in
        the future.
      </p>
    </div>
  );
}
