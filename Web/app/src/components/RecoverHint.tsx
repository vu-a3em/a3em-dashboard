/**
 * Where to go when the card will not show up in the picker at all.
 *
 * Only with the card tools installed: without them there is nowhere to send anyone, and a
 * hint about a screen that can only explain what is missing is noise.
 */
export function RecoverHint({ available, onRecover }: Readonly<{ available: boolean; onRecover: () => void }>) {
  if (!available) return null;
  return (
    <p className="card-help">
      A corrupted or damaged card may not appear in the card picker dialog box.{' '}
      <button className="link-button" onClick={onRecover}>
        Recover card
      </button>{' '}
      can still reach it.
    </p>
  );
}
