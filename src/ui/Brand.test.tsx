import { render } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it } from 'vitest';
import { startBranding } from '../app/branding';
import { BrandMark } from './Brand';

const brandAs = (json: string) => startBranding(() => Promise.resolve(new Response(json)), localStorage, document);

beforeEach(() => localStorage.clear());

describe('BrandMark', () => {
  it('writes the name as a text mark, first letter accented', async () => {
    await brandAs('{"name":"Acme Mail"}');
    const { container } = render(() => <BrandMark />);
    expect(container.textContent).toBe('Acme Mail');
    expect(container.querySelector('b')?.textContent).toBe('A');
    expect(container.querySelector('img')).toBeNull();
  });
  it('shows the logo in place of the text, named for screen readers', async () => {
    await brandAs('{"name":"Acme Mail","logo":"https://cdn.example.com/logo.svg"}');
    const { getByRole, container } = render(() => <BrandMark />);
    expect(getByRole('img', { name: 'Acme Mail' })).toHaveAttribute('src', 'https://cdn.example.com/logo.svg');
    expect(container.textContent).toBe('');
  });
  it('is oinbox by default', async () => {
    await brandAs('{}');
    const { container } = render(() => <BrandMark />);
    expect(container.textContent).toBe('oinbox');
  });
});
