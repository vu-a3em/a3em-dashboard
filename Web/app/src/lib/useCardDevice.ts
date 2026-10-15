import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BOOT_LOG_FILE_NAME,
  UNACTIVATED_LOG_FILE_NAME,
  type CardLayout,
  type CardReadinessReport,
} from '@a3em/config-schema';
import { checkReadiness, ejectDevice, identifyCard, type HelperDevice } from './helper';
import type { useCard } from './useCard';
import type { Helper } from './useHelper';

type Card = ReturnType<typeof useCard>;

/**
 * Which physical card the folder open in the dashboard is on.
 *
 * The folder picker hands the page a folder and nothing else — no path, no device — so on its
 * own the dashboard cannot tell a card from a copy of one on the hard drive, or say anything
 * about the card as hardware. With the card helper it can: the page writes an empty marker
 * file through the folder, and the helper says which card carries it (`identifyCard`). That
 * match is what lets the rest of the dashboard eject the card safely, say whether the
 * recorder would erase it, and show its identity and what this computer found when it
 * prepared it.
 *
 * The marker is written only when it could find something: when the helper lists a card with
 * an open volume of the folder's name. A folder on the hard drive is never written to, and
 * most folders that are not cards never reach the helper at all. Never guessed from the name
 * alone either, since a batch of identical cards with identical names is the normal case —
 * the name only decides whether asking is worthwhile.
 */

export type CardDeviceStatus = 'none' | 'matching' | 'matched' | 'unmatched';

/** The helper's shallow read of a card: its identity, contents, and what was recorded here. */
export type CardDetails = CardReadinessReport;

/**
 * Whether the open folder could be this device's volume, which decides whether a marker is worth writing.
 *
 * A whole drive picked on Windows arrives as a handle named with a bare backslash (see
 * `cardDisplayName`), which no mount point or label matches. That left every card opened at
 * its root on Windows unidentified, so copying fell back to the browser and the filesystem
 * check behind "Check recordings" was skipped, both without a word. A bare root is the root of
 * some drive, so any removable card mounted at a drive letter could be it, and the marker decides
 * which. Which drive the root belongs to cannot be told from its name, so the caller also checks
 * that it holds nothing but what a card holds (`looksLikeCardRoot`) before writing to it.
 */
export function sameName(folder: string, device: HelperDevice): boolean {
  const normalize = (value: string) => value.trim().replace(/[\\/]+$/, '').toLowerCase();
  const wanted = normalize(folder);
  return device.volumes.some((volume) => {
    if (!volume.mountPoint) return false;
    const mount = normalize(volume.mountPoint);
    if (wanted === '') return (device.removable || device.virtual) && /^[a-z]:$/.test(mount);
    // A drive letter's root has no name of its own, so a named folder that matches only the
    // label is a folder inside the card, typically the device's folder, which the recorder names
    // after the same label. The helper looks for the marker at the mount point alone, so writing
    // one into that folder could never match.
    if (/^[a-z]:$/.test(mount)) return mount === wanted;
    const last = mount.split(/[\\/]/).pop() ?? '';
    return last === wanted || mount === wanted || (volume.label !== null && normalize(volume.label) === wanted);
  });
}

/** Whether a folder's name is that of a whole drive, which Chrome gives on Windows as a bare backslash. */
function isBareRoot(folder: string): boolean {
  return folder.trim().replace(/[\\/]+$/, '') === '';
}

/**
 * Whether a drive root shows signs of being an A3EM card: something the recorder or the dashboard
 * writes, or nothing at all.
 *
 * A bare root carries no name to go on, and the marker that identifies a card is written into
 * it, so this stands in for the name: a hard drive's root holds none of these, and is never
 * written to. It asks for evidence rather than for purity. A first version demanded that every
 * file be one the layout recognises, and the recorder's own boot logs are not among those, so
 * every card the recorder had run on was refused. A blank card counts, along with the hidden
 * files and the folder Windows and macOS put on removable media.
 */
export function looksLikeCardRoot(layout: CardLayout | undefined): boolean {
  if (!layout) return false;
  const housekeeping = (path: string) => /^(System Volume Information\/|\.)/i.test(path);
  // Only the root's own files count: a hard drive holds recordings of its own somewhere deep
  // inside, but never the files the recorder and the dashboard put at a card's root
  const rootEvidence = (file: CardLayout['files'][number]) =>
    !file.path.includes('/') &&
    (ROOT_KINDS.has(file.kind) || [BOOT_LOG_FILE_NAME, UNACTIVATED_LOG_FILE_NAME].includes(file.path.toLowerCase()));
  return layout.files.some(rootEvidence) || layout.files.every((file) => housekeeping(file.path));
}

/** The kinds of file that live at a card's root: its configuration, device file, and self-test. */
const ROOT_KINDS = new Set(['config', 'device-info', 'self-test', 'self-test-clip']);

/**
 * Whether the open folder is a device's own folder on a card rather than the card itself.
 *
 * The recorder names that folder after its label, which is also what the card is usually
 * labelled, so on macOS and Linux it passes `sameName` exactly as the card's root does. The
 * helper looks for the marker only at a volume's mount point, so one written into this folder is
 * never found, and the failure reads as though the card were not there at all.
 */
