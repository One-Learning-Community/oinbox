import { Route } from '@solidjs/router';
import { fireEvent, screen, within } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { downloadText } from '../contacts/download';
import { peekVcard, splitVcards } from '../contacts/vcard';
import { contactsKit } from './contacts-test-kit';
import { ContactsView } from './ContactsView';
import { ImportDialog } from './ImportDialog';

vi.mock('../cache/persist', () => ({ loadContacts: vi.fn(async () => undefined), saveContacts: vi.fn(async () => undefined) }));
vi.mock('../contacts/download', () => ({ downloadText: vi.fn() }));
vi.mock('./virtual', () => ({
  createVirtualList: (opts: { count: () => number }) => ({
    items: () => Array.from({ length: opts.count() }, (_, index) => ({ index, key: index, start: index * 48, end: (index + 1) * 48, size: 48 })),
    totalSize: () => opts.count() * 48,
    virtualizer: { scrollToIndex: () => {} },
  }),
}));

const vc = (...lines: string[]) => ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD', ''].join('\r\n');
const person = (i: number) => vc(`FN:P${i}`, `EMAIL:p${i}@x.example`, `UID:u-${i}`);
const people = (n: number, from = 0) => Array.from({ length: n }, (_, i) => person(from + i)).join('');

async function opened(seed: (kit: ReturnType<typeof contactsKit>) => void = () => {}) {
  const kit = contactsKit();
  seed(kit);
  await kit.contacts.start('k');
  kit.show('/contacts', () => <Route path="/contacts" component={() => <><ContactsView /><ImportDialog /></>} />);
  kit.contacts.openImport();
  const input = (await screen.findByLabelText('vCard files')) as HTMLInputElement;
  const choose = (...texts: string[]) => fireEvent.change(input, { target: { files: texts.map((t, i) => new File([t], `f${i}.vcf`, { type: 'text/vcard' })) } });
  return { ...kit, input, choose, dialog: () => within(screen.getByRole('dialog')) };
}

