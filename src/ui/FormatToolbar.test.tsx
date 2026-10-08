import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { FormatToolbar } from './FormatToolbar';

describe('FormatToolbar', () => {
  it('has no image button unless it is given somewhere to send images', () => {
    render(() => <FormatToolbar editor={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Insert image' })).toBeNull();
  });

  it('passes on the images chosen, and only images', () => {
    const onImage = vi.fn();
    const { container } = render(() => <FormatToolbar editor={() => undefined} onImage={onImage} />);
    expect(screen.getByRole('button', { name: 'Insert image' })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toBe('image/*');
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [png, pdf] } });
    expect(onImage).toHaveBeenCalledWith([png]);
  });
});
