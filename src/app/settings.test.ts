import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailEngine, SetFailure } from '../sync/engine';
import { FakeJmap } from '../sync/fake-jmap';
import type { ConfirmFn, ConfirmOptions } from '../ui/ConfirmDialog';
import type { ToastFn } from './actions';
import { createSettings, FieldError, failureMessage } from './settings';

describe('failureMessage', () => {
  const cases: [SetFailure, string, string][] = [
    [new SetFailure('invalidProperties', ['email'], 'E-mail address not configured for this account.'), 'email', "This account can't send as x@y.test. Ask your administrator to add it as an alias."],
    [new SetFailure('invalidProperties', ['email'], 'Invalid e-mail address.'), 'email', "'x@y.test' isn't an email address."],
    [new SetFailure('invalidProperties', ['name']), 'name', 'The name is too long.'],
    [new SetFailure('invalidProperties', ['htmlSignature']), 'signature', 'The signature is too long. Shorten it or remove some formatting.'],
    [new SetFailure('invalidProperties', ['subject']), 'subject', 'The subject is too long.'],
    [new SetFailure('invalidProperties', ['textBody']), 'message', 'The message is too long.'],
    [new SetFailure('overQuota'), 'form', 'You can have at most 20 identities. Delete one first.'],
    [new SetFailure('notFound'), 'form', 'This identity no longer exists.'],
    [new SetFailure('forbidden', [], 'Nope.'), 'form', 'Nope.'],
  ];
  it.each(cases)('maps %o', (err, field, message) => {
    expect(failureMessage(err, 'x@y.test')).toMatchObject({ field, message });
  });
  it('passes other errors through as form errors', () => {
    expect(failureMessage(new Error('offline'), '')).toMatchObject({ field: 'form', message: 'offline' });
  });
});

describe('createSettings', () => {
  let server: FakeJmap;
  let engine: MailEngine;
  let toast: ReturnType<typeof vi.fn<ToastFn>>;
  let asked: ConfirmOptions | null;
  let settings: ReturnType<typeof createSettings>;
  const sig = '<p>S</p>';

  beforeEach(async () => {
    server = new FakeJmap();
    engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    await engine.start();
    await vi.waitFor(() => expect(engine.state.vacationLoad).toBe('ready'));
    toast = vi.fn<ToastFn>();
    asked = null;
    const confirm: ConfirmFn = async (o) => {
      asked = o;
      await o.run?.();
      return true;
    };
    settings = createSettings(engine, toast, confirm);
  });

  it('adds and saves identities with toasts', async () => {
    const id = await settings.saveIdentity(null, { name: 'Support', email: 'alice@example.test', signatureHtml: sig });
    expect(toast).toHaveBeenLastCalledWith('Identity added.', 'success');
    await settings.saveIdentity(id, { name: 'Support 2', email: 'alice@example.test', signatureHtml: '' });
    expect(toast).toHaveBeenLastCalledWith('Identity saved.', 'success');
    expect(server.identities.get(id)).toMatchObject({ name: 'Support 2', htmlSignature: '' });
  });

  it('throws field errors from local checks without a request, and from the server', async () => {
    server.calls = [];
    await expect(settings.saveIdentity(null, { name: '', email: 'nope', signatureHtml: '' })).rejects.toMatchObject({ field: 'email' });
    expect(server.calls).toEqual([]);
    const err = await settings.saveIdentity(null, { name: '', email: 'bob@example.test', signatureHtml: '' }).catch((e) => e);
    expect(err).toBeInstanceOf(FieldError);
    expect(err.message).toBe("This account can't send as bob@example.test. Ask your administrator to add it as an alias.");
  });

  it('does nothing when asked to remove the only identity', async () => {
    expect(await settings.removeIdentity('id1')).toBe(false);
    expect(asked).toBeNull();
  });

  it('confirms before removing, naming the identity', async () => {
    const id = await settings.saveIdentity(null, { name: 'Support', email: 'alice@example.test', signatureHtml: '' });
    expect(await settings.removeIdentity(id)).toBe(true);
    expect(asked).toMatchObject({
      title: 'Delete identity?',
      message: "'Support <alice@example.test>' will no longer be offered as From. Sent mail and drafts are not changed.",
      confirmLabel: 'Delete',
      pendingLabel: 'Deleting…',
    });
    expect(toast).toHaveBeenLastCalledWith('Identity deleted.', 'success');
    expect(server.identities.has(id)).toBe(false);
  });

  it('toasts the vacation result by status', async () => {
    const input = { enabled: true, firstDay: null, lastDay: null, subject: '', message: 'Away' };
    await settings.saveVacation(input);
    expect(toast).toHaveBeenLastCalledWith('Vacation responder on.', 'success');
    await settings.saveVacation({ ...input, firstDay: '2099-01-01' });
    expect(toast).toHaveBeenLastCalledWith('Vacation responder scheduled.', 'success');
    await settings.turnOffVacation();
    expect(toast).toHaveBeenLastCalledWith('Vacation responder off.', 'success');
    expect(server.vacation.isEnabled).toBe(false);
    expect(server.vacation.textBody).toBe('Away');
  });

  it('refuses an invalid vacation locally', async () => {
    server.calls = [];
    await expect(settings.saveVacation({ enabled: true, firstDay: null, lastDay: null, subject: '', message: '' })).rejects.toMatchObject({ field: 'message' });
    expect(server.calls).toEqual([]);
  });
});
