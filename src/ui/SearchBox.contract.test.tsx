// src/ui/SearchBox.contract.test.tsx
import { Combobox, type ComboboxHandle } from '@rozie-ui/combobox-solid';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

// jsdom lays nothing out; the list scrolls its highlighted option into view.
Element.prototype.scrollIntoView = () => {};

/** What the search box asks of rozie Combobox. A failure here is a rozie change, not an oinbox bug. */
function box(initial: string[], options: { value: string; label: string }[] = []) {
  const [value, setValue] = createSignal(initial);
  const [opts, setOpts] = createSignal(options);
  const onSubmit = vi.fn((e: Event) => e.preventDefault());
  const onChange = vi.fn((e: { value: unknown }) => setValue(e.value as string[]));
  let handle: ComboboxHandle | undefined;
  let root: HTMLFormElement | undefined;
  render(() => (
    <form ref={root} onSubmit={onSubmit}>
      <Combobox ref={(h) => (handle = h)} multiple disableFilter hideEmpty disableOpenOnFocus chipLayout="inline" idBase="t" ariaLabel="Search mail"
        value={value()} options={opts()} onChange={onChange} />
    </form>
  ));
  const input = screen.getByRole('combobox') as HTMLInputElement;
  return { value, setOpts, onChange, onSubmit, input, handle: () => handle!, root: () => root! };
}

describe('Combobox, as the search box uses it', () => {
  it('leaves Enter alone when nothing is highlighted, so the form submits', () => {
    const { input, onChange } = box(['from:bob']);
    fireEvent.input(input, { target: { value: 'invoice' } });
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter' });
    expect(notPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows no list while there are no options', () => {
    const { input } = box([]);
    fireEvent.input(input, { target: { value: 'invoice' } });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('highlights the first option as soon as there is one, and Enter picks it without submitting', () => {
    const { input, setOpts, onChange } = box([]);
    fireEvent.input(input, { target: { value: 'is:' } });
    setOpts([{ value: 'is:unread', label: 'unread' }]);
    expect(screen.getAllByRole('option')).toHaveLength(1);
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter' });
    expect(notPrevented).toBe(false);
    expect(onChange.mock.calls[0]![0]).toMatchObject({ selected: true, option: { value: 'is:unread' } });
  });

  it('lets a capture listener take Backspace before it removes the last chip', () => {
    const { input, root, value } = box(['from:bob']);
    root().addEventListener('keydown', (e) => { if (e.key === 'Backspace') e.stopPropagation(); }, true);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(value()).toEqual(['from:bob']);
  });

  it('writes the input with seedQuery', () => {
    const { input, handle } = box([]);
    handle().seedQuery('from:bob');
    expect(input.value).toBe('from:bob');
  });

  it('renders a chip for a value that is in no option list', () => {
    box(['from:bob']);
    expect(screen.getByText('from:bob')).toBeTruthy();
  });
});
