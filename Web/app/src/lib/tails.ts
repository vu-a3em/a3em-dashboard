import { useCallback } from 'react';
import { acceptImuRecovery, acceptLogTail, type DeploymentConfig } from '@a3em/config-schema';
import type { CardTail, HelperDevice } from './helper';
import { useKept } from './keptState';

/**
 * What logs and IMU files hold past their recorded end, judged, and ready to add to their copies.
 *
 * The recorder records a file's length only when it syncs or closes it, so a unit that lost power
 * leaves its last log lines, and an IMU file cut short, past the length the card gives. The card
 * helper finds those bytes while checking the filesystem; `acceptLogTail` and `acceptImuRecovery`
 * keep only what can be shown to be the file's; and "Check & copy" adds that to the file's copy,
 * where it belongs, rather than beside it. The card itself is not changed.
 *
 * Kept per card as it is now — its device and its volume's identity, which a new format changes —
 * so a check on "Review card" spares the copy from asking the card helper again.
 */

export interface RecoveredTail {
  path: string;
  kind: 'log' | 'imu';
  /** Added after what the file records, for a log; the whole file, for an IMU file cut short. */
  bytes: Uint8Array;
  replaces: boolean;
  /** Whether any of it lies in space no file owns, which a repair of the space record frees. */
  unowned: boolean;
  /** What it adds, in words. */
  summary: string;
}

function decode(base64: string | undefined): Uint8Array {
  const raw = atob(base64 ?? '');
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function size(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : bytes >= 1e3 ? `${(bytes / 1e3).toFixed(1)} kB` : `${bytes} bytes`;
}

/** The longest clip the configuration asks for, or null where a clip can run on past it. */
export function longestClip(config: DeploymentConfig | null): number | null {
  const phases = config?.phases ?? [];
  if (!phases.length || phases.some((phase) => phase.extendClipIfContinuousAudio)) return null;
  return Math.max(...phases.map((phase) => phase.audioClipLengthSeconds));
}

export function acceptTails(tails: CardTail[] | undefined, clipSeconds: number | null): RecoveredTail[] {
  const recovered: RecoveredTail[] = [];
  for (const tail of tails ?? []) {
    const data = decode(tail.data);
    if (tail.kind === 'log') {
      const accepted = acceptLogTail({ recordedBytes: tail.recordedBytes, before: decode(tail.before), data });
      if (!accepted) continue;
      recovered.push({
        path: tail.path,
        kind: 'log',
        bytes: accepted.bytes,
        replaces: false,
        unowned: accepted.bytes.length > (tail.inFileBytes ?? 0),
        summary: `${size(accepted.bytes.length)} of log text${accepted.lines ? `, ${accepted.lines.toLocaleString()} ${accepted.lines === 1 ? 'line' : 'lines'}` : ''}`,
      });
    } else if (tail.kind === 'imu') {
      const nameTime = Number((tail.path.split('/').pop() ?? '').replace(/\.imu$/i, ''));
      const accepted = Number.isFinite(nameTime) ? acceptImuRecovery({ nameTime, data, clipSeconds }) : null;
      if (!accepted) continue;
      recovered.push({
        path: tail.path,
        kind: 'imu',
        bytes: accepted.bytes,
        replaces: true,
        unowned: true,
        summary: `${accepted.samples.toLocaleString()} samples, ${accepted.seconds.toFixed(1)} s`,
      });
    }
  }
  return recovered;
}

/** What was recovered for the card as it is now: null until its filesystem has been checked. */
export function useRecoveredTails(device: HelperDevice | null, volumeId: string | null) {
  const uuid = device?.volumes.find((volume) => volume.id === volumeId)?.uuid ?? null;
  const key = device && uuid ? `${device.id}:${uuid}` : null;
  const [all, setAll] = useKept<Record<string, RecoveredTail[]>>('recovered-tails', {});
  const set = useCallback(
    (tails: RecoveredTail[]) => {
      if (key) setAll((current) => ({ ...current, [key]: tails }));
    },
    [key, setAll],
  );
  return { tails: key ? (all[key] ?? null) : null, setTails: set };
}
