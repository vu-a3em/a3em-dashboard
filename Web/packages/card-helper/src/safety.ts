import type { RawDevice } from './platform/types.js';

/**
 * What the helper is allowed to touch.
 *
 * An allowlist of what may be acted on, not a blocklist of what may not — the difference
 * decides what happens when a platform reports something we did not anticipate, and the
 * safe answer to "I do not recognise this device" is always no.
 *
 * These checks run in the host and not in the page. The page is the thing whose
 * correctness we cannot depend on: it is a web origin, reached over the network, and the
 * whole reason this process refuses anything is that it must hold when the caller is
 * wrong or hostile.
 */

/**
 * Capacity bounds for something that could be an A3EM card.
 *
 * The floor rules out the small virtual devices that accumulate on a developer machine.
 * The ceiling is well above any card the device supports while staying below the
 * multi-terabyte disks a researcher keeps field data on — which is the specific accident
 * worth engineering against, because an external archive drive is removable, USB, and
 * otherwise indistinguishable from a card.
 */
export const MIN_CARD_BYTES = 1 * 1024 ** 3;
export const MAX_CARD_BYTES = 2 * 1024 ** 4;

export class RefusedError extends Error {
  constructor(
    message: string,
    readonly code: RefusalCode,
  ) {
    super(message);
    this.name = 'RefusedError';
  }
}

export type RefusalCode =
  | 'unknown-device'
  | 'not-removable'
  | 'internal-device'
  | 'boot-device'
  | 'implausible-size'
  | 'ambiguous-probe'
  | 'no-probe-match'
  | 'bad-grant';

/**
 * Whether disk images count as cards.
 *
 * Off by default. A developer machine is full of them — a laptop with Xcode lists one
 * simulator image per installed runtime, each removable, non-internal, and card-sized,
 * so without this the device list is mostly noise and every entry is something the
 * operator could format by mistake.
 *
 * The escape hatch exists because file-backed images are how this code is tested without
 * putting a real card at risk, and an env var is the right shape for that: deliberate,
 * per-invocation, and impossible to reach from the page.
 */
export const ALLOW_VIRTUAL_DEVICES = process.env.A3EM_HELPER_ALLOW_VIRTUAL === '1';

/** Devices a destructive operation may target. Everything else is invisible to the page. */
export function isEligible(device: RawDevice, allowVirtual = ALLOW_VIRTUAL_DEVICES): boolean {
  return (
    device.removable &&
    !device.internal &&
    !device.isBootDevice &&
    (allowVirtual || !device.virtual) &&
    device.sizeBytes >= MIN_CARD_BYTES &&
    device.sizeBytes <= MAX_CARD_BYTES
  );
}

/**
 * Throws unless this device may be written to.
 *
 * Reports the specific reason rather than a generic refusal: "that is your boot disk" and
 * "that is a 4 TB archive drive" call for different reactions from the operator, and
 * collapsing them into "refused" makes the tool feel broken when it is working.
 */
export function assertWritable(device: RawDevice | undefined, deviceId: string): asserts device is RawDevice {
  if (!device) {
    throw new RefusedError(
      `No removable device called ${deviceId} is connected.`,
      'unknown-device',
    );
  }
  if (device.isBootDevice) {
    throw new RefusedError(`${deviceId} is this computer's startup disk.`, 'boot-device');
  }
  if (device.virtual && !ALLOW_VIRTUAL_DEVICES) {
    throw new RefusedError(`${deviceId} is a disk image, not a card.`, 'not-removable');
  }
  if (device.internal) {
    throw new RefusedError(`${deviceId} is an internal disk, not removable media.`, 'internal-device');
  }
  if (!device.removable) {
    throw new RefusedError(`${deviceId} is not removable media.`, 'not-removable');
  }
  if (device.sizeBytes < MIN_CARD_BYTES) {
    throw new RefusedError(
      `${deviceId} is ${formatSize(device.sizeBytes)}, too small to be an SD card.`,
      'implausible-size',
    );
  }
  if (device.sizeBytes > MAX_CARD_BYTES) {
    throw new RefusedError(
      `${deviceId} is ${formatSize(
        device.sizeBytes,
      )}, far larger than any SD card — refusing in case it is a hard drive.`,
      'implausible-size',
    );
  }
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${bytes} bytes`;
}
