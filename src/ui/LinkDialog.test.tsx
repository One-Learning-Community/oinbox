import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type App } from '../app/context';
import { createDriveLinks, MB, type ComposerLike } from '../app/driveLinks';
import { createLinkPasswords } from '../app/linkPasswords';
import { checkPassword } from '../drive/password';
import { FakeDrive } from '../drive/fake';
import { LinkDialog } from './LinkDialog';

const NOW = new Date(2026, 9, 9, 12, 0);
const POLICY = { min: 8, max: 72, lower: 1, upper: 1, digits: 1, special: 1 };
const file = (name: string, bytes: number) => new File([new Uint8Array(bytes)], name);

function setup(opts: { passwordRequired?: boolean } = {}) {
  const server = new FakeDrive();
  server.passwordRequired = opts.passwordRequired ?? true;
  sessionStorage.clear();
  const passwords = createLinkPasswords(sessionStorage, () => NOW.getTime());
  const links = createDriveLinks({ drive: { offered: () => true, linkOverMb: () => 1000 / MB, client: server.client() }, toast: vi.fn(), passwords, maxUploadBytes: () => 5000, now: () => NOW });
  let draft = { subject: 'Report', bodyHtml: '<p>Hello</p>', attachments: [] as { size: number }[] };
  const attach = vi.fn(async (_files: File[]) => {});
  const c: ComposerLike = { draft: () => draft, update: (patch) => void (draft = { ...draft, ...patch }), attach };
  render(() => (
    <AppContext.Provider value={{ driveLinks: links } as unknown as App}>
      <LinkDialog />
    </AppContext.Provider>
  ));
  const add = (...files: File[]) => links.add(c, files.map((f) => ({ name: f.name, size: f.size, file: f })));
  return { server, links, passwords, attach, add, body: () => draft.bodyHtml };
}

const sendButton = () => screen.getByRole('button', { name: 'Send as a link' });
const passwordField = () => screen.findByLabelText(/^Password/);
const type = async (value: string) => fireEvent.input(await passwordField(), { target: { value } });

