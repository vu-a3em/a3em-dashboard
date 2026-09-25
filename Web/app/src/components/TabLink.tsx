import { createContext, useContext, type ReactNode } from 'react';

/**
 * A tab, named wherever the dashboard mentions one, as a link that opens it.
 *
 * Text that sends someone to another tab — prepare it under Prepare devices, correct the times in
 * Review card — is only half the help unless the name can be clicked, so every mention is a link,
 * and like the rail's own entries it is not in quotes. App.tsx provides the way there.
 */

export type View = 'configure' | 'batch' | 'review' | 'clips' | 'offload' | 'recover';

export const VIEW_NAMES: Record<View, string> = {
  configure: 'Configure',
  batch: 'Prepare devices',
  review: 'Review card',
  clips: 'Listen',
  offload: 'Check & copy',
  recover: 'Recover card',
};

export const NavigationContext = createContext<((view: View) => void) | null>(null);

export function TabLink({ to, children }: Readonly<{ to: View; children?: ReactNode }>) {
  const go = useContext(NavigationContext);
  const name = children ?? VIEW_NAMES[to];
  if (!go) return <>{name}</>;
  return (
    <button type="button" className="link-button" onClick={() => go(to)}>
      {name}
    </button>
  );
}

const BY_NAME = new Map(Object.entries(VIEW_NAMES).map(([view, name]) => [name, view as View]));
const QUOTED_TAB = new RegExp(`“(${[...BY_NAME.keys()].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})”`);

/**
 * A message written as text, as the checks' are, with each tab it names in quotes — “Prepare
 * devices” — shown as a link to that tab instead.
 */
export function WithTabLinks({ text }: Readonly<{ text: string }>) {
  const parts = text.split(QUOTED_TAB);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 ? <TabLink key={index} to={BY_NAME.get(part)!} /> : part,
      )}
    </>
  );
}
