import { useCallback, useRef, useSyncExternalStore, type SetStateAction } from 'react';

/**
 * State that outlives the screen showing it.
 *
 * Switching tabs unmounts the screen you left, and React discards its state with it — but the
 * helper does not stop: an image being copied or a card being prepared carries on, and the code
 * following it keeps reporting. With ordinary state those reports went nowhere, so coming back
 * showed the buttons disabled by the task still running and no sign of its progress.
 *
 * Held here instead, by key, for as long as the page is open: whatever is still running writes
 * into it whether or not its screen is showing, and a screen shows the latest when it returns.
 */

const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

export function useKept<T>(key: string, initial: T): [T, (next: SetStateAction<T>) => void] {
  const first = useRef(initial);
  if (!values.has(key)) values.set(key, first.current);
  const subscribe = useCallback(
    (listener: () => void) => {
      const set = listeners.get(key) ?? new Set();
      listeners.set(key, set);
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    [key],
  );
  const value = useSyncExternalStore(subscribe, () => values.get(key) as T);
  const set = useCallback(
    (next: SetStateAction<T>) => {
      const previous = values.get(key) as T;
      const updated = typeof next === 'function' ? (next as (value: T) => T)(previous) : next;
      if (Object.is(updated, previous)) return;
      values.set(key, updated);
      listeners.get(key)?.forEach((listener) => listener());
    },
    [key],
  );
  return [value, set];
}
