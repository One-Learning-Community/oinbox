import { render } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import type { OAuth } from '../auth/oauth';
import { SignIn } from './SignIn';

describe('SignIn', () => {
  it('shows a notice above the button, as a status and not an error', () => {
    const { getByRole, queryByRole } = render(() => <SignIn auth={{} as OAuth} notice="Password changed. Sign in with your new password." />);
    expect(getByRole('status')).toHaveTextContent('Password changed. Sign in with your new password.');
    expect(queryByRole('alert')).toBeNull();
  });
  it('has no status without a notice', () => {
    const { queryByRole } = render(() => <SignIn auth={{} as OAuth} />);
    expect(queryByRole('status')).toBeNull();
  });
});
