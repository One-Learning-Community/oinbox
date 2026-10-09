import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { MenuButton } from './MenuButton';

function setup() {
  const first = vi.fn();
  const second = vi.fn();
  render(() => (
    <MenuButton class="icon-btn" title="Attach files" menuLabel="Attach files" items={[{ label: 'From this computer', run: first }, { label: 'From Drive', run: second }]}>
      {/* As in the app: an icon with no text, so the title is the name. */}
      <svg aria-hidden="true" />
    </MenuButton>
  ));
  return { first, second, button: screen.getByRole('button', { name: 'Attach files' }) };
}

describe('MenuButton', () => {
  it('is a button that says it has a menu, closed to begin with', () => {
    const { button } = setup();
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button.closest('.menu-anchor')).not.toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens with the focus on the first item and moves with the arrows', async () => {
    const { button } = setup();
    fireEvent.click(button);
    const [one, two] = await screen.findAllByRole('menuitem');
    expect(screen.getByRole('menu', { name: 'Attach files' })).toBeInTheDocument();
    await vi.waitFor(() => expect(one).toHaveFocus());
    fireEvent.keyDown(one!, { key: 'ArrowDown' });
    expect(two).toHaveFocus();
    fireEvent.keyDown(two!, { key: 'ArrowDown' });
    expect(one).toHaveFocus();
  });

  it('runs the chosen item once and closes with the focus back on the button', async () => {
    const { button, first, second } = setup();
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'From Drive' }));
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
  });

  it('closes on Escape without running anything', async () => {
    const { button, first, second } = setup();
    fireEvent.click(button);
    const [one] = await screen.findAllByRole('menuitem');
    fireEvent.keyDown(one!, { key: 'Escape' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});