describe('ImportDialog', () => {
  it('shows what the files hold before anything is sent, and what importing costs', async () => {
    const { choose, dialog, fake } = await opened((kit) => kit.fake.addCard({ uid: 'u-1', name: { full: 'P1' } }));
    choose(people(3) + vc('FN:Team', 'KIND:group', 'UID:g-1') + 'BEGIN:VCARD\r\nFN:Cut short\r\n');
    expect(await dialog().findByText('4 contacts found, 1 of them a group')).toBeInTheDocument();
    expect(dialog().getByText('1 already in your contacts')).toBeInTheDocument();
    expect(dialog().getByText('1 could not be read')).toBeInTheDocument();
    expect(dialog().getByText(/^The server reads each contact as an uploaded file, and counts it against the same hourly allowance as your attachments \(usually 1,000 files an hour; your administrator may have set another\)\.$/)).toBeInTheDocument();
    expect(dialog().getByRole('button', { name: 'Import 3' })).toBeInTheDocument();
    expect(fake.calls).not.toContain('Blob/upload');
  });
  it('imports the duplicates too when told to', async () => {
    const { choose, dialog, fake, contacts } = await opened((kit) => kit.fake.addCard({ uid: 'u-1', name: { full: 'P1' } }));
    choose(people(3));
    fireEvent.click(await dialog().findByRole('switch', { name: 'Skip duplicates' }));
    fireEvent.click(dialog().getByRole('button', { name: 'Import 3' }));
    expect(await dialog().findByText('Imported 3 contacts.')).toBeInTheDocument();
    expect(dialog().queryByText(/^Skipped/)).toBeNull();
    expect([...fake.cards.values()].filter((c) => c.name?.full === 'P1')).toHaveLength(2);
    expect(contacts.people()).toHaveLength(4);
  });
  it('imports, skipping what is already there, and says what happened', async () => {
    const { choose, dialog, contacts } = await opened((kit) => kit.fake.addCard({ uid: 'u-1', name: { full: 'P1' } }));
    choose(people(2), people(1, 2));
    fireEvent.click(await dialog().findByRole('button', { name: 'Import 2' }));
    expect(await dialog().findByText('Imported 2 contacts.')).toBeInTheDocument();
    expect(dialog().getByText('Skipped 1 already in your contacts.')).toBeInTheDocument();
    expect(contacts.people()).toHaveLength(3);
    fireEvent.click(dialog().getByRole('button', { name: 'Done' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(contacts.importOpen()).toBe(false);
  });
  it('names a card the server would not save', async () => {
    const { choose, dialog } = await opened((kit) => kit.fake.rejectCardCreates.add('u-1'));
    choose(people(2));
    fireEvent.click(await dialog().findByRole('button', { name: 'Import 2' }));
    expect(await dialog().findByText('Imported 1 contact.')).toBeInTheDocument();
    expect(dialog().getByText('1 could not be saved:')).toBeInTheDocument();
    expect(dialog().getByText('P1: Invalid property.')).toBeInTheDocument();
  });
  it('warns when there are more contacts than the usual allowance', async () => {
    const { choose, dialog } = await opened();
    choose(people(1000));
    await dialog().findByRole('button', { name: 'Import 1,000' });
    expect(dialog().queryByText(/^This is more than the usual allowance/)).toBeNull();
    choose(people(1001));
    await dialog().findByRole('button', { name: 'Import 1,001' });
    expect(dialog().getByText("This is more than the usual allowance. The import will stop when the server's limit is reached; import the same files again later and the contacts already here are skipped.")).toBeInTheDocument();
  });
  it('stops after the batch on its way when asked, and says how many are left', async () => {
    const { choose, dialog, contacts } = await opened();
    choose(people(250));
    fireEvent.click(await dialog().findByRole('button', { name: 'Import 250' }));
    expect(await dialog().findByRole('progressbar')).toBeInTheDocument();
    expect(dialog().getByRole('status')).toHaveTextContent('Imported 0 of 250');
    fireEvent.click(dialog().getByRole('button', { name: 'Stop' }));
    expect(await dialog().findByText('Imported 100 contacts.')).toBeInTheDocument();
    expect(dialog().getByText('Stopped: 150 were not imported.')).toBeInTheDocument();
    expect(contacts.people()).toHaveLength(100);
  });
  it('says so when the server\'s upload limit is reached, and when to come back', async () => {
    const { choose, dialog } = await opened((kit) => { kit.fake.uploadsLeft = 3; });
    choose(people(5));
    fireEvent.click(await dialog().findByRole('button', { name: 'Import 5' }));
    expect(await dialog().findByText('Imported 3 contacts.')).toBeInTheDocument();
    expect(dialog().getByText("The server's upload limit was reached: 2 contacts were not imported.")).toBeInTheDocument();
    expect(dialog().getByText('You have exceeded the blob upload quota of 1000 files or 50000000 bytes.')).toBeInTheDocument();
    expect(dialog().getByText('You can import them in about 35 minutes: choose the same files again, and the contacts already here are skipped.')).toBeInTheDocument();
    expect(dialog().getByText('Until then you may not be able to attach files to a message.')).toBeInTheDocument();
  });
  it('says about an hour when the server gives no time', async () => {
    const { choose, dialog } = await opened((kit) => { kit.fake.uploadsLeft = 0; kit.fake.retryAfter = null; });
    choose(people(1));
    fireEvent.click(await dialog().findByRole('button', { name: 'Import 1' }));
    expect(await dialog().findByText(/^You can import it in about an hour: /)).toBeInTheDocument();
    expect(dialog().getByText("The server's upload limit was reached: 1 contact was not imported.")).toBeInTheDocument();
  });
  it('refuses files too large to read at once, and says when a file holds no contacts', async () => {
    const { input, choose, dialog } = await opened();
    const big = new File(['x'], 'big.vcf');
    Object.defineProperty(big, 'size', { value: 25 * 1024 * 1024 + 1 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await dialog().findByText('These files are too large to import at once (25 MB at most).')).toBeInTheDocument();
    choose('Name,Email\r\nAnn,ann@x.example\r\n');
    expect(await dialog().findByText('No contacts were found in these files.')).toBeInTheDocument();
    expect(dialog().queryByRole('button', { name: /^Import/ })).toBeNull();
  });
});

describe('export', () => {
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  async function page(path = '/contacts') {
    const kit = contactsKit();
    kit.fake.addCard({ uid: 'u-ann', name: { full: 'Ann' }, emails: { e: { address: 'ann@x.example' } } });
    kit.fake.addCard({ uid: 'u-bob', name: { full: 'Bob' } });
    const team = kit.fake.addCard({ kind: 'group', uid: 'g-team', name: { full: 'Team' }, members: { 'u-ann': true } });
    await kit.contacts.start('k');
    vi.mocked(downloadText).mockClear();
    kit.show(path.replace(':gid', team.id), () => (
      <>
        <Route path="/contacts" component={ContactsView} />
        <Route path="/contacts/group/:gid" component={ContactsView} />
      </>
    ));
    return kit;
  }
  const menu = async (item: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'More contact actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: item }));
  };
  const written = () => splitVcards(vi.mocked(downloadText).mock.calls[0]![2]).blocks.map(peekVcard).map((p) => p.name);

  it('downloads everyone and every group as one vCard file named for today', async () => {
    const { toast } = await page();
    await menu('Export all');
    expect(downloadText).toHaveBeenCalledWith(`contacts-${today()}.vcf`, 'text/vcard;charset=utf-8', expect.any(String));
    expect(written()).toEqual(['Ann', 'Bob', 'Team']);
    expect(toast).toHaveBeenCalledWith('Exported 2 contacts and 1 group.', 'info');
  });
  it('exports the group on screen with its card', async () => {
    await page('/contacts/group/:gid');
    await menu('Export this group');
    expect(written()).toEqual(['Ann', 'Team']);
  });
  it('exports the selected people', async () => {
    const { toast } = await page();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Bob' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(written()).toEqual(['Bob']);
    expect(toast).toHaveBeenCalledWith('Exported 1 contact.', 'info');
  });
  it('opens the import dialog from the menu and from the empty address book', async () => {
    const { contacts } = await page();
    await menu('Import…');
    expect(contacts.importOpen()).toBe(true);
    const empty = contactsKit();
    await empty.contacts.start('k');
    empty.show('/contacts', () => <Route path="/contacts" component={ContactsView} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Import…' }).at(-1)!);
    expect(empty.contacts.importOpen()).toBe(true);
  });
});
