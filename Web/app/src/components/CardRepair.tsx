import { useCallback, useEffect, useRef, useState } from 'react';
import { HelperError, repairVolume, requestChallenge, type FsckReport, type HelperDevice } from '../lib/helper';
import type { Helper } from '../lib/useHelper';
import type { CardLogs } from './CardActivity';

/**
 * Repairing a card's filesystem, on "Review card" for a card that opens and on "Recover card"
 * for one that does not.
 *
 * A repair rewrites the card in place, so it is confirmed in the helper's own words first, and
 * without an image of the card that confirmation takes one more tick: nothing a repair gets
 * wrong can then be undone. The grant is asked for again after confirming, since confirming can
 * outlast it, and must describe the same card, or nothing is repaired.
 */

interface PendingRepair {
  device: HelperDevice;
  volume: string;
  description: string;
}

function message(error: unknown): string {
  if (error instanceof HelperError && error.code === 'cancelled') return 'Administrator access was not given, so nothing was done.';
  return error instanceof Error ? error.message : String(error);
}

export function useCardRepair(helper: Helper, logs: CardLogs, onRepaired: (device: HelperDevice, report: FsckReport) => void) {
  const [pending, setPending] = useState<PendingRepair | null>(null);
  // The card waiting in the dialog, so closing it can tell a cancel from a confirm.
  const awaiting = useRef<string | null>(null);
  const { forget } = logs;

  const ask = async (device: HelperDevice, volume: string) => {
    logs.begin([device.id], 'Asking the card helper to describe the card, so you can confirm it before anything is changed.');
    try {
      const challenge = await requestChallenge(device.id, 'repair');
      logs.note([device.id], 'Waiting for you to confirm.');
      awaiting.current = device.id;
      setPending({ device, volume, description: challenge.description });
    } catch (failure) {
      logs.finish([device.id], message(failure));
    }
  };

  // Stable, because the dialog listens for its own closing with it.
  const cancel = useCallback(() => {
    setPending(null);
    const id = awaiting.current;
    awaiting.current = null;
    // Nothing was done, so there is nothing to keep a log of.
    if (id) forget([id]);
  }, [forget]);

  // Leaving the screen with the dialog open is a cancel too.
  useEffect(
    () => () => {
      if (awaiting.current) forget([awaiting.current]);
      awaiting.current = null;
    },
    [forget],
  );

  const confirm = async () => {
    if (!pending) return;
    const { device, volume, description } = pending;
    awaiting.current = null;
    setPending(null);
    logs.note([device.id], 'Checking that nothing has changed since you confirmed.');
    try {
      const challenge = await requestChallenge(device.id, 'repair');
      if (challenge.description !== description) {
        logs.finish([device.id], `The card changed since you confirmed it, so nothing was repaired. It now reads: ${challenge.description}`);
        return;
      }
      const report = await helper.runTask('repair', 'Repairing the filesystem', (onProgress) =>
        repairVolume({ device: device.id, volume, grant: challenge.token }, (progress) => {
          onProgress(progress);
          logs.follow([device.id])(progress);
        }),
      );
      onRepaired(device, report);
      logs.finish([device.id]);
    } catch (failure) {
      logs.finish([device.id], message(failure));
    }
  };

  return { pending, ask, cancel, confirm };
}

/** The repair, confirmed in the helper's own words. */
export function RepairDialog({
  description,
  imaged,
  ours,
  onCancel,
  onConfirm,
}: Readonly<{
  description: string;
  imaged: boolean;
  /** Whether the last check found only what the helper's own repairs fix. */
  ours: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [accepted, setAccepted] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    element.showModal();
    element.addEventListener('close', onCancel);
    return () => element.removeEventListener('close', onCancel);
  }, [onCancel]);
  return (
    <dialog className="modal" ref={dialog} aria-label="Confirm the repair">
      <h2>Repair this card’s filesystem?</h2>
      <p className="hint">{description}</p>
      {ours ? (
        // The helper's own repair: narrow, and undoable, so no image is insisted on.
        <p className="hint">
          The repair rewrites only what the check found wrong, and changes no file. What it replaces is saved on this
          computer first, so it can be put back.
        </p>
      ) : imaged ? (
        <p className="hint">
          This uses the system’s own repair tool, which may shorten or remove files it cannot make sense of. You have
          an image of this card, so if the repair makes things worse, nothing is lost.
        </p>
      ) : (
        <div className="banner warn">
          <strong>There is no image of this card yet</strong>
          This uses the system’s own repair tool, which may shorten or remove recordings it cannot make sense of,
          and without an image that cannot be undone.
          <label className="confirm-inline">
            <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
            Repair it anyway, without an image.
          </label>
        </div>
      )}
      <div className="modal-actions">
        <button className="btn danger" disabled={!ours && !imaged && !accepted} onClick={onConfirm}>
          Repair
        </button>
        <button className="btn" onClick={() => dialog.current?.close()}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
