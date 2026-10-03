import type { Id, Identity } from '../jmap/types';
import { formatAddress } from '../mail/compose';
import {
  checkIdentity, checkVacation, vacationStatus, type IdentityField, type IdentityInput, type VacationField, type VacationInput,
} from '../mail/settings';
import { SetFailure, type MailEngine } from '../sync/engine';
import type { ConfirmFn } from '../ui/ConfirmDialog';
import type { ToastFn } from './actions';

export type Field = IdentityField | VacationField | 'form';

/** A message for one field of a settings form ('form' for the whole form). */
export class FieldError extends Error {
  constructor(
    readonly field: Field,
    message: string,
  ) {
    super(message);
  }
}

export const identityLabel = (i: Pick<Identity, 'name' | 'email'>) => formatAddress({ name: i.name || null, email: i.email });

/** Word a server refusal for the form. `address` is the address being created, for the alias message. */
export function failureMessage(e: unknown, address: string): FieldError {
  if (e instanceof FieldError) return e;
  if (!(e instanceof SetFailure)) return new FieldError('form', (e as Error).message);
  const prop = e.properties[0];
  if (e.type === 'invalidProperties') {
    if (prop === 'email') {
      return new FieldError('email', /not configured/i.test(e.message)
        ? `This account can't send as ${address}. Ask your administrator to add it as an alias.`
        : `'${address}' isn't an email address.`);
    }
    if (prop === 'name') return new FieldError('name', 'The name is too long.');
    if (prop === 'htmlSignature' || prop === 'textSignature') return new FieldError('signature', 'The signature is too long. Shorten it or remove some formatting.');
    if (prop === 'subject') return new FieldError('subject', 'The subject is too long.');
    if (prop === 'textBody' || prop === 'htmlBody') return new FieldError('message', 'The message is too long.');
  }
  if (e.type === 'overQuota') return new FieldError('form', 'You can have at most 20 identities. Delete one first.');
  if (e.type === 'notFound') return new FieldError('form', 'This identity no longer exists.');
  return new FieldError('form', e.message);
}

/** Identities and the vacation responder: validation, confirmation and toasts around the engine. */
export function createSettings(engine: MailEngine, toast: ToastFn, confirm: ConfirmFn) {
  return {
    /** Create (id null) or save an identity. Throws a FieldError. */
    async saveIdentity(id: Id | null, input: IdentityInput): Promise<Id> {
      const check = checkIdentity(input, id === null);
      if (!check.ok) throw new FieldError(check.field, check.error);
      try {
        if (id === null) {
          const created = await engine.createIdentity(check.value);
          toast('Identity added.', 'success');
          return created;
        }
        await engine.updateIdentity(id, check.value);
        toast('Identity saved.', 'success');
        return id;
      } catch (e) {
        throw failureMessage(e, check.value.email);
      }
    },

    /** Confirm, then delete. Resolves whether it was deleted. Never offered for the only identity. */
    async removeIdentity(id: Id): Promise<boolean> {
      const identity = engine.state.identities.find((i) => i.id === id);
      if (!identity || engine.state.identities.length <= 1) return false;
      try {
        const ok = await confirm({
          title: 'Delete identity?',
          message: `'${identityLabel(identity)}' will no longer be offered as From. Sent mail and drafts are not changed.`,
          confirmLabel: 'Delete',
          pendingLabel: 'Deleting…',
          run: () => engine.destroyIdentity(id),
        });
        if (!ok) return false;
      } catch (e) {
        toast(`Couldn't delete the identity: ${(e as Error).message}`, 'error');
        return false;
      }
      toast('Identity deleted.', 'success');
      return true;
    },

    /** Throws a FieldError. */
    async saveVacation(input: VacationInput): Promise<void> {
      const check = checkVacation(input);
      if (!check.ok) throw new FieldError(check.field, check.error);
      try {
        await engine.updateVacation(check.patch);
      } catch (e) {
        throw failureMessage(e, '');
      }
      const kind = vacationStatus({ id: 'singleton', ...check.patch }, new Date()).kind;
      toast(kind === 'scheduled' ? 'Vacation responder scheduled.' : kind === 'on' ? 'Vacation responder on.' : 'Vacation responder off.', 'success');
    },

    async turnOffVacation(): Promise<void> {
      try {
        await engine.updateVacation({ isEnabled: false });
        toast('Vacation responder off.', 'success');
      } catch (e) {
        toast(`Couldn't turn off the vacation responder: ${(e as Error).message}`, 'error');
      }
    },
  };
}

export type Settings = ReturnType<typeof createSettings>;