export function isDeviceFolder(layout: CardLayout | undefined): boolean {
  return Boolean(layout?.files.some((file) => /^Activation_\d+\//.test(file.path)));
}

/** What the helper listed, when none of it could be the open folder. */
function describeNoCandidate(folder: string, devices: HelperDevice[], loading: boolean): string {
  if (loading && !devices.length) return 'the A3EM Card Helper is still listing cards';
  const mounts = devices.flatMap((device) =>
    device.volumes.map((volume) =>
      `${volume.mountPoint ?? 'not mounted'}${volume.label ? ` (${volume.label})` : ''}${device.removable ? '' : ', not removable'}`,
    ),
  );
  const shown = folder.trim() === '' || isBareRoot(folder) ? 'the root of a drive' : `"${folder}"`;
  return mounts.length
    ? `the open folder is ${shown}, and the A3EM Card Helper sees only ${mounts.join('; ')}`
    : `the A3EM Card Helper lists no cards on this computer`;
}

export function useCardDevice(card: Card, helper: Helper) {
  const handle = card.status === 'ready' ? card.handle : null;
  const ready = helper.status === 'ready';
  const { devices, devicesLoading, rescan } = helper;

  const [match, setMatch] = useState<{ handle: FileSystemDirectoryHandle; device: string; volume: string } | null>(null);
  const [status, setStatus] = useState<CardDeviceStatus>('none');
  const [error, setError] = useState<string | null>(null);
  /*
    Why the open folder could not be matched to a card, in words. Each step that can fail used to
    end in the same silent 'unmatched', so a card that was never identified on one platform gave
    no clue which of them it was: no card listed, none mounted there, or the marker check failing.
  */
  const [unmatchedReason, setUnmatchedReason] = useState<string | null>(null);
  const [details, setDetails] = useState<{ device: string; report: CardDetails } | null>(null);
  // The folder the list was refreshed for, and the one a marker was written into, so neither
  // happens twice for the same folder.
  const refreshedFor = useRef<FileSystemDirectoryHandle | null>(null);
  const probedFor = useRef<FileSystemDirectoryHandle | null>(null);

  // A new folder: forget the old match, and ask the helper afresh, since the card may have
  // gone in after the list was last read.
  useEffect(() => {
    if (!handle || !ready) {
      setStatus('none');
      return;
    }
    if (refreshedFor.current === handle) return;
    refreshedFor.current = handle;
    probedFor.current = null;
    setMatch(null);
    setDetails(null);
    setError(null);
    setUnmatchedReason(null);
    setStatus('matching');
    void rescan();
  }, [handle, ready, rescan]);

  useEffect(() => {
    if (!handle || !ready || refreshedFor.current !== handle || probedFor.current === handle) return;
    if (isBareRoot(handle.name) && !looksLikeCardRoot(card.contents?.layout)) {
      setUnmatchedReason('the open folder is the root of a drive, but holds none of the files an A3EM card has at its root');
      setStatus('unmatched');
      return;
    }
    if (isDeviceFolder(card.contents?.layout)) {
      setUnmatchedReason(
        `"${handle.name}" is a device's folder on the card, not the card itself, so choose the card instead`,
      );
      setStatus('unmatched');
      return;
    }
    if (!devices.some((device) => sameName(handle.name, device))) {
      // Could be a card the list has not caught up with; a later list gets another look.
      setUnmatchedReason(describeNoCandidate(handle.name, devices, devicesLoading));
      setStatus('unmatched');
      return;
    }
    probedFor.current = handle;
    setStatus('matching');
    setUnmatchedReason(null);
    identifyCard(handle)
      .then((found) => {
        setMatch({ handle, ...found });
        setStatus('matched');
      })
      .catch((failure: unknown) => {
        setUnmatchedReason(`the marker check failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        setStatus('unmatched');
      });
  }, [handle, ready, devices, devicesLoading, card.contents]);

  // The match holds only while that card is still listed and the same folder is still open.
  const device =
    match && handle && match.handle === handle ? (devices.find((candidate) => candidate.id === match.device) ?? null) : null;
  const effective: CardDeviceStatus = status === 'matched' && !device ? 'none' : status;

  /** The shallow read, once per card: its identity, and what this computer recorded preparing it. */
  const loadDetails = useCallback(async () => {
    if (!device) return;
    const report = await checkReadiness(device.id, false);
    setDetails({ device: device.id, report });
  }, [device]);

  /**
   * Ejects the card, then sets the folder aside rather than forgetting it, so the dashboard
   * can offer to reopen it when the card goes back in.
   */
  const eject = useCallback(async () => {
    if (!device) return;
    setError(null);
    try {
      await ejectDevice(device.id);
      card.setAside();
      setMatch(null);
      setStatus('none');
      await rescan();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [device, card, rescan]);

  return {
    /** Whether the card tools are here at all, for offering what only they can do. */
    available: ready,
    status: effective,
    device,
    volumeId: device ? match!.volume : null,
    /** Why the folder is not matched to a card, when it is not. */
    unmatchedReason: effective === 'unmatched' ? unmatchedReason : null,
    details: details && device && details.device === device.id ? details.report : null,
    error,
    loadDetails,
    eject,
  };
}

export type CardDevice = ReturnType<typeof useCardDevice>;
