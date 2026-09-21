import { useEffect, useState } from 'react';
import type { CopyProgress, CopyResult, IntegrityReport, RepairResult } from './transfer';

/**
 * State for the check-and-copy task, held above the view that renders it.
 *
 * Copying a full card runs for minutes. React unmounts OffloadCard the moment you look at
 * another section, so anything held inside it is discarded: the progress bar disappears on
 * return, and — worse — the copy carries on to completion and delivers its result and any
 * error to a component that no longer exists, so the outcome is lost silently. Holding the
 * state here means leaving and coming back shows exactly where the task got to.
 *
 * This is the same reason the deployment draft and batch list live in App rather than in
 * the views that render them.
 */
export function useOffloadTask() {
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [checking, setChecking] = useState<{ done: number; total: number } | null>(null);
  const [progress, setProgress] = useState<CopyProgress | null>(null);
  const [result, setResult] = useState<CopyResult | null>(null);
  const [repair, setRepair] = useState<RepairResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Switching sections is now safe, but a browser reload or close is not: the task lives in
  // this page and dies with it, part-copied. That case genuinely warrants a prompt.
  const busy = checking !== null || progress !== null;
  useEffect(() => {
    if (!busy) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  return {
    busy,
    report,
    setReport,
    checking,
    setChecking,
    progress,
    setProgress,
    result,
    setResult,
    repair,
    setRepair,
    error,
    setError,
  };
}

export type OffloadTask = ReturnType<typeof useOffloadTask>;
