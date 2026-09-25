import { useState, type ReactNode } from 'react';
import type { Helper } from '../lib/useHelper';
import { InstallGuideDialog } from './HelperStatus';

/**
 * What the A3EM Card Helper would add to a page, said on that page, for someone without it.
 *
 * Everything works without the helper, so this says what it adds rather than what is missing,
 * and only where it could be installed: not in a browser that cannot use it, which the header
 * says already, and not while the dashboard is still looking for it.
 */
export function HelperOffer({
  helper,
  children,
  as = 'banner',
}: Readonly<{
  helper: Helper;
  /** What the helper adds here, as a sentence. */
  children: ReactNode;
  /** A banner of its own, or a note within a pane. */
  as?: 'banner' | 'note';
}>) {
  const [guide, setGuide] = useState(false);
  if (helper.status !== 'absent' && helper.status !== 'outdated') return null;
  const outdated = helper.status === 'outdated';
  const offer = (
    <>
      {children}{' '}
      <button className="link-button" onClick={() => setGuide(true)}>
        {outdated ? 'Update the A3EM Card Helper…' : 'Install the A3EM Card Helper…'}
      </button>
    </>
  );
  return (
    <>
      {as === 'banner' ? <div className="banner">{offer}</div> : <p className="card-help">{offer}</p>}
      {guide ? <InstallGuideDialog outdated={outdated} onClose={() => setGuide(false)} /> : null}
    </>
  );
}
