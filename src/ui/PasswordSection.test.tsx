import { fireEvent, render, waitFor } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { createPassword } from '../app/password';
import { FakeJmap } from '../sync/fake-jmap';
import { PasswordSection } from './PasswordSection';

const setup = (server = new FakeJmap()) => {
  const changed = vi.fn<() => void>();
  const view = render(() => <PasswordSection password={createPassword(server.client(), changed)} />);
  const fill = (label: string, value: string) => fireEvent.input(view.getByLabelText(label), { target: { value } });
  const submit = (current: string, next: string, confirm = next) => {
    fill('Current password', current);
    fill('New password', next);
    fill('Confirm new password', confirm);
    fireEvent.click(view.getByRole('button', { name: 'Change password' }));
  };
  return { server, changed, submit, ...view };
};

describe('PasswordSection', () => {
  it('changes the password and leaves the form locked while the app signs out', async () => {
    const { server, changed, submit, getByRole } = setup();
    submit('oinbox-dev-pass', 'correct horse battery');
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(server.password).toBe('correct horse battery');
    expect(getByRole('button', { name: 'Changing…' })).toBeDisabled();
  });

  it('puts a wrong current password next to its field and lets the user try again', async () => {
    const { server, changed, submit, findByText, getByLabelText, getByRole } = setup();
    submit('not-the-password', 'correct horse battery');
    expect(await findByText('Current password is incorrect.')).toHaveAttribute('id', 'password-current-error');
    expect(getByLabelText('Current password')).toHaveAttribute('aria-invalid', 'true');
    expect(getByRole('button', { name: 'Change password' })).toBeEnabled();
    submit('oinbox-dev-pass', 'correct horse battery');
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(server.password).toBe('correct horse battery');
  });

  it("shows the server's reason under the new password", async () => {
    const { submit, findByText } = setup();
    submit('oinbox-dev-pass', '12345678');
    expect(await findByText(/This is a top-10 common password/)).toHaveAttribute('id', 'password-next-error');
  });

  it('clears an error once the user types again', async () => {
    const { submit, findByText, queryByText, getByLabelText } = setup();
    submit('oinbox-dev-pass', 'correct horse battery', 'something else 1');
    expect(await findByText("The two passwords don't match.")).toBeInTheDocument();
    fireEvent.input(getByLabelText('Confirm new password'), { target: { value: 'correct horse battery' } });
    expect(queryByText("The two passwords don't match.")).toBeNull();
  });

  it('lets a password manager tell the fields apart', () => {
    const { getByLabelText } = setup();
    expect(getByLabelText('Current password')).toHaveAttribute('autocomplete', 'current-password');
    expect(getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
    expect(getByLabelText('Confirm new password')).toHaveAttribute('autocomplete', 'new-password');
    for (const label of ['Current password', 'New password', 'Confirm new password']) expect(getByLabelText(label)).toHaveAttribute('type', 'password');
  });

  it('offers no form where the server has no password object', () => {
    const { queryByRole, getByText } = setup(Object.assign(new FakeJmap(), { passwordSupported: false }));
    expect(queryByRole('button')).toBeNull();
    expect(getByText(/can't be changed here/)).toBeInTheDocument();
  });
});
