import type { CardLayout } from '@a3em/config-schema';
import { Pane } from './Pane';

/**
 * Which activation of the device to look at.
 *
 * A card can hold several runs, and they cannot be told apart by time. A device
 * configured to set its clock when the magnet activates it starts EVERY run at the same
 * configured start time, so activation 2's timestamps sit exactly on top of activation
 * 1's. Pooling them produces a coverage grid where two runs overlay each other and a
 * battery trace that jumps backwards — both of which read as faults that are not there.
 *
 * The directory the device wrote into is the only thing that separates them, so that is
 * what this selects on.
 */
export function ActivationPicker({
  layout,
  selected,
  onSelect,
  overlapping,
}: Readonly<{
  layout: CardLayout;
  selected: number | null;
  onSelect: (activation: number | null) => void;
  /** True when the configuration resets the clock at every activation. */
  overlapping: boolean;
}>) {
  if (layout.activations.length < 2) return null;

  return (
    <Pane
      id="activation-picker"
      title={`This card holds ${layout.activations.length} activations`}
      note={selected === null ? 'All together' : `Activation ${selected}`}
    >
      <p className="hint">
        {overlapping
          ? 'This deployment set the device clock at activation, so every run starts at the same ' +
            'configured time and their timestamps sit on top of one another. Look at one at a time.'
          : 'Each activation is a separate run of the device. Everything below follows this choice.'}
      </p>
      <div className="activation-tabs" role="group" aria-label="Activation">
        <button
          className={`btn small${selected === null ? ' primary' : ''}`}
          onClick={() => onSelect(null)}
          aria-pressed={selected === null}
        >
          All together
        </button>
        {layout.activations.map((activation) => (
          <button
            key={activation}
            className={`btn small${selected === activation ? ' primary' : ''}`}
            onClick={() => onSelect(activation)}
            aria-pressed={selected === activation}
          >
            Activation {activation}
          </button>
        ))}
      </div>
      {selected === null && overlapping ? (
        <p className="help">
          Showing all of them at once. Times from different activations will overlap, so gaps and
          coverage below are not meaningful until you pick one.
        </p>
      ) : null}
    </Pane>
  );
}
