import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { InviteCardView } from './InviteCard';

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
