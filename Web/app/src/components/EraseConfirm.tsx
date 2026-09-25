import { useEffect, useRef } from 'react';

/**
 * Confirming which cards to erase, before "Prepare this card" erases any: on Prepare devices and
 * on Configure alike.
 */

export interface Confirmation {
  device: string;
  label: string;
  description: string;
  /** What erasing it fixes, from the check. */
  fixes: string[];
  confirmed: boolean;
}

/** Check titles as they appear in a card's checks, so each can be found there. */
export function listed(titles: string[]): string {
  const quoted = titles.map((title) => `“${title}”`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}` : (quoted[0] ?? '');
}

/**
 * One confirmation per card, in the helper's words.
 *
 * The helper's description names the device node, size, bus and what is on it now — the
 * details that tell two identical cards apart, or a card from the drive plugged in beside it.
 */
export function ConfirmDialog({
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
        Everything on {entries.length > 1 ? 'these cards' : 'this card'} will be erased. Check each one to confirm it
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
                <span className="muted">
                  Becomes {entry.label}. Erasing fixes {listed(entry.fixes)}.
                </span>
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
