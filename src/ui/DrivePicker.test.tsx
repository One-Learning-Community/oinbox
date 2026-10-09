import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type App } from '../app/context';
import { createDrive } from '../app/drive';
import { FakeDrive } from '../drive/fake';
import { DrivePicker } from './DrivePicker';

const blob = (text: string) => new Blob([text], { type: 'text/plain' });

function setup(arrange: (server: FakeDrive) => void = () => {}, files = 1) {
  const server = new FakeDrive();
  arrange(server);
  const toast = vi.fn();
  const drive = createDrive({ client: server.client(), toast });
  drive.setConfig({ enabled: true, linkOverMb: 20 });
  render(() => (
    <AppContext.Provider value={{ drive } as unknown as App}>
      <DrivePicker />
    </AppContext.Provider>
  ));
  const open = () => drive.saveToDrive(Array.from({ length: files }, (_, i) => ({ name: `file-${i + 1}.txt`, fetch: async () => blob('data') })));
  const deliver = vi.fn<(files: File[]) => void>();
  const pick = () => drive.attachFromDrive(deliver);
  return { server, drive, toast, open, pick, deliver };
}

const folderRow = (name: string) => screen.findByRole('button', { name: `Open ${name}` });
/** The folder on screen, by the breadcrumb's last entry. (The list itself is absent while a folder is empty.) */
const showsFolder = (name: string) =>
  waitFor(() => expect(screen.getByRole('navigation', { name: 'Folder path' }).querySelector('[aria-current]')).toHaveTextContent(name));

