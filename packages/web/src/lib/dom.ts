/** The element at the right of the app bar that a view can fill with its own control. */
export const APP_BAR_SLOT_ID = 'app-bar-slot';

/** Scroll a field's box into view and move focus to it. */
export function showFieldBox(id: string): void {
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
  const box = document.querySelector<HTMLElement>(`[data-field-box="${escaped}"]`);
  if (!box) return;
  box.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  box.focus({ preventScroll: true });
}

/** The number of the page that fills most of a scroll area's visible part (1 if none). */
export function visiblePage(scroller: HTMLElement): number {
  const view = scroller.getBoundingClientRect();
  let best = 1;
  let bestArea = 0;
  for (const element of scroller.querySelectorAll<HTMLElement>('[data-page]')) {
    const box = element.getBoundingClientRect();
    const width = Math.min(box.right, view.right) - Math.max(box.left, view.left);
    const height = Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top);
    const area = Math.max(0, width) * Math.max(0, height);
    if (area > bestArea) {
      bestArea = area;
      best = Number(element.dataset.page) || 1;
    }
  }
  return best;
}
