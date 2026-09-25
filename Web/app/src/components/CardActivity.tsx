import { useCallback, useEffect, useState } from 'react';
import type { TaskProgress } from '../lib/helper';
import { useKept } from '../lib/keptState';

/**
 * What the card helper is doing with each card, as it happens.
 *
 * Everything the helper does takes a while — starting it, asking for a password, minutes of
 * testing or copying — and a button that goes quiet for that long reads as broken. So each
 * card keeps a running log from the moment a button is pressed: a line straight away, then
 * the helper's own progress as it arrives. Afterward the log folds away, still there for
 * anyone who wants to see what happened, unless it ended in failure, when it stays open with
 * the reason as its last line.
 *
 * Shared by every screen that works on cards through the helper, so the same action reads
 * the same way wherever it was started. Kept by screen (`scope`) for as long as the page is
 * open, so leaving a tab while something runs and coming back shows it still running.
 */

/** One step in a card's log. */
export interface LogLine {
  /** What identifies the step, so the helper's heartbeat repeating it adds nothing. */
  key: string;
  text: string;
  at: number;
  /** How far along a step that measures itself, such as a format or the capacity test. */
  fraction: number | null;
  failed?: boolean;
}

export interface CardLog {
  lines: LogLine[];
  startedAt: number;
  endedAt: number | null;
  failed: boolean;
}

