import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type App } from '../app/context';
import { RECALL_MS } from '../app/linkPasswords';
import { LinkPasswordNote } from './LinkPasswordNote';

const URL = 'https://files.test/s/abc';
// Tomorrow at 15:26: still to come whenever the tests run, and with minutes the note can be seen to show.
const until = new Date(new Date().setHours(15, 26, 0, 0) + 86_400_000).getTime();

function setup(remembered: boolean, text = `<p>Files for this message: <a href="${URL}">${URL}</a></p>`) {
  const recallIn = vi.fn((body: string) => (remembered && body.includes(URL) ? [{ url: URL, password: 'Corr3ct-horse!', until }] : []));
  render(() => (
    <AppContext.Provider value={{ driveLinks: { recallIn } } as unknown as App}>
      <LinkPasswordNote text={text} />
    </AppContext.Provider>
  ));
  return { recallIn };
}

describe('LinkPasswordNote', () => {
  it('shows nothing for a message with no remembered link', () => {
    setup(false);
    expect(screen.queryByText(/Password for the Drive link/)).toBeNull();
    expect(RECALL_MS).toBe(30 * 60_000);
  });

  it('offers the password of a link made in this tab, hidden until asked for', () => {
    setup(true);
    const note = screen.getByText(/Password for the Drive link:/).closest('p')!;
    expect(note).not.toHaveTextContent('Corr3ct-horse!');
    expect(note).toHaveTextContent(/Kept in this tab until \d{1,2}[:.]26/);
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(note).toHaveTextContent('Corr3ct-horse!');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(note).not.toHaveTextContent('Corr3ct-horse!');
  });

  it('copies the password without showing it', () => {
    const writeText = vi.fn(async (_s: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup(true);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Corr3ct-horse!');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('goes when its time is up, though the message stays open', () => {
    vi.useFakeTimers();
    try {
      const soon = Date.now() + 60_000;
      const recallIn = vi.fn(() => [{ url: URL, password: 'Corr3ct-horse!', until: soon }]);
      render(() => (
        <AppContext.Provider value={{ driveLinks: { recallIn } } as unknown as App}>
          <LinkPasswordNote text={URL} />
        </AppContext.Provider>
      ));
      fireEvent.click(screen.getByRole('button', { name: 'Show' }));
      expect(screen.getByText('Corr3ct-horse!')).toBeInTheDocument();
      vi.advanceTimersByTime(60_001);
      expect(screen.queryByText(/Password for the Drive link/)).toBeNull();
      expect(screen.queryByText('Corr3ct-horse!')).toBeNull();
      // And the storage is asked again, which is what clears it there.
      expect(recallIn.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
