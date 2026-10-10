import { Route } from '@solidjs/router';
import { screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { ContactCard } from '../jmap/types';
import { ContactCardView } from './ContactCard';
import { contactsKit } from './contacts-test-kit';

vi.mock('../cache/persist', () => ({ loadContacts: vi.fn(async () => undefined), saveContacts: vi.fn(async () => undefined) }));

const card = (c: Partial<ContactCard>): ContactCard => ({ id: 'c1', addressBookIds: { b: true }, ...c });
const view = (c: ContactCard) => contactsKit().show('/', () => <Route path="/" component={() => <ContactCardView card={c} onDelete={() => {}} />} />);

describe('ContactCardView', () => {
  it('shows only the sections a card has', () => {
    view(card({ emails: { e: { address: 'only@x.example' } } }));
    expect(screen.getByRole('heading', { name: 'only@x.example' })).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    for (const absent of ['Phone', 'Address', 'Birthday', 'Notes']) expect(screen.queryByText(absent)).toBeNull();
  });
  it('builds the line under the name from what there is', () => {
    const line = (c: Partial<ContactCard>) => {
      const { container, unmount } = view(card({ name: { full: 'N' }, ...c }));
      const text = container.querySelector('.contact-org')?.textContent ?? null;
      unmount();
      return text;
    };
    expect(line({})).toBeNull();
    expect(line({ organizations: { o: { name: 'Acme' } } })).toBe('Acme');
    expect(line({ titles: { t: { name: 'Head' } } })).toBe('Head');
    expect(line({ titles: { t: { name: 'Head' } }, organizations: { o: { name: 'Acme', units: [{ name: 'Research' }] } } })).toBe('Head, Acme · Research');
  });
  it('shows a birthday with its year, an address on its lines, and the photo', () => {
    const { container } = view(card({
      name: { full: 'N' },
      anniversaries: { b: { kind: 'birth', date: { year: 1990, month: 3, day: 14 } } },
      addresses: { a: { full: '12 High St\nLeeds' } },
      notes: { n: { note: 'Likes tea.' } },
      media: { m: { kind: 'photo', uri: 'data:image/png;base64,AA' } },
      emails: { a: { address: 'a@x.example', contexts: { work: true }, pref: 1 }, b: { address: 'b@x.example' } },
    }));
    expect(screen.getByText(/1990/)).toBeInTheDocument();
    expect(screen.getByText(/12 High St/)).toBeInTheDocument();
    expect(screen.getByText('Likes tea.')).toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,AA');
    expect(screen.getByText('Preferred')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
  });
});
