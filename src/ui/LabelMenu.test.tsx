import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type App } from '../app/context';
import type { Mailbox } from '../jmap/types';
import { LabelMenu } from './LabelMenu';
import { createNav } from './nav';

const work: Mailbox = {
  id: 'W', name: 'Work', role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
};

async function openMenu() {
  const nav = createNav();
  const labels = { remove: vi.fn(async () => false) };
  const app = { engine: { state: { mailboxes: { W: work } } }, labels, nav } as unknown as App;
  render(() => (
    <AppContext.Provider value={app}>
      <LabelMenu mailbox={work} />
    </AppContext.Provider>
  ));
  const trigger = screen.getByRole('button', { name: 'Options for Work' });
  fireEvent.click(trigger);
  const [rename, del] = await screen.findAllByRole('menuitem');
  await vi.waitFor(() => expect(rename).toHaveFocus());
  return { nav, labels, trigger, rename: rename!, del: del! };
}

describe('LabelMenu', () => {
  it('moves to the ends with End and Home', async () => {
    const { rename, del } = await openMenu();
    fireEvent.keyDown(rename, { key: 'End' });
    expect(del).toHaveFocus();
    fireEvent.keyDown(del, { key: 'Home' });
    expect(rename).toHaveFocus();
  });

  it('still wraps with the arrow keys', async () => {
    const { rename, del } = await openMenu();
    fireEvent.keyDown(rename, { key: 'ArrowUp' });
    expect(del).toHaveFocus();
    fireEvent.keyDown(del, { key: 'ArrowDown' });
    expect(rename).toHaveFocus();
  });

  it('closes on Tab, leaving the focus on its button for the browser to move on from', async () => {
    const { rename, trigger } = await openMenu();
    fireEvent.keyDown(rename, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('puts the focus on its button before Rename opens the dialog, so the dialog can hand it back', async () => {
    const { rename, trigger, nav } = await openMenu();
    fireEvent.click(rename);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(nav.labelDialog()).toEqual({ kind: 'rename', id: 'W' });
  });

  it('does the same before Delete asks', async () => {
    const { del, trigger, labels } = await openMenu();
    fireEvent.click(del);
    expect(trigger).toHaveFocus();
    expect(labels.remove).toHaveBeenCalledWith('W');
  });
});
