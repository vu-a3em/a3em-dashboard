import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_FIRMWARE_PROFILE,
  FIRMWARE_LEGACY,
  cardFirmwareProfile,
  parseConfig,
  parseDeviceInfo,
  parseSelfTestResults,
  targetFirmwareProfile,
  type DeploymentConfig,
  type DeviceInfo,
  type FirmwareProfile,
  type ParsedLog,
  type SelfTestResults,
} from '@a3em/config-schema';
import {
  CARD_ACCESS_SUPPORTED,
  CardGoneError,
  hasPermission,
  pickCard,
  readCard,
  recallCardHandle,
  requestPermission,
  forgetCardHandle,
  type CardContents,
  type ScanProgress,
} from './card';
import { parseLogsAsync } from './parse-logs-async';

export type CardStatus = 'unsupported' | 'disconnected' | 'reconnectable' | 'scanning' | 'ready' | 'error';

export interface CardState {
  status: CardStatus;
  name: string | null;
  /** Said once nothing is open: why the card that was open is not any more. */
  notice: string | null;
  contents: CardContents | null;
  progress: ScanProgress | null;
  error: string | null;

  /** Parsed card-root artifacts. Null where the card does not carry them. */
  deviceInfo: DeviceInfo | null;
  selfTest: SelfTestResults | null;
  existingConfig: DeploymentConfig | null;
  configWarnings: string[];
  log: ParsedLog | null;

  /**
   * The firmware that wrote this card's contents, for interpreting them.
   *
   * Kept separate from `targetFirmware` because they answer different questions and
   * only coincide by accident. Reading an old card in a current device is ordinary,
   * and conflating the two made the integrity check judge legacy recordings by rules
   * the firmware that produced them never followed.
   */
  cardFirmware: FirmwareProfile;

  /** The firmware a configuration written now will run on, for validating it. */
  targetFirmware: FirmwareProfile;
}

const INITIAL: CardState = {
  status: CARD_ACCESS_SUPPORTED ? 'disconnected' : 'unsupported',
  name: null,
  notice: null,
  contents: null,
  progress: null,
  error: null,
  deviceInfo: null,
  selfTest: null,
  existingConfig: null,
  configWarnings: [],
  log: null,
  cardFirmware: FIRMWARE_LEGACY,
  targetFirmware: DEFAULT_FIRMWARE_PROFILE,
};

/**
 * Owns the connection to an SD card and everything read from it.
 *
 * A previously used card is offered for reconnection on load, but never reopened
 * automatically: browsers require a user gesture to re-grant permission, and silently
 * failing that check would look like the card had vanished.
 */
export function useCard() {
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [state, setState] = useState<CardState>(INITIAL);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      const remembered = await recallCardHandle();
      if (canceled || !remembered) return;
      setHandle(remembered);
      setState((previous) => ({
        ...previous,
        status: 'reconnectable',
        name: remembered.name,
      }));
    })();
    return () => {
      canceled = true;
    };
  }, []);

  const ingest = useCallback(async (root: FileSystemDirectoryHandle) => {
    setState((previous) => ({ ...previous, status: 'scanning', name: root.name, error: null, progress: null }));
    try {
      const contents = await readCard(root, {
        onProgress: (progress) => setState((previous) => ({ ...previous, progress })),
      });

      // A multi-megabyte log takes seconds to work through, so it is parsed on a worker
      // and the page stays live while it runs.
      let log: ParsedLog | null = null;
      if (contents.logs.length) {
        setState((previous) => ({
          ...previous,
          progress: {
            phase: 'parsing',
            filesSeen: contents.entries.length,
            currentDirectory: '',
            logsRead: contents.logs.length,
            logsTotal: contents.logs.length,
            logBytes: contents.logs.reduce((sum, file) => sum + file.text.length, 0),
          },
        }));
        log = await parseLogsAsync(contents.logs);
      }

      const deviceInfo = contents.deviceInfoText ? parseDeviceInfo(contents.deviceInfoText) : null;
      const selfTest = contents.selfTestText ? parseSelfTestResults(contents.selfTestText) : null;
      const parsedConfig = contents.configText ? parseConfig(contents.configText) : null;

      setState({
        status: 'ready',
        name: root.name,
        notice: null,
        contents,
        progress: null,
        error: null,
        deviceInfo,
        selfTest,
        existingConfig: parsedConfig?.config ?? null,
        configWarnings: parsedConfig?.warnings ?? [],
        log,
        cardFirmware: cardFirmwareProfile(deviceInfo),
        targetFirmware: targetFirmwareProfile(deviceInfo),
      });
    } catch (error) {
      if (error instanceof CardGoneError) {
        // Not a damaged card: its folder is not there. Reopen works once it is back as it was.
        setState({ ...INITIAL, status: 'reconnectable', name: root.name, error: `${root.name} is not inserted` });
        return;
      }
      setState((previous) => ({
        ...previous,
        status: 'error',
        progress: null,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  const connect = useCallback(async () => {
    try {
      const root = await pickCard();
      setHandle(root);
      await ingest(root);
    } catch (error) {
      // An abandoned folder picker is not a failure worth reporting.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState((previous) => ({
        ...previous,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [ingest]);

  const reconnect = useCallback(async () => {
    if (!handle) return;
    const granted = (await hasPermission(handle, 'readwrite')) || (await requestPermission(handle, 'readwrite'));
    if (!granted) {
      // The card is still known; the user simply has not re-granted access yet.
      setState((previous) => ({
        ...previous,
        status: 'reconnectable',
        error: 'Access to the card was declined.',
      }));
      return;
    }
    // A card that has been taken out cannot be reopened. Say so plainly, and keep offering both
    // ways back, rather than reporting a missing directory as a failure to read the card.
    try {
      // Typed by hand, as card.ts does: the DOM library here does not declare directory iteration.
      await (handle as unknown as { entries: () => AsyncIterableIterator<[string, FileSystemHandle]> }).entries().next();
    } catch {
      setState((previous) => ({
        ...previous,
        status: 'reconnectable',
        error: `${handle.name} is not inserted`,
      }));
      return;
    }
    await ingest(handle);
  }, [handle, ingest]);

  const rescan = useCallback(async () => {
    if (handle) await ingest(handle);
  }, [handle, ingest]);

  const disconnect = useCallback(async () => {
    await forgetCardHandle();
    setHandle(null);
    setState(INITIAL);
  }, []);

  /**
   * After the card that was open has been erased, to prepare it: its folder went with what was on
   * it, and what was read from it describes a card that no longer exists. Nothing stays open or
   * offered for reopening; the notice says why, until another card is connected.
   */
  const erased = useCallback(async (notice: string) => {
    await forgetCardHandle();
    setHandle(null);
    setState({ ...INITIAL, notice });
  }, []);

  /**
   * After the card has been ejected: nothing is open any more, but the folder is kept, so the
   * dashboard can offer to reopen it when the card goes back in.
   */
  const setAside = useCallback(() => {
    if (!handle) return;
    setState({ ...INITIAL, status: 'reconnectable', name: handle.name });
  }, [handle]);

  return { ...state, handle, connect, reconnect, rescan, disconnect, setAside, erased };
}
