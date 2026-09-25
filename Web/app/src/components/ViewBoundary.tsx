import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps a failure in one tab from blanking the whole dashboard.
 *
 * Without it, any error while showing a tab unmounts everything, leaving an empty page. The one
 * that happens in normal use is a deployment landing while the page is open: the screens loaded
 * on demand (Recover card, the card tools) are named by their contents, a new build renames them,
 * and the page still asking for the old names finds nothing there. A reload fetches the new
 * build. It is offered rather than done, since a copy may be running in another tab.
 */

/** Chrome's, Safari's and Firefox's ways of saying a module on demand could not be fetched. */
const STALE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

export class ViewBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('A tab stopped with an error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = STALE.test(error.message);
    return (
      <div className="card">
        <h2>{stale ? 'The dashboard has been updated' : 'This tab stopped with an error'}</h2>
        <p className="hint">
          {stale
            ? 'A newer version was published since this page was opened, and this part of the old one is no longer there. Reload the page to use the new version.'
            : `Something went wrong showing it: ${error.message}. Reload the page; if it happens again, please report it with this message.`}
        </p>
        <button className="btn primary" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      </div>
    );
  }
}
