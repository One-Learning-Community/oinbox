/**
 * Keeps `--covered-top` and `--covered-bottom` on the root element: the strips of the window that are not on
 * screen while an on-screen keyboard is up. iOS draws its keyboard over the page without resizing it, and may
 * slide the page up under it, so a layer that fills the window (the composer on a phone, styles.css) would
 * have its last rows, Send among them, under the keyboard.
 *
 * Both are removed when nothing is covered, and while the page is pinch-zoomed: the visible part is smaller
 * then too, but nothing lies over the page. Returns a function that stops the tracking.
 */
export function trackCoveredStrips(win: Window = window): () => void {
  const view = win.visualViewport;
  if (!view) return () => {};
  const root = win.document.documentElement;
  const update = () => {
    const top = Math.max(0, Math.round(view.offsetTop));
    const bottom = Math.max(0, Math.round(root.clientHeight - view.height - view.offsetTop));
    if (Math.abs(view.scale - 1) > 0.01 || top + bottom === 0) {
      root.style.removeProperty('--covered-top');
      root.style.removeProperty('--covered-bottom');
      return;
    }
    root.style.setProperty('--covered-top', `${top}px`);
    root.style.setProperty('--covered-bottom', `${bottom}px`);
  };
  view.addEventListener('resize', update);
  view.addEventListener('scroll', update);
  update();
  return () => {
    view.removeEventListener('resize', update);
    view.removeEventListener('scroll', update);
  };
}
