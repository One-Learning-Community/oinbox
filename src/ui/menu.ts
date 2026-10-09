/**
 * Keys for a popover menu of `[role="menuitem"]` buttons: the arrows wrap, Home and End jump,
 * Escape and Tab close. Tab is not prevented, so the browser carries it on from the menu's button.
 */
export function menuKeys(items: () => HTMLElement[], close: () => void): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key === 'Escape' || e.key === 'Tab') return close();
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 };
    const to = moves[e.key];
    if (to === undefined) return;
    e.preventDefault();
    list[(to + list.length) % list.length]?.focus();
  };
}
