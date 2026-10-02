import type { Navigator } from '@solidjs/router';
import type { App } from '../app/context';
import type { Nav } from './nav';

export interface ComposeCommands {
  compose: () => void;
  reply: (mode: 'reply' | 'replyAll' | 'forward') => void;
}

const GO: Record<string, string> = { i: '/inbox', s: '/starred', t: '/sent', d: '/drafts', a: '/archive' };

export const SHORTCUTS: [string, string][] = [
  ['j / k', 'Older / newer conversation'],
  ['o or Enter', 'Open conversation'],
  ['u', 'Back to list'],
  ['x', 'Select conversation'],
  ['e', 'Archive'],
  ['#', 'Delete'],
  ['!', 'Report spam'],
  ['s', 'Star / unstar'],
  ['Shift + i', 'Mark as read'],
  ['Shift + u', 'Mark as unread'],
  ['v', 'Move to'],
  ['l', 'Label'],
  ['c', 'Compose'],
  ['r', 'Reply'],
  ['a', 'Reply all'],
  ['f', 'Forward'],
  ['/', 'Search'],
  ['g then i / s / t / d / a', 'Go to Inbox / Starred / Sent / Drafts / Archive'],
  ['g then k', 'Go to Calendar'],
  ['?', 'Keyboard shortcuts'],
];

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/** Gmail's default keyboard shortcuts. Returns a disposer. */
export function installShortcuts(app: App, nav: Nav, navigate: Navigator, compose: ComposeCommands): () => void {
  let pendingG = 0;

  const move = (delta: number) => {
    const list = nav.list();
    if (!list) return;
    const open = nav.openThread();
    if (open) {
      // In a conversation, j/k open the next/previous conversation in the list.
      const i = list.indexOfThread(open);
      const next = list.threadIdAt(i + delta);
      if (i >= 0 && next) {
        nav.setCursor(i + delta);
        navigate(`/${list.view.slug}/t/${next}`);
      }
      return;
    }
    const i = Math.max(0, Math.min(list.count() - 1, nav.cursor() + delta));
    nav.setCursor(i);
    list.scrollToIndex(i);
  };

  const afterRemoval = () => {
    nav.clearSelection();
    if (nav.openThread() && nav.list()) navigate(`/${nav.list()!.view.slug}`);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(document.activeElement)) return;
    // Enter on a focused control activates that control; it doesn't open the cursor thread.
    if (e.key === 'Enter' && document.activeElement?.closest('button, a[href], [role="button"]')) return;
    if (nav.picker() || nav.helpOpen()) {
      if (e.key === 'Escape') {
        nav.setPicker(null);
        nav.setHelpOpen(false);
      }
      return;
    }

    if (Date.now() - pendingG < 1500) {
      pendingG = 0;
      const dest = e.key === 'k' ? (app.hasCalendars() ? '/calendar' : undefined) : GO[e.key];
      if (dest) {
        e.preventDefault();
        navigate(dest);
      }
      return;
    }

    const targets = nav.targets();
    const a = app.actions;
    let handled = true;
    switch (e.key) {
      case 'j':
        move(1);
        break;
      case 'k':
        move(-1);
        break;
      case 'o':
      case 'Enter': {
        const list = nav.list();
        const id = list?.threadIdAt(nav.cursor());
        if (list && id && !nav.openThread()) navigate(`/${list.view.slug}/t/${id}`);
        else handled = false;
        break;
      }
      case 'u':
        if (nav.list() && nav.openThread()) navigate(`/${nav.list()!.view.slug}`);
        break;
      case 'x': {
        const id = nav.list()?.threadIdAt(nav.cursor());
        if (id && !nav.openThread()) nav.toggleSelected(id);
        break;
      }
      case 'e':
        void a.archive(targets).then((ok) => ok && afterRemoval());
        break;
      case '#':
        void a.trash(targets).then((ok) => ok && afterRemoval());
        break;
      case '!':
        void a.spam(targets).then((ok) => ok && afterRemoval());
        break;
      case 's':
        void a.toggleStar(targets);
        break;
      case 'I':
        void a.markRead(targets);
        nav.clearSelection();
        break;
      case 'U':
        void a.markUnread(targets);
        nav.clearSelection();
        if (nav.openThread() && nav.list()) navigate(`/${nav.list()!.view.slug}`);
        break;
      case 'v':
        if (targets.length) nav.setPicker({ kind: 'move', threadIds: targets });
        break;
      case 'l':
        if (targets.length) nav.setPicker({ kind: 'label', threadIds: targets });
        break;
      case 'c':
        compose.compose();
        break;
      case 'r':
        compose.reply('reply');
        break;
      case 'a':
        compose.reply('replyAll');
        break;
      case 'f':
        compose.reply('forward');
        break;
      case '/':
        document.getElementById('search-input')?.focus();
        break;
      case 'g':
        pendingG = Date.now();
        break;
      case '?':
        nav.setHelpOpen(true);
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
