import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type VirtualItem,
} from '@tanstack/virtual-core';
import { createEffect, createSignal, onCleanup, onMount, type Accessor } from 'solid-js';

/** Minimal Solid binding for @tanstack/virtual-core. */
export function createVirtualList(opts: {
  count: Accessor<number>;
  scrollElement: Accessor<HTMLElement | undefined>;
  rowHeight: Accessor<number>;
  overscan?: number;
}) {
  const [items, setItems] = createSignal<VirtualItem[]>([]);
  const [totalSize, setTotalSize] = createSignal(0);

  const sync = (v: Virtualizer<HTMLElement, Element>) => {
    setItems(v.getVirtualItems());
    setTotalSize(v.getTotalSize());
  };

  const virtualizer = new Virtualizer<HTMLElement, Element>({
    count: opts.count(),
    getScrollElement: () => opts.scrollElement() ?? null,
    estimateSize: () => opts.rowHeight(),
    overscan: opts.overscan ?? 10,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    onChange: sync,
  });

  onMount(() => {
    const cleanup = virtualizer._didMount();
    virtualizer._willUpdate();
    sync(virtualizer);
    onCleanup(cleanup);
  });

  createEffect(() => {
    const count = opts.count();
    const h = opts.rowHeight();
    virtualizer.setOptions({ ...virtualizer.options, count, estimateSize: () => h });
    virtualizer.measure();
    virtualizer._willUpdate();
    sync(virtualizer);
  });

  return { items, totalSize, virtualizer };
}

export function createMediaQuery(query: string): Accessor<boolean> {
  const m = matchMedia(query);
  const [matches, setMatches] = createSignal(m.matches);
  const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
  m.addEventListener('change', onChange);
  onCleanup(() => m.removeEventListener('change', onChange));
  return matches;
}
