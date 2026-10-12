import { describe, expect, it } from 'vitest';
import { trackCoveredStrips } from './visible';

/** A window 800px high whose visual viewport the test moves. */
function fakeWindow() {
  const view = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  const root = document.createElement('html');
  Object.defineProperty(root, 'clientHeight', { value: 800 });
  const win = { visualViewport: view, document: { documentElement: root } } as unknown as Window;
  const move = (to: Partial<typeof view>, event = 'resize') => {
    Object.assign(view, to);
    view.dispatchEvent(new Event(event));
  };
  const strips = () => [root.style.getPropertyValue('--covered-top'), root.style.getPropertyValue('--covered-bottom')];
  return { win, move, strips };
}

describe('trackCoveredStrips', () => {
  it('sets nothing while the whole window shows', () => {
    const { win, strips } = fakeWindow();
    trackCoveredStrips(win);
    expect(strips()).toEqual(['', '']);
  });

  it('gives the strip under a keyboard, and takes it back when the keyboard goes', () => {
    const { win, move, strips } = fakeWindow();
    trackCoveredStrips(win);
    move({ height: 460 });
    expect(strips()).toEqual(['0px', '340px']);
    move({ height: 800 });
    expect(strips()).toEqual(['', '']);
  });

  it('follows the page when the browser slides it up under the keyboard', () => {
    const { win, move, strips } = fakeWindow();
    trackCoveredStrips(win);
    move({ height: 460 });
    move({ offsetTop: 120 }, 'scroll');
    expect(strips()).toEqual(['120px', '220px']);
  });

  it('sets nothing while the page is pinch-zoomed', () => {
    const { win, move, strips } = fakeWindow();
    trackCoveredStrips(win);
    move({ height: 460 });
    move({ height: 400, offsetTop: 100, scale: 2 });
    expect(strips()).toEqual(['', '']);
  });

  it('stops when asked, and does nothing in a browser without a visual viewport', () => {
    const { win, move, strips } = fakeWindow();
    trackCoveredStrips(win)();
    move({ height: 460 });
    expect(strips()).toEqual(['', '']);
    expect(() => trackCoveredStrips({ visualViewport: null } as unknown as Window)()).not.toThrow();
  });
});
