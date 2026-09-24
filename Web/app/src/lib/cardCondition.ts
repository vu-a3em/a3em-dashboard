import type { HelperDevice, HelperVolume } from './helper';

/**
 * Whether a connected card can be opened, from what the helper sees of it.
 *
 * The folder picker only ever shows a card that opened. Everything else — a card whose
 * filesystem is damaged, one the system has not mounted, one with no partitions at all — is
 * invisible there, and only the helper can say which of those it is. Each calls for something
 * different, so they are told apart here, once, for every screen that lists cards.
 *
 *  - `open` — mounted: the folder picker can open it.
 *  - `closed` — a filesystem the system knows, not mounted. Mounting it is enough.
 *  - `unreadable` — a partition whose filesystem the system cannot read: damaged, or
 *    formatted for some other kind of device.
 *  - `blank` — no partitions. Nothing to open or repair; preparing it is fine.
 */
export type CardCondition =
  | { kind: 'open'; volume: HelperVolume; mountPoint: string }
  | { kind: 'closed'; volume: HelperVolume }
  | { kind: 'unreadable'; volume: HelperVolume }
  | { kind: 'blank' };

export function cardCondition(device: HelperDevice): CardCondition {
  const volume = device.volumes[0];
  if (!volume) return { kind: 'blank' };
  if (volume.mountPoint) return { kind: 'open', volume, mountPoint: volume.mountPoint };
  if (volume.filesystem && volume.mountable) return { kind: 'closed', volume };
  return { kind: 'unreadable', volume };
}
