import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardReadinessReport } from '@a3em/config-schema';
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

function sameName(folder: string, device: HelperDevice): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, '').toLowerCase();
  const wanted = normalize(folder);
  return device.volumes.some((volume) => {
    if (!volume.mountPoint) return false;
    const mount = normalize(volume.mountPoint);
    const last = mount.split(/[\\/]/).pop() ?? '';
    return last === wanted || mount === wanted || (volume.label !== null && normalize(volume.label) === wanted);
  });
}

export function useCardDevice(card: Card, helper: Helper) {
  const handle = card.status === 'ready' ? card.handle : null;
  const ready = helper.status === 'ready';
  const { devices, rescan } = helper;

  const [match, setMatch] = useState<{ handle: FileSystemDirectoryHandle; device: string; volume: string } | null>(null);
  const [status, setStatus] = useState<CardDeviceStatus>('none');
  const [error, setError] = useState<string | null>(null);
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
    setStatus('matching');
    void rescan();
  }, [handle, ready, rescan]);

  useEffect(() => {
    if (!handle || !ready || refreshedFor.current !== handle || probedFor.current === handle) return;
    if (!devices.some((device) => sameName(handle.name, device))) {
      // Could be a card the list has not caught up with; a later list gets another look.
      setStatus('unmatched');
      return;
    }
    probedFor.current = handle;
    setStatus('matching');
    identifyCard(handle)
      .then((found) => {
        setMatch({ handle, ...found });
        setStatus('matched');
      })
      .catch(() => setStatus('unmatched'));
  }, [handle, ready, devices]);

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
    details: details && device && details.device === device.id ? details.report : null,
    error,
    loadDetails,
    eject,
  };
}

export type CardDevice = ReturnType<typeof useCardDevice>;
