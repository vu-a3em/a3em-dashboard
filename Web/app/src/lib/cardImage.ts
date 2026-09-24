import { chooseImageDestination, diagnoseVolume, HelperError, imageDevice, type FsckReport, type HelperDevice, type ImageReport } from './helper';
import type { Helper } from './useHelper';
import type { CardLogs } from '../components/CardActivity';

/**
 * Copying a whole card to an image file, wherever the person chooses.
 *
 * The page cannot name a path on this computer, so the helper shows the system's own save
 * dialog — the image can go on another card or an external drive as easily as Documents — and
 * says straight away whether it fits there: a drive too full, or formatted FAT32, which holds
 * no file over 4 GB, is said before the first byte is copied, not an hour in. A helper too old
 * to show the dialog, or a system without one, saves in the default folder as before.
 */

function size(bytes: number): string {
  return bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB` : `${(bytes / 1e9).toFixed(1)} GB`;
}

function message(error: unknown): string {
  if (error instanceof HelperError && error.code === 'not-repairable') return error.message;
  if (error instanceof HelperError && error.code === 'cancelled') return 'Administrator access was not given, so nothing was copied.';
  return error instanceof Error ? error.message : String(error);
}

export async function copyCardToImage(device: HelperDevice, helper: Helper, logs: CardLogs): Promise<ImageReport | null> {
  const id = device.id;
  let destination: string | undefined;
  let replace = false;
  if (helper.identity?.implemented.includes('chooseImage')) {
    logs.begin([id], 'Choose where to save the image, in the dialog. It may open behind the browser.');
    try {
      const space = await chooseImageDestination(id);
      if (!space.fits) {
        logs.finish([id], space.problem ?? 'The image does not fit there.');
        return null;
      }
      destination = space.path;
      replace = space.exists;
      logs.note([id], `Saving it as ${space.path}, where ${size(space.freeBytes)} is free.`);
    } catch (failure) {
      if (failure instanceof HelperError && failure.code === 'cancelled') {
        // Nothing was done, so there is nothing to keep a log of.
        logs.forget([id]);
        return null;
      }
      if (!(failure instanceof HelperError && failure.code === 'no-dialog')) {
        logs.finish([id], message(failure));
        return null;
      }
      logs.note([id], 'This computer has no save dialog the card helper can show, so the image goes in the “A3EM card images” folder inside your Documents folder.');
    }
  } else {
    logs.begin([id], 'Asking the card helper to copy the whole card to an image file.');
  }
  // It runs for up to an hour, so it can be stopped, where the helper knows how.
  const signal = helper.identity?.implemented.includes('stop') ? logs.stoppable(id) : undefined;
  try {
    const report = await helper.runTask('image', 'Copying the card to an image file', (onProgress) =>
      imageDevice(
        id,
        destination,
        (progress) => {
          onProgress(progress);
          logs.follow([id])(progress);
        },
        replace,
        signal,
      ),
    );
    logs.finish([id]);
    return report;
  } catch (failure) {
    if (failure instanceof HelperError && failure.code === 'stopped') {
      logs.note([id], 'Stopped. The unfinished image was deleted.');
      logs.finish([id]);
      return null;
    }
    logs.finish([id], message(failure));
    return null;
  }
}

/**
 * Checking a card's filesystem, changing nothing: with the helper's own check where it has one,
 * which names the recordings a problem touches, and can be stopped.
 */
export async function checkCardFilesystem(device: HelperDevice, volume: string, helper: Helper, logs: CardLogs): Promise<FsckReport | null> {
  const id = device.id;
  logs.begin([id], 'Asking the card helper to check the filesystem. This changes nothing on the card.');
  const signal = helper.identity?.implemented.includes('stop') ? logs.stoppable(id) : undefined;
  try {
    const report = await helper.runTask('diagnose', 'Checking the filesystem', (onProgress) =>
      diagnoseVolume(
        volume,
        (progress) => {
          onProgress(progress);
          logs.follow([id])(progress);
        },
        signal,
      ),
    );
    logs.finish([id]);
    return report;
  } catch (failure) {
    if (failure instanceof HelperError && failure.code === 'stopped') {
      logs.note([id], 'Stopped before the check finished.');
      logs.finish([id]);
      return null;
    }
    logs.finish([id], message(failure));
    return null;
  }
}