export function without<T>(record: Record<string, T>, ids: string[]): Record<string, T> {
  const next = { ...record };
  for (const id of ids) delete next[id];
  return next;
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** What stops each running operation that can stop, by screen and card. Outlives the screen. */
const controllers = new Map<string, AbortController>();

export function useCardLogs(scope: string) {
  const [logs, setLogs] = useKept<Record<string, CardLog>>(`${scope}:logs`, {});
  // The cards an action is under way on, from the click to the end: longer than the helper's
  // task, which does not cover asking for confirmation or reading the cards back. A card joins
  // when its log begins and leaves when it finishes, so one action can take on more cards.
  const [working, setWorking] = useKept<string[] | null>(`${scope}:working`, null);
  const [now, setNow] = useState(() => Date.now());
  // Cards whose running operation can be stopped: an image, a check.
  const [stoppableIds, setStoppableIds] = useKept<string[]>(`${scope}:stoppable`, []);
  const release = useCallback(
    (ids: string[]) => {
      for (const id of ids) controllers.delete(`${scope}:${id}`);
      setStoppableIds((current) => (current.some((id) => ids.includes(id)) ? current.filter((id) => !ids.includes(id)) : current));
    },
    [scope, setStoppableIds],
  );
  const join = useCallback(
    (ids: string[]) => setWorking((current) => [...new Set([...(current ?? []), ...ids])]),
    [setWorking],
  );
  const leave = useCallback(
    (ids: string[]) =>
      setWorking((current) => {
        const rest = (current ?? []).filter((id) => !ids.includes(id));
        return rest.length ? rest : null;
      }),
    [setWorking],
  );

  useEffect(() => {
    if (!working) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [working]);

  /** Starts a fresh log on each card, with a first line right away. */
  const begin = useCallback((ids: string[], text: string) => {
    const at = Date.now();
    setNow(at);
    join(ids);
    setLogs((previous) => ({
      ...previous,
      ...Object.fromEntries(
        ids.map((id) => [id, { lines: [{ key: text, text, at, fraction: null }], startedAt: at, endedAt: null, failed: false }]),
      ),
    }));
  }, [join, setLogs]);

  /** Adds a step to each card's log, or updates how far along it is if it is the same step. */
  const note = useCallback(
    (ids: string[], text: string, key = text, fraction: number | null = null) =>
      setLogs((previous) => {
        const next = { ...previous };
        for (const id of ids) {
          const log = next[id];
          if (!log) continue;
          const last = log.lines[log.lines.length - 1];
          const lines =
            last?.key === key
              ? [...log.lines.slice(0, -1), { ...last, fraction }]
              : [...log.lines, { key, text, at: Date.now(), fraction }];
          next[id] = { ...log, lines };
        }
        return next;
      }),
    [setLogs],
  );

  /** The helper's own progress, on the card it names, or on every card when it names none. */
  const follow = useCallback(
    (ids: string[]) => (progress: TaskProgress) => {
      if (!progress.stage || !progress.note) return; // the heartbeat's opening "Starting."
      const fraction = progress.totalBytes ? Math.min(1, (progress.bytesCopied ?? 0) / progress.totalBytes) : null;
      note(progress.device ? [progress.device] : ids, progress.note, `${progress.stage}:${progress.note}`, fraction);
    },
    [note],
  );

  const finish = useCallback((ids: string[], failure?: string) => {
    const at = Date.now();
    leave(ids);
    release(ids);
    setLogs((previous) => {
      const next = { ...previous };
      for (const id of ids) {
        const log = next[id];
        if (!log) continue;
        next[id] = {
          ...log,
          endedAt: at,
          failed: Boolean(failure),
          lines: failure ? [...log.lines, { key: 'failed', text: failure, at, fraction: null, failed: true }] : log.lines,
        };
      }
      return next;
    });
  }, [leave, release, setLogs]);

  /** Drops the logs, for an action that turned out to do nothing worth recording. */
  const forget = useCallback(
    (ids: string[]) => {
      leave(ids);
      release(ids);
      setLogs((previous) => without(previous, ids));
    },
    [leave, release, setLogs],
  );

  /** Makes a card's running operation stoppable, and returns what signals the stop. */
  const stoppable = useCallback(
    (id: string) => {
      const controller = new AbortController();
      controllers.set(`${scope}:${id}`, controller);
      setStoppableIds((current) => (current.includes(id) ? current : [...current, id]));
      return controller.signal;
    },
    [scope, setStoppableIds],
  );

  /** Asks a card's running operation to stop. The helper says when it has. */
  const stop = useCallback(
    (id: string) => {
      controllers.get(`${scope}:${id}`)?.abort();
      release([id]);
      note([id], 'Stopping.');
    },
    [scope, release, note],
  );

  const canStop = (id: string) => stoppableIds.includes(id);

  /** Drops the logs of cards no longer connected, unless something is still running on them. */
  const prune = useCallback(
    (present: string[]) =>
      setLogs((previous) => {
        const gone = Object.keys(previous).filter((id) => !present.includes(id) && !working?.includes(id));
        return gone.length ? without(previous, gone) : previous;
      }),
    [working, setLogs],
  );

  const isWorking = (id: string) => working?.includes(id) ?? false;

  return { logs, working, now, begin, note, follow, finish, forget, prune, isWorking, stoppable, stop, canStop };
}

export type CardLogs = ReturnType<typeof useCardLogs>;

/**
 * One card's log.
 *
 * While it runs, the step under way has a spinner, how long it has taken once that is long
 * enough to wonder about, and a bar when the helper can say how far along it is. Afterward the
 * log folds into one line, unless it ended in failure, when the reason is the last line.
 */
export function Activity({
  log,
  running,
  now,
  onStop,
}: Readonly<{ log: CardLog; running: boolean; now: number; onStop?: () => void }>) {
  const steps = (
    <ol className="card-log-lines">
      {log.lines.map((line, index) => {
        const current = running && index === log.lines.length - 1;
        const elapsed = now - line.at;
        return (
          <li key={`${index}:${line.key}`} className={line.failed ? 'failed' : current ? 'current' : 'done'}>
            <span className="card-log-mark" aria-hidden="true">
              {line.failed ? '✕' : current ? '' : '✓'}
            </span>
            <span className="card-log-text">
              {line.text}
              {current && line.fraction !== null ? <span className="muted"> {Math.round(line.fraction * 100)}%</span> : null}
              {current && elapsed >= 3000 ? <span className="muted"> · {duration(elapsed)}</span> : null}
              {current && onStop ? (
                <>
                  {' · '}
                  <button className="link-button" onClick={onStop}>
                    Stop
                  </button>
                </>
              ) : null}
              {current && line.fraction !== null ? (
                <span className="meter">
                  <i style={{ width: `${Math.round(line.fraction * 100)}%` }} />
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
  if (running || log.failed) {
    return (
      <div className="card-log" role="status" aria-live="polite">
        {steps}
      </div>
    );
  }
  return (
    <details className="card-log">
      <summary>What the A3EM Card Helper did · {duration((log.endedAt ?? now) - log.startedAt)}</summary>
      {steps}
    </details>
  );
}
