/**
 * The screens that exist only with the card helper, loaded on their own.
 *
 * Most visitors never install the helper, so its screens stay out of the bundle everyone
 * downloads. They are fetched the moment the helper answers rather than when first opened:
 * there is no service worker, so a page that loses its connection in the field could not fetch
 * them later, and by then they are already here.
 */
export const loadConnectedCards = () => import('../components/ConnectedCards');
export const loadPhysicalCard = () => import('../components/PhysicalCard');
export const loadRecoverCard = () => import('../views/RecoverCard');

export function preloadHelperViews(): void {
  void loadConnectedCards();
  void loadPhysicalCard();
  void loadRecoverCard();
}
