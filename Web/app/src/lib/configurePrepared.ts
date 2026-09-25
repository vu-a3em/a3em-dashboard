import { useKept } from './keptState';

/**
 * The last card prepared from Configure, and what was done to it, kept while the page is open.
 *
 * Kept apart from the component that prepares it, which is loaded only with the card tools and
 * goes when the card does: erasing a card takes the folder open on it too, and what was done to
 * it is still worth reading afterward.
 */
export interface ConfigurePrepared {
  kind: 'prepared' | 'settings';
  card: string;
  label: string;
  summary: string;
}

export function useConfigurePrepared() {
  return useKept<ConfigurePrepared | null>('configure:prepared', null);
}
