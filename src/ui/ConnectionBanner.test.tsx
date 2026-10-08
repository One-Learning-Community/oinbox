import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from '../sync/connection';
import { ConnectionBanner } from './ConnectionBanner';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ConnectionBanner', () => {
  it('is absent while connected', () => {
    const { container } = render(() => <ConnectionBanner connection={createConnection()} onSignIn={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('announces retrying and retries on demand', () => {
    const c = createConnection();
    const retry = vi.fn();
    c.onRetry(retry);
    render(() => <ConnectionBanner connection={c} onSignIn={() => {}} />);
    c.reportFailure('request', new TypeError('x'));
    c.reportFailure('request', new TypeError('x'));
    expect(screen.getByRole('status')).toHaveTextContent("Can't reach the server. Retrying…");
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(retry).toHaveBeenCalledTimes(1);
    c.reportSuccess('request');
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('offers sign-in when signed out', () => {
    const c = createConnection();
    const signIn = vi.fn();
    render(() => <ConnectionBanner connection={c} onSignIn={signIn} />);
    c.signedOut();
    expect(screen.getByRole('status')).toHaveTextContent("You've been signed out.");
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(signIn).toHaveBeenCalled();
  });
});
