import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { RootFallback } from './RootFallback';

describe('RootFallback', () => {
  it('offers Reload and the details, with no stylesheet classes', () => {
    const { container } = render(() => <RootFallback error={null} />);
    expect(screen.getByRole('alert')).toHaveTextContent('oinbox hit a problem and needs to reload.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByText(/Unknown error/)).toBeInTheDocument();
    expect(container.querySelector('[class]')).toBeNull();
  });
});
