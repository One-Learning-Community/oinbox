import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '../jmap/client';
import { FakeJmap, fakeClient } from '../sync/fake-jmap';
import { createPassword, notePasswordChanged, takePasswordNotice } from './password';

describe('createPassword', () => {
  let server: FakeJmap;
  let changed: ReturnType<typeof vi.fn<() => void>>;
  let password: ReturnType<typeof createPassword>;
  const input = (over: Partial<{ current: string; next: string; confirm: string }> = {}) => {
    const next = over.next ?? 'correct horse battery';
    return { current: 'oinbox-dev-pass', next, confirm: next, ...over };
  };

  beforeEach(() => {
    server = new FakeJmap();
    changed = vi.fn<() => void>();
    password = createPassword(server.client(), changed);
  });

  it('changes the password and reports it', async () => {
    await password.change(input());
    expect(server.password).toBe('correct horse battery');
    expect(changed).toHaveBeenCalledOnce();
  });

  it('keeps spaces at either end of a password', async () => {
    await password.change(input({ next: '  spaced out pass  ' }));
    expect(server.password).toBe('  spaced out pass  ');
  });

  const refused: [string, Partial<{ current: string; next: string; confirm: string }>, string, string][] = [
    ['no current password', { current: '' }, 'current', 'Enter your current password.'],
    ['a short password', { next: 'seven77' }, 'next', 'Use at least 8 characters.'],
    ['a password over 128 characters', { next: 'x'.repeat(129) }, 'next', 'Use at most 128 characters.'],
    ['the current password again', { next: 'oinbox-dev-pass' }, 'next', 'The new password is the same as the current one.'],
    ['a confirmation that differs', { confirm: 'correct horse batterx' }, 'confirm', "The two passwords don't match."],
  ];
  it.each(refused)('refuses %s without asking the server', async (_name, over, field, message) => {
    await expect(password.change(input(over))).rejects.toMatchObject({ field, message });
    expect(server.calls).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('accepts 8 and 128 characters', async () => {
    await password.change(input({ next: 'zq7!vk2#' }));
    await expect(createPassword(new FakeJmap().client(), changed).change(input({ next: 'zq7!'.repeat(32) }))).resolves.toBeUndefined();
  });

  it('says so when the current password is wrong', async () => {
    await expect(password.change(input({ current: 'not-the-password' }))).rejects.toMatchObject({ field: 'current', message: 'Current password is incorrect.' });
    expect(server.password).toBe('oinbox-dev-pass');
    expect(changed).not.toHaveBeenCalled();
  });

  it("shows the server's reason for refusing a weak password", async () => {
    await expect(password.change(input({ next: '12345678' }))).rejects.toMatchObject({
      field: 'next',
      message: 'Password is too weak. This is a top-10 common password. Add another word or two. Uncommon words are better.',
    });
    expect(changed).not.toHaveBeenCalled();
  });

  it("changes the user's own password while a shared mailbox is in the session", async () => {
    const own = new FakeJmap();
    const shared = Object.assign(new FakeJmap(), { accountId: 'g1', accountName: 'support@example.test', personal: false });
    await createPassword(fakeClient([own, shared]), changed).change(input());
    expect(own.password).toBe('correct horse battery');
    expect(shared.calls).toEqual([]);
  });

  it('asks the user to sign in when the session has already ended', async () => {
    server.revoked = true;
    await expect(password.change(input())).rejects.toMatchObject({ field: 'form', message: "You've been signed out. Sign in and try again." });
    expect(changed).not.toHaveBeenCalled();
  });

  it('is offered only where the server has the password object', () => {
    expect(password.supported()).toBe(true);
    const without = Object.assign(new FakeJmap(), { passwordSupported: false });
    expect(createPassword(without.client(), changed).supported()).toBe(false);
  });
});

describe('the fake password object', () => {
  const set = (server: FakeJmap, patch: Record<string, unknown>, using = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']) =>
    server.handle('x:AccountPassword/set', { accountId: server.accountId, update: { singleton: patch } }, using);

  it('needs the current password', () => {
    expect(set(new FakeJmap(), { secret: 'correct horse battery' })[1]).toMatchObject({
      notUpdated: { singleton: { type: 'forbidden', description: 'Current secret must be provided to change the password or OTP auth.' } },
    });
  });
  it('needs the Stalwart capability', () => {
    expect(set(new FakeJmap(), { currentSecret: 'oinbox-dev-pass', secret: 'correct horse battery' }, ['urn:ietf:params:jmap:core'])[0]).toBe('error');
  });
  it('does not exist on a shared account', () => {
    const shared = Object.assign(new FakeJmap(), { personal: false });
    expect(set(shared, { currentSecret: 'oinbox-dev-pass', secret: 'correct horse battery' })[1]).toMatchObject({ notUpdated: { singleton: { type: 'notFound' } } });
  });
  it('ends the session once the password is set, even to the same one', async () => {
    const server = new FakeJmap();
    const client = server.client();
    expect(set(server, { currentSecret: 'oinbox-dev-pass', secret: 'oinbox-dev-pass' })[1]).toMatchObject({ updated: { singleton: null } });
    await expect(client.send(client.batch())).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('the notice after a password change', () => {
  it('is shown once, on the sign-in that follows', () => {
    sessionStorage.clear();
    expect(takePasswordNotice(sessionStorage)).toBe('');
    notePasswordChanged(sessionStorage);
    expect(takePasswordNotice(sessionStorage)).toBe('Password changed. Sign in with your new password.');
    expect(takePasswordNotice(sessionStorage)).toBe('');
  });
});
