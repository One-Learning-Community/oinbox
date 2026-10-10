import { beforeEach, describe, expect, it } from 'vitest';
import { createLinkFolders, KEEP_MS, mentions, type LinkFolder } from './linkFolders';

const T0 = 1_800_000_000_000;
const folder = (n: number, madeAt = T0): LinkFolder => ({ url: `https://files.test/s/${n}?a=1&b=2`, path: ['Mail attachments', `m${n}`], id: `id-${n}`, madeAt });

describe('createLinkFolders', () => {
  beforeEach(() => localStorage.clear());

  it('finds the folder whose link a text has in it, as written or as HTML has it', () => {
    const folders = createLinkFolders(localStorage, () => T0);
    folders.remember(folder(1));
    folders.remember(folder(2));
    expect(folders.findIn('<p>see https://files.test/s/2?a=1&b=2</p>')).toEqual(folder(2));
    expect(folders.findIn('<a href="https://files.test/s/1?a=1&amp;b=2">here</a>')).toEqual(folder(1));
    expect(folders.findIn('<p>nothing</p>')).toBeNull();
    expect(mentions('https://files.test/s/1', 'https://files.test/s/2')).toBe(false);
  });

  it('is kept between visits, and forgets what it is told to', () => {
    createLinkFolders(localStorage, () => T0).remember(folder(1));
    const later = createLinkFolders(localStorage, () => T0 + 1000);
    expect(later.findIn(folder(1).url)).toEqual(folder(1));
    later.forget(folder(1).url);
    expect(later.findIn(folder(1).url)).toBeNull();
    later.remember(folder(2));
    later.clear();
    expect(later.findIn(folder(2).url)).toBeNull();
  });

  it('forgets a folder after ninety days, and keeps only the newest hundred', () => {
    let now = T0;
    const folders = createLinkFolders(localStorage, () => now);
    folders.remember(folder(0));
    now = T0 + KEEP_MS;
    expect(folders.findIn(folder(0).url)).toBeNull();
    for (let n = 1; n <= 101; n++) folders.remember(folder(n, now));
    expect(folders.findIn(`${folder(1).url}"`)).toBeNull();
    expect(folders.findIn(`${folder(101).url}"`)).not.toBeNull();
  });

  it('makes nothing of storage that holds something else', () => {
    localStorage.setItem('oinbox.drive.linkFolders', '{"not":"a list"}');
    expect(createLinkFolders(localStorage, () => T0).findIn('anything')).toBeNull();
    localStorage.setItem('oinbox.drive.linkFolders', JSON.stringify([{ url: 'https://x.test/s/1', path: 'p', id: 'i', madeAt: T0 }]));
    expect(createLinkFolders(localStorage, () => T0).findIn('https://x.test/s/1')).toBeNull();
  });
});
