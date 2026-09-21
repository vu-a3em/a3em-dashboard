import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HelperError,
  helperHello,
  isChromium,
  listDevices,
  type HelperDevice,
  type HelperIdentity,
  type TaskProgress,
} from './helper';

/**
 * Whether the card helper is available, and what it can do here.
 *
 * Four states, kept apart because each calls for something different from the operator
 * and collapsing them makes the app look broken when it is working:
 *
 *  - `unsupported` — not a Chromium browser. Nothing to install; permanent.
 *  - `absent` — Chromium, extension not installed. **Offer the installer.** The app is
 *    fully usable in this state and most users will stay in it.
 *  - `incomplete` — extension and host present, but this platform's build implements
 *    nothing yet. Windows and Linux are here until their stubs are filled in.
 *  - `ready` — everything works.
 *
 * The distinction between `unsupported` and `absent` is the one that is easy to get
 * wrong. `chrome.runtime` is undefined on a page unless a matching extension is
 * installed, so testing for it answers "is the extension here", not "is this Chrome" —
 * and using it for the latter tells a Chrome user their browser is unsupported at exactly
 * the moment the installer should be offered.
 */

export type HelperStatus = 'checking' | 'unsupported' | 'absent' | 'incomplete' | 'ready';

/** A long operation in flight, held here so it survives switching sections. */
export interface HelperTask {
  op: string;
  note: string;
  startedAt: number;
  progress: TaskProgress | null;
}

export interface HelperState {
  status: HelperStatus;
  identity: HelperIdentity | null;
  devices: HelperDevice[];
  error: string | null;
  /** Non-null while something long is running. */
  task: HelperTask | null;
}

const INITIAL: HelperState = {
  status: isChromium() ? 'checking' : 'unsupported',
  identity: null,
  devices: [],
  error: null,
  task: null,
};

export function useHelper() {
  const [state, setState] = useState<HelperState>(INITIAL);

  /**
   * Tracks the running task outside React state as well.
   *
   * `beforeunload` fires during teardown, when a stale closure over `state` would report
   * the wrong thing. A ref is read at the moment the handler runs.
   */
  const running = useRef<HelperTask | null>(null);

  const refresh = useCallback(async () => {
    if (!isChromium()) {
      setState({ ...INITIAL, status: 'unsupported' });
      return;
    }
    setState((previous) => ({ ...previous, status: 'checking', error: null }));
    try {
      const identity = await helperHello();

      // An enumeration failure is not an absent helper: the helper answered. Report it as
      // present with the reason attached, rather than showing install instructions to
      // someone who has already installed it.
      let devices: HelperDevice[] = [];
      let error: string | null = null;
      try {
        devices = await listDevices();
      } catch (listError) {
        if (!(listError instanceof HelperError && listError.code === 'not-implemented')) {
          error = listError instanceof Error ? listError.message : String(listError);
        }
      }

      setState({
        status: identity.implemented.length > 0 ? 'ready' : 'incomplete',
        identity,
        devices,
        error,
        task: null,
      });
    } catch (error) {
      const missing = error instanceof HelperError && error.isMissing;
      setState({
        status: missing ? 'absent' : 'unsupported',
        identity: null,
        devices: [],
        error: missing ? null : error instanceof Error ? error.message : String(error),
        task: null,
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Warns before a reload or close while a card operation is running.
   *
   * The same guard `useOffloadTask` applies, and for a sharper reason: a copy interrupted
   * halfway leaves a partial folder, but a format or repair interrupted halfway can leave
   * a card that mounts nowhere. The native side keeps going — it is a separate process —
   * but the page loses any way to report what happened.
   */
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!running.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  /**
   * Runs a long helper operation while publishing its progress.
   *
   * Everything slow goes through here rather than being called directly, so there is one
   * place that knows a task is in flight — which is what the header indicator and the
   * unload guard both read.
   */
  const runTask = useCallback(
    async <T,>(
      op: string,
      note: string,
      work: (onProgress: (progress: TaskProgress) => void) => Promise<T>,
    ): Promise<T> => {
      const task: HelperTask = { op, note, startedAt: Date.now(), progress: null };
      running.current = task;
      setState((previous) => ({ ...previous, task, error: null }));
      try {
        return await work((progress) => {
          const updated = { ...task, progress, note: progress.note || note };
          running.current = updated;
          setState((previous) => ({ ...previous, task: updated }));
        });
      } finally {
        running.current = null;
        setState((previous) => ({ ...previous, task: null }));
      }
    },
    [],
  );

  /** Re-enumerate without re-running the handshake. For after a format or an eject. */
  const rescan = useCallback(async () => {
    if (!isChromium()) return;
    try {
      const devices = await listDevices();
      setState((previous) => ({ ...previous, devices, error: null }));
    } catch (error) {
      setState((previous) => ({
        ...previous,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  return { ...state, refresh, rescan, runTask };
}

export type Helper = ReturnType<typeof useHelper>;
