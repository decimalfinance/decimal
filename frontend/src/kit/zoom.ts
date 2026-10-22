/**
 * Screen pixels per CSS pixel at an element: 1.1 across the app, which reads at
 * 110% (html.app-zoom), and 1 on a bill's page. A mouse position and
 * getBoundingClientRect() are in screen pixels; offsetWidth, scrollTop and the
 * lengths a style is given are in the element's own CSS pixels, so a distance
 * read from one and written to the other divides by this.
 */
export function zoomOf(el: HTMLElement): number {
  const z = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof z === 'number' && z > 0) return z;
  // Without currentCSSZoom: the element's drawn width over its own.
  const w = el.offsetWidth;
  return w > 0 ? el.getBoundingClientRect().width / w : 1;
}
