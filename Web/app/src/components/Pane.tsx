import { useState, type ReactNode } from 'react';

/**
 * A titled pane that collapses to its heading.
 *
 * Two panes already did this by hand with `<details className="card">`, and the styling
 * for it was already in place; this is the same arrangement made general so every pane
 * behaves alike rather than two of them being special. `<details>` is used rather than a
 * button and a conditional because it gets keyboard operation, the disclosure role and
 * in-page find-on-collapsed-content from the browser for free.
 *
 * Whether a pane is open is a per-reader preference, not part of a deployment, so it
 * lives in this browser and never reaches a card or a protocol. Nothing depends on it
 * surviving, which is why every access is wrapped: a private window or blocked site data
 * makes `localStorage` throw, and a pane that cannot remember its state is not a failure.
 */
const STORAGE_KEY = 'a3em.panes';

function readPreference(id: string): boolean | undefined {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return undefined;
    const value = (JSON.parse(stored) as Record<string, unknown>)[id];
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

function writePreference(id: string, open: boolean): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const all = stored ? (JSON.parse(stored) as Record<string, boolean>) : {};
    all[id] = open;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* Remembering is a convenience. Losing it costs one click. */
  }
}

export function Pane({
  id,
  title,
  note,
  className,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  children,
}: Readonly<{
  /**
   * Stable across renders and INDEPENDENT of the title — several panes name the phase
   * they are editing, and keying on that would forget the state on every phase switch.
   */
  id: string;
  title: ReactNode;
  /**
   * Shown beside the title, so a collapsed pane still says what is inside it.
   *
   * This is what makes collapsing worth having: a pane that shuts to a bare title has
   * only hidden something, while one that shuts to "Continuous · 16 kHz · 10 s clips"
   * has summarized it. Keep it to a few values, in the order the pane presents them.
   */
  note?: ReactNode;
  className?: string;
  /** Used only until the reader opens or shuts the pane themselves. */
  defaultOpen?: boolean;
  /**
   * Makes the pane controlled, for the one case where its state is derived from the
   * workflow rather than chosen: the protocol library shuts itself once a protocol is
   * applied, from in here or from a draft restore. A controlled pane is NOT remembered,
   * because whatever computes it will compute it again next time.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}>) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(() => readPreference(id) ?? defaultOpen);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : uncontrolledOpen;

  return (
    <details
      className={className ? `card ${className}` : 'card'}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === open) return;
        if (controlled) {
          onOpenChange?.(next);
          return;
        }
        setUncontrolledOpen(next);
        writePreference(id, next);
      }}
    >
      <summary>
        <h2>{title}</h2>
        {note ? <span className="summary-note">{note}</span> : null}
      </summary>
      {children}
    </details>
  );
}
