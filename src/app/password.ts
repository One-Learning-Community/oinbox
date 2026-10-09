import { UnauthorizedError, type JmapClient } from '../jmap/client';
import { CORE, STALWART } from '../jmap/types';
import { FieldError } from './settings';

export type PasswordField = 'current' | 'next' | 'confirm';
export interface PasswordInput {
  current: string;
  next: string;
  confirm: string;
}

/** Stalwart's own limits; it also refuses passwords it finds too easy to guess, in its own words. */
export const PASSWORD_LENGTH = { min: 8, max: 128 } as const;

/** What can be told without asking the server. Passwords are taken as typed: a space counts. */
function check(input: PasswordInput): FieldError | null {
  const length = [...input.next].length;
  if (!input.current) return new FieldError('current', 'Enter your current password.');
  if (length < PASSWORD_LENGTH.min) return new FieldError('next', `Use at least ${PASSWORD_LENGTH.min} characters.`);
  if (length > PASSWORD_LENGTH.max) return new FieldError('next', `Use at most ${PASSWORD_LENGTH.max} characters.`);
  // Stalwart would accept it, and sign every device out for nothing.
  if (input.next === input.current) return new FieldError('next', 'The new password is the same as the current one.');
  if (input.confirm !== input.next) return new FieldError('confirm', "The two passwords don't match.");
  return null;
}

/**
 * The signed-in user's own password, changed through Stalwart's password object. A shared mailbox
 * has none: the call always names the user's own account, whichever is on screen.
 */
export function createPassword(client: JmapClient, onChanged: () => void) {
  return {
    supported: (): boolean => client.hasSession && !!client.session.accounts[client.accountId]?.accountCapabilities?.[STALWART],

    /**
     * Throws a FieldError. Once it resolves the session is over: Stalwart derives token keys from
     * the password hash, so every token of the account, ours included, is refused from here on.
     */
    async change(input: PasswordInput): Promise<void> {
      const refused = check(input);
      if (refused) throw refused;
      const b = client.batch();
      const call = b.call('x:AccountPassword/set', {
        accountId: client.accountId,
        update: { singleton: { currentSecret: input.current, secret: input.next } },
      });
      let err;
      try {
        err = (await client.send(b, [CORE, STALWART])).get(call).notUpdated?.singleton;
      } catch (e) {
        if (e instanceof UnauthorizedError) throw new FieldError('form', "You've been signed out. Sign in and try again.");
        throw new FieldError('form', (e as Error).message);
      }
      if (err) {
        if (err.type === 'forbidden' && /incorrect/i.test(err.description ?? '')) throw new FieldError('current', 'Current password is incorrect.');
        if (err.type === 'invalidProperties' && err.description) throw new FieldError('next', err.description);
        throw new FieldError('form', err.description ?? `The password couldn't be changed (${err.type}).`);
      }
      onChanged();
    },
  };
}

export type Password = ReturnType<typeof createPassword>;

const CHANGED_KEY = 'oinbox.passwordChanged';

/** Leave word for the sign-in card the page is about to load. */
export function notePasswordChanged(storage: Storage): void {
  storage.setItem(CHANGED_KEY, '1');
}

/** The word left, once: '' when there is none. */
export function takePasswordNotice(storage: Storage): string {
  if (!storage.getItem(CHANGED_KEY)) return '';
  storage.removeItem(CHANGED_KEY);
  return 'Password changed. Sign in with your new password.';
}
