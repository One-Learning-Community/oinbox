import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type App } from '../app/context';
import { CalendarStore } from '../calendar/store';
import type { CalendarEvent } from '../jmap/types';
import type { EmailRec } from '../sync/engine';
import { FakeJmap } from '../sync/fake-jmap';
import { InviteCard, InviteCardView } from './InviteCard';

const base = {
  title: 'Design review', when: 'Tue 8 Dec, 10:00–11:00 (Europe/London)', where: 'Room 4', repeats: null, organizer: 'Bob Example',
  guests: [{ name: 'Bob Example', status: 'accepted' }, { name: 'Alice', status: 'needs-action' }],
  state: { kind: 'active', answer: 'needs-action', updated: false } as const, note: null, canAnswer: true, busy: false, onAnswer: () => undefined,
};

describe('InviteCardView', () => {
  it('shows the details and three answer buttons', () => {
    render(() => <InviteCardView {...base} />);
    expect(screen.getByText('Design review')).toBeInTheDocument();
    expect(screen.getByText('Organizer: Bob Example')).toBeInTheDocument();
    for (const n of ['Accept', 'Maybe', 'Decline']) expect(screen.getByRole('button', { name: n })).toBeEnabled();
  });
  it('highlights the current answer and reports a click', () => {
    const onAnswer = vi.fn();
    render(() => <InviteCardView {...base} state={{ kind: 'active', answer: 'tentative', updated: false }} onAnswer={onAnswer} />);
    expect(screen.getByRole('button', { name: 'Maybe' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onAnswer).toHaveBeenCalledWith('accepted');
  });
  it('disables the buttons while a reply is in flight', () => {
    render(() => <InviteCardView {...base} busy />);
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();
  });
  it('says the invitation was updated', () => {
    render(() => <InviteCardView {...base} state={{ kind: 'active', answer: 'accepted', updated: true }} />);
    expect(screen.getByText('Updated since this message')).toBeInTheDocument();
  });
  it('shows Cancelled with no buttons', () => {
    render(() => <InviteCardView {...base} state={{ kind: 'cancelled' }} />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
  it('shows the note and no buttons when the event is missing or the user is not a guest', () => {
    render(() => <InviteCardView {...base} state={{ kind: 'missing' }} note="This event isn't in your calendar" />);
    expect(screen.getByText("This event isn't in your calendar")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Maybe' })).toBeNull();
  });
  it('hides the buttons when the calendar does not allow answering', () => {
    render(() => <InviteCardView {...base} canAnswer={false} />);
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
  it('mentions repetition', () => {
    render(() => <InviteCardView {...base} repeats="Repeats weekly" />);
    expect(screen.getByText('Repeats weekly')).toBeInTheDocument();
  });
});

describe('InviteCard', () => {
  const email = { attachments: [{ partId: '2', blobId: 'blob1', size: 1, type: 'text/calendar', name: null, cid: null, disposition: null }] } as unknown as EmailRec;
  const guestCopy: CalendarEvent = {
    id: 'b1', uid: 'u1', sequence: 0, title: 'Review', start: '2026-10-05T09:00:00', timeZone: 'UTC', duration: 'PT1H', isOrigin: false, calendarIds: { c1: true },
    participants: {
      o: { name: 'Bob Example', calendarAddress: 'mailto:bob@example.test', roles: { owner: true }, participationStatus: 'accepted' },
      a: { calendarAddress: 'mailto:alice@example.test', roles: { attendee: true }, participationStatus: 'needs-action' },
    },
  };

  async function mount(over: { copy?: Partial<CalendarEvent>; mayRSVP?: boolean } = {}) {
    const server = new FakeJmap();
    server.calendars.set('c1', { id: 'c1', name: 'Personal', color: null, sortOrder: 0, isDefault: true, isVisible: true, myRights: { mayRSVP: over.mayRSVP ?? true } });
    server.baseEvents.set('b1', { ...guestCopy, ...over.copy });
    server.parsedBlobs.set('blob1', [{ id: 'p', uid: 'u1', method: 'request', sequence: 0, title: 'Review', start: '2026-10-05T09:00:00' }]);
    const toast = vi.fn();
    const store = createRoot(() => new CalendarStore(server.client(), toast, 'UTC'));
    await store.loadCalendars();
    const app = { calendar: store, engine: { myAddresses: () => new Set(['alice@example.test']) }, toast } as unknown as App;
    render(() => <AppContext.Provider value={app}><InviteCard email={email} /></AppContext.Provider>);
    return { server, store, toast };
  }

  it('shows the card, answers once, and says who was told', async () => {
    const { server, toast } = await mount();
    const accept = await screen.findByRole('button', { name: 'Accept' });
    fireEvent.click(accept);
    expect(accept).toBeDisabled(); // a second click can't send a second reply
    fireEvent.click(accept);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Reply sent to Bob Example', 'success'));
    expect(server.calendarSets).toHaveLength(1);
  });
  it('turns to "not in your calendar" when the copy is deleted and the store refreshes', async () => {
    const { server, store } = await mount();
    await screen.findByRole('button', { name: 'Accept' });
    server.baseEvents.delete('b1');
    await store.refresh();
    expect(await screen.findByText("This event isn't in your calendar")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
  it('shows no card when the lookup fails, instead of claiming the event is missing', async () => {
    const server = new FakeJmap();
    server.failCalendarQueries = true;
    server.parsedBlobs.set('blob1', [{ id: 'p', uid: 'u1', method: 'request', sequence: 0, start: '2026-10-05T09:00:00' }]);
    const store = createRoot(() => new CalendarStore(server.client(), vi.fn(), 'UTC'));
    const app = { calendar: store, engine: { myAddresses: () => new Set(['alice@example.test']) }, toast: vi.fn() } as unknown as App;
    const { container } = render(() => <AppContext.Provider value={app}><InviteCard email={email} /></AppContext.Provider>);
    await waitFor(() => expect(server.calls).toContain('CalendarEvent/query'));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('.invite-card')).toBeNull();
  });
  it("explains why there are no buttons for the organiser's own event, and when the calendar forbids answering", async () => {
    await mount({ copy: { isOrigin: true } });
    expect(await screen.findByText("You're the organizer of this event")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
  it('explains it when the calendar does not allow answering', async () => {
    await mount({ mayRSVP: false });
    expect(await screen.findByText("This calendar doesn't let you answer invitations")).toBeInTheDocument();
  });
});