describe('LinkDialog', () => {
  it('shows nothing until files are too large for the message', () => {
    setup();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the files and their size, and wants a password where Drive requires one', async () => {
    const { add } = setup();
    void add(file('video.mp4', 3000), file('slides.pdf', 1048));
    expect(await screen.findByRole('heading', { name: 'Send as a Drive link' })).toBeInTheDocument();
    expect(screen.getByText(/video\.mp4, slides\.pdf/).closest('p')).toHaveTextContent('video.mp4, slides.pdf (4 KB)');
    expect(await passwordField()).toBeRequired();
    expect(screen.getByText('At least 8 characters, with a lower-case letter, an upper-case letter, a digit and a special character.')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    await type('Corr3ct-horse!');
    expect(sendButton()).toBeEnabled();
  });

  it('generates a password that meets the rules', async () => {
    const { add } = setup();
    void add(file('video.mp4', 3000));
    await passwordField();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    const made = ((await passwordField()) as HTMLInputElement).value;
    expect(made).toHaveLength(16);
    expect(checkPassword(made, POLICY)).toBe('');
    expect(sendButton()).toBeEnabled();
  });

  it('says which rule a typed password breaks, once the user has tried it', async () => {
    const { add } = setup();
    void add(file('video.mp4', 3000));
    await type('short');
    expect(screen.queryByText('At least 8 characters.')).toBeNull();
    fireEvent.blur(await passwordField());
    expect(screen.getByText('At least 8 characters.')).toHaveAttribute('role', 'alert');
    expect(await passwordField()).toHaveAttribute('aria-invalid', 'true');
    expect(sendButton()).toBeDisabled();
  });

  it('sends: the link goes into the message with its password, and the dialog closes', async () => {
    const { server, add, body } = setup();
    const done = add(file('video.mp4', 3000));
    await type('Corr3ct-horse!');
    fireEvent.click(sendButton());
    await done;
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.names(['Mail attachments', '2026-10-09 Report'])).toEqual(['video.mp4']);
    expect(body()).toContain('Password: Corr3ct-horse!');
    expect(body()).toContain('Available until 8 November 2026.');
  });

  it('keeps the password out of the message when it is to be sent another way, and offers to copy it', async () => {
    const writeText = vi.fn(async (_s: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { add, body, passwords } = setup();
    const done = add(file('video.mp4', 3000));
    await type('Corr3ct-horse!');
    expect(screen.getByRole('radio', { name: 'Put it in the message' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: "I'll send it another way" }));
    expect(screen.getByText(/stays available on the sent message for 30 minutes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Corr3ct-horse!');
    fireEvent.click(sendButton());
    await done;
    expect(body()).not.toContain('Password');
    expect(passwords.recall('https://files.test/s/link-1')?.password).toBe('Corr3ct-horse!');
  });

  it('lets the password be left out where Drive does not require one', async () => {
    const { server, add } = setup({ passwordRequired: false });
    const done = add(file('video.mp4', 3000));
    expect(await passwordField()).not.toBeRequired();
    expect(screen.queryByRole('radio')).toBeNull();
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    await done;
    expect(server.links[0]).toMatchObject({ password: undefined });
  });

  it('expires in 30 days unless told otherwise', async () => {
    const { server, add } = setup();
    const done = add(file('video.mp4', 3000));
    await type('Corr3ct-horse!');
    const expiry = screen.getByLabelText('The link expires') as HTMLSelectElement;
    expect(expiry.value).toBe('30');
    expect([...expiry.options].map((o) => o.textContent)).toEqual(['In 7 days', 'In 30 days', 'In 90 days', 'Never']);
    fireEvent.change(expiry, { target: { value: 'never' } });
    fireEvent.click(sendButton());
    await done;
    expect(server.links[0]!.expires).toBeUndefined();
  });

  it('offers only the expiries the server allows', async () => {
    const { links, add } = setup();
    vi.spyOn(links, 'loadRules').mockResolvedValue({ passwordRequired: true, policy: POLICY, maxExpiryDays: 14 });
    void add(file('video.mp4', 3000));
    const expiry = (await screen.findByLabelText('The link expires')) as HTMLSelectElement;
    await waitFor(() => expect([...expiry.options].map((o) => o.textContent)).toEqual(['In 7 days', 'In 14 days']));
    expect(expiry.value).toBe('14');
  });

  it('offers to attach anyway, unless a file is more than the mail server takes', async () => {
    const first = setup();
    const done = first.add(file('video.mp4', 3000));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach anyway' }));
    await done;
    expect(first.attach).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    void first.add(file('huge.iso', 6000));
    await screen.findByRole('heading', { name: 'Send as a Drive link' });
    expect(screen.queryByRole('button', { name: 'Attach anyway' })).toBeNull();
    expect(screen.getByText(/more than the mail server accepts/)).toBeInTheDocument();
  });

  it('shows the upload going up, and Cancel stops it', async () => {
    const { server, add, body, links } = setup();
    const done = add(file('video.mp4', 3000), file('b.bin', 2000));
    await type('Corr3ct-horse!');
    server.stall = true;
    fireEvent.click(sendButton());
    expect(await screen.findByText('Uploading video.mp4 (1 of 2)')).toHaveAttribute('role', 'status');
    await waitFor(() => expect(screen.getByRole('progressbar', { name: 'Upload progress' })).toHaveAttribute('value', '0.5'));
    expect(screen.queryByRole('button', { name: 'Send as a link' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await done;
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(body()).toBe('<p>Hello</p>');
    expect(links.request()).toBeNull();
  });

  it('says why it could not be done and lets the user try again', async () => {
    const { server, add } = setup();
    const done = add(file('video.mp4', 3000));
    await type('Corr3ct-horse!');
    server.down = true;
    fireEvent.click(sendButton());
    expect(await screen.findByText("Drive isn't available right now.")).toHaveAttribute('role', 'alert');
    server.down = false;
    fireEvent.click(sendButton());
    await done;
    expect(server.links).toHaveLength(1);
  });

  it('says so when the rules cannot be read, and tries again', async () => {
    const { server, add } = setup();
    server.down = true;
    void add(file('video.mp4', 3000));
    expect(await screen.findByText("Drive isn't available right now.")).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Attach anyway' })).toBeEnabled();
    server.down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await passwordField()).toBeRequired();
  });

  it('asks nothing when the message has its link already: it shows the files going into it', async () => {
    const { server, add } = setup();
    const first = add(file('video.mp4', 3000));
    await type('Corr3ct-horse!');
    fireEvent.click(sendButton());
    await first;
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    server.stall = true;
    const second = add(file('more.mov', 4000));
    expect(await screen.findByText("Adding to this message's Drive link.")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Password/)).toBeNull();
    expect(await screen.findByText('Uploading more.mov (1 of 1)')).toBeInTheDocument();
    server.stall = false;
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await second;
    expect(server.links).toHaveLength(1);
  });
});