describe('DrivePicker', () => {
  it('shows nothing until there is something to save', () => {
    setup();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists folders first, then files that cannot be chosen', async () => {
    const { open } = setup((s) => {
      s.put(['zeta.txt'], blob('z'));
      s.mkdir(['Reports']);
      s.mkdir(['Archive']);
    });
    open();
    expect(await screen.findByRole('heading', { name: 'Save to Drive' })).toBeInTheDocument();
    await folderRow('Archive');
    // The drive's name arrives a moment after the first listing.
    const rows = within(await screen.findByRole('list', { name: 'Alice Example' })).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Archive', 'Reports', expect.stringContaining('zeta.txt')]);
    expect(within(rows[2]!).queryByRole('button')).toBeNull();
  });

  it('counts the files in its title when there are several', async () => {
    const { open } = setup(() => {}, 3);
    open();
    expect(await screen.findByRole('heading', { name: 'Save 3 files to Drive' })).toBeInTheDocument();
  });

  it('says so when a folder is empty', async () => {
    const { open } = setup();
    open();
    expect(await screen.findByText('This folder is empty.')).toBeInTheDocument();
  });

  it('opens a folder and goes back by the breadcrumb', async () => {
    const { open } = setup((s) => {
      s.mkdir(['Reports', '2026']);
    });
    open();
    fireEvent.click(await folderRow('Reports'));
    await folderRow('2026');
    expect(screen.getByRole('list', { name: 'Reports' })).toBeInTheDocument();
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'Folder path' })).findByRole('button', { name: 'Alice Example' }));
    await folderRow('Reports');
  });

  it('saves into the folder on screen and closes', async () => {
    const { server, toast, open } = setup((s) => {
      s.mkdir(['Reports']);
    });
    open();
    fireEvent.click(await folderRow('Reports'));
    await screen.findByText('This folder is empty.');
    fireEvent.click(screen.getByRole('button', { name: 'Save here' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.names(['Reports'])).toEqual(['file-1.txt']);
    expect(toast).toHaveBeenCalledWith('Saved to Drive: Reports', 'success');
  });

  it('saves once however often Save here is pressed', async () => {
    const { server, open } = setup();
    open();
    await screen.findByText('This folder is empty.');
    const save = screen.getByRole('button', { name: 'Save here' });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.names([])).toEqual(['file-1.txt']);
  });

  it('creates a folder and opens it', async () => {
    const { server, open } = setup();
    open();
    await screen.findByText('This folder is empty.');
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    const field = screen.getByLabelText('Folder name');
    fireEvent.input(field, { target: { value: 'Invoices' } });
    fireEvent.submit(field.closest('form')!);
    await showsFolder('Invoices');
    expect(await screen.findByText('This folder is empty.')).toBeInTheDocument();
    expect(server.names([])).toEqual(['Invoices']);
  });

  it('refuses a folder name that is empty, has a slash, or is already there', async () => {
    const { server, open } = setup((s) => {
      s.mkdir(['Reports']);
    });
    open();
    await folderRow('Reports');
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    const field = screen.getByLabelText('Folder name');
    const submit = (value: string) => {
      fireEvent.input(field, { target: { value } });
      fireEvent.submit(field.closest('form')!);
    };
    submit('  ');
    expect(await screen.findByText('Give the folder a name.')).toBeInTheDocument();
    submit('a/b');
    expect(await screen.findByText("A folder name can't contain a slash.")).toBeInTheDocument();
    submit('reports');
    expect(await screen.findByText('A folder or file with that name is already here.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(server.names([])).toEqual(['Reports']);
  });

  it('shows why a listing failed and tries again', async () => {
    const { server, open } = setup((s) => {
      s.mkdir(['Reports']);
      s.down = true;
    });
    open();
    expect(await screen.findByText("Drive isn't available right now.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save here' })).toBeDisabled();
    server.down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await folderRow('Reports');
    expect(screen.getByRole('button', { name: 'Save here' })).toBeEnabled();
  });

  it('opens where the last save went, and at the top if that folder has gone', async () => {
    const { server, drive, open } = setup((s) => {
      s.mkdir(['Reports']);
    });
    open();
    fireEvent.click(await folderRow('Reports'));
    await screen.findByText('This folder is empty.');
    fireEvent.click(screen.getByRole('button', { name: 'Save here' }));
    await waitFor(() => expect(drive.request()).toBeNull());
    open();
    await showsFolder('Reports');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    server.remove(['Reports']);
    open();
    await showsFolder('Alice Example');
    expect(await screen.findByText('This folder is empty.')).toBeInTheDocument();
  });

  it('moves between folders with the arrow keys and goes up with Backspace', async () => {
    const { open } = setup((s) => {
      s.mkdir(['Archive']);
      s.mkdir(['Reports', '2026']);
    });
    open();
    const archive = await folderRow('Archive');
    const reports = await folderRow('Reports');
    archive.focus();
    fireEvent.keyDown(archive, { key: 'ArrowDown' });
    expect(reports).toHaveFocus();
    fireEvent.keyDown(reports, { key: 'ArrowDown' });
    expect(archive).toHaveFocus();
    fireEvent.keyDown(archive, { key: 'End' });
    expect(reports).toHaveFocus();
    fireEvent.click(reports);
    const inner = await folderRow('2026');
    fireEvent.keyDown(inner, { key: 'Backspace' });
    await folderRow('Archive');
  });

  it('keeps the keyboard in the list after opening a folder and after going up', async () => {
    const { open } = setup((s) => {
      s.mkdir(['Archive']);
      s.mkdir(['Reports', '2026']);
    });
    open();
    fireEvent.click(await folderRow('Reports'));
    const inner = await folderRow('2026');
    await waitFor(() => expect(inner).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'Backspace' });
    const archive = await folderRow('Archive');
    await waitFor(() => expect(archive).toHaveFocus());
  });

  it('goes up with Backspace from a folder with nothing to focus in it', async () => {
    const { open } = setup((s) => {
      s.mkdir(['Empty']);
    });
    open();
    fireEvent.click(await folderRow('Empty'));
    await screen.findByText('This folder is empty.');
    await waitFor(() => expect(document.activeElement).toHaveClass('drive-list'));
    fireEvent.keyDown(document.activeElement!, { key: 'Backspace' });
    await folderRow('Empty');
  });

  it('closes on Cancel without saving', async () => {
    const { server, drive, open } = setup();
    open();
    await screen.findByText('This folder is empty.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(drive.request()).toBeNull();
    expect(server.names([])).toEqual([]);
  });
});

describe('DrivePicker, choosing files', () => {
  const arrange = (s: FakeDrive) => {
    s.mkdir(['Reports']);
    s.put(['Reports', 'q3.pdf'], blob('pdf!'));
    s.put(['budget.csv'], blob('1,2'));
    s.put(['notes.txt'], blob('hello'));
  };
  const box = (name: RegExp) => screen.findByRole('checkbox', { name });

  it('offers files as checkboxes, with Attach and no New folder', async () => {
    const { pick } = setup(arrange);
    pick();
    expect(await screen.findByRole('heading', { name: 'Attach from Drive' })).toBeInTheDocument();
    expect(await box(/budget\.csv/)).not.toBeChecked();
    expect(await folderRow('Reports')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save here' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
  });

  it('counts the ticked files on its button', async () => {
    const { pick } = setup(arrange);
    pick();
    fireEvent.click(await box(/budget\.csv/));
    expect(screen.getByRole('button', { name: 'Attach' })).toBeEnabled();
    fireEvent.click(await box(/notes\.txt/));
    expect(screen.getByRole('button', { name: 'Attach 2 files' })).toBeEnabled();
    fireEvent.click(await box(/notes\.txt/));
    expect(screen.getByRole('button', { name: 'Attach' })).toBeEnabled();
  });

  it('hands over the ticked files and closes', async () => {
    const { pick, deliver } = setup(arrange);
    pick();
    fireEvent.click(await box(/budget\.csv/));
    fireEvent.click(await box(/notes\.txt/));
    fireEvent.click(screen.getByRole('button', { name: 'Attach 2 files' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deliver.mock.calls[0]![0].map((f) => f.name)).toEqual(['budget.csv', 'notes.txt']);
  });

  it('attaches a file from inside a folder', async () => {
    const { pick, deliver } = setup(arrange);
    pick();
    fireEvent.click(await folderRow('Reports'));
    fireEvent.click(await box(/q3\.pdf/));
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    expect(deliver.mock.calls[0]![0].map((f) => `${f.name}:${f.size}`)).toEqual(['q3.pdf:4']);
  });

  it('forgets the ticks when another folder is opened', async () => {
    const { pick, deliver } = setup(arrange);
    pick();
    fireEvent.click(await box(/budget\.csv/));
    fireEvent.click(await folderRow('Reports'));
    await box(/q3\.pdf/);
    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Folder path' })).getByRole('button'));
    expect(await box(/budget\.csv/)).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('hands the files over once however often Attach is pressed', async () => {
    const { pick, deliver } = setup(arrange);
    pick();
    fireEvent.click(await box(/notes\.txt/));
    const attach = screen.getByRole('button', { name: 'Attach' });
    fireEvent.click(attach);
    fireEvent.click(attach);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('stays open with a message when a ticked file has gone', async () => {
    const { server, toast, pick, deliver } = setup(arrange);
    pick();
    fireEvent.click(await box(/notes\.txt/));
    server.remove(['notes.txt']);
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('That file is no longer in Drive.', 'error'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(deliver).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeEnabled();
  });

  it('moves through folders and files with the arrow keys', async () => {
    const { pick } = setup(arrange);
    pick();
    const reports = await folderRow('Reports');
    const budget = await box(/budget\.csv/);
    const notes = await box(/notes\.txt/);
    await waitFor(() => expect(reports).toHaveFocus());
    fireEvent.keyDown(reports, { key: 'ArrowDown' });
    expect(budget).toHaveFocus();
    fireEvent.keyDown(budget, { key: 'End' });
    expect(notes).toHaveFocus();
    fireEvent.keyDown(notes, { key: 'ArrowDown' });
    expect(reports).toHaveFocus();
  });
});
