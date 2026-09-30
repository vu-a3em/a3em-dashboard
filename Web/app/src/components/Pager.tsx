import { useEffect, useMemo, useState } from 'react';

/**
 * Paging for a table that would otherwise be cut off.
 *
 * Showing the first forty of six hundred and eighty-six, or the most recent twelve of
 * forty-one, is a dead end: the rows that explain a bad deployment are exactly the ones a
 * fixed slice hides. A run that goes wrong writes far more rows than one that goes right,
 * so the cases where the tail matters most are the cases where it is furthest out of
 * reach.
 */
export interface PageState<T> {
  /** Rows on the current page. */
  visible: T[];
  /** Zero-based index of the current page, already clamped to the list's length. */
  page: number;
  pageCount: number;
  /** Index of the first visible row within the whole list. */
  start: number;
  /** Length of the whole list, for the "of N" the controls report. */
  total: number;
  setPage: (page: number) => void;
  /** False when everything fits on one page and the controls should not appear. */
  needed: boolean;
}

/**
 * @param resetKey changes whenever a different list is in front of the reader, so picking
 *   another activation does not land them deep inside rows they have not seen.
 * @param startAtEnd for a chronological list whose newest rows are the interesting ones.
 */
export function usePager<T>(
  items: T[],
  perPage: number,
  resetKey?: unknown,
  startAtEnd = false,
): PageState<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / perPage));
  const [page, setPage] = useState(startAtEnd ? pageCount - 1 : 0);

  useEffect(() => {
    setPage(startAtEnd ? Math.max(0, Math.ceil(items.length / perPage) - 1) : 0);
    // `items` is rebuilt on every render, so the reset follows the key it derives from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, perPage, startAtEnd]);

  // Clamped rather than trusted: a shorter list can arrive in the same render that resets
  // the page, and a stale index would otherwise page past the end of the new list.
  const index = Math.min(Math.max(0, page), pageCount - 1);
  const start = index * perPage;
  const visible = useMemo(() => items.slice(start, start + perPage), [items, start, perPage]);

  return {
    visible,
    page: index,
    pageCount,
    start,
    total: items.length,
    setPage,
    needed: items.length > perPage,
  };
}

/**
 * The controls under a paged table.
 *
 * The range is spelled out rather than just the page number, because "where am I in this
 * run" is the question being asked; a bare "page 12 of 18" does not answer it. First and
 * Last matter as much as the steps once a list runs to hundreds.
 */
export function Pager<T>({ state, noun }: Readonly<{ state: PageState<T>; noun: string }>) {
  if (!state.needed) return null;
  const { page, pageCount, start, visible, total, setPage } = state;
  const first = (start + 1).toLocaleString();
  const last = (start + visible.length).toLocaleString();
  return (
    <div className="pager">
      <button type="button" className="btn small ghost" onClick={() => setPage(0)} disabled={page === 0}>
        First
      </button>
      <button type="button" className="btn small ghost" onClick={() => setPage(page - 1)} disabled={page === 0}>
        Previous
      </button>
      <p className="stat-note">
        {noun} {first}-{last} of {total.toLocaleString()}, page {page + 1} of {pageCount}
      </p>
      <button
        type="button"
        className="btn small ghost"
        onClick={() => setPage(page + 1)}
        disabled={page >= pageCount - 1}
      >
        Next
      </button>
      <button
        type="button"
        className="btn small ghost"
        onClick={() => setPage(pageCount - 1)}
        disabled={page >= pageCount - 1}
      >
        Last
      </button>
    </div>
  );
}
