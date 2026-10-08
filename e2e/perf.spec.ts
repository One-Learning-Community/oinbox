import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rows } from './support/app';
import { signInThroughStalwart } from './support/login';
import { accountId, jmap, sendMail } from './support/mail';

// Hand-run measurements against carol's large mailbox (deploy/README.md, "Large mailbox").
//   pnpm e2e:perf                 the full run, about 15 minutes
//   PERF_QUICK=1 pnpm e2e:perf    one minute of the heap test instead of ten
// Numbers land in test-results/perf.json. A miss is a finding to rate, not a build failure:
// thresholds are soft assertions and say what "feels fine" was taken to be.

const CAROL = 'carol@example.test';
const QUICK = !!process.env.PERF_QUICK;
const results: Record<string, { value: number; limit: number; unit: string }> = {};
const record = (name: string, value: number, limit: number, unit = 'ms') => {
  results[name] = { value: Math.round(value * 10) / 10, limit, unit };
  expect.soft(value, `${name} (${unit})`).toBeLessThanOrEqual(limit);
};

const firstRows = async (page: Page) => {
  const t = Date.now();
  await rows(page).first().waitFor({ timeout: 60_000 });
  return Date.now() - t;
};

/**
 * A long thread in carol's mailbox. The Enron corpus has almost no threading headers, so this is the
 * 55-message thread the audit added by hand ("The long gas thread"); any thread of the largest size
 * found among the matches will do.
 */
async function longestThread(): Promise<{ threadId: string; size: number }> {
  const account = await accountId(CAROL);
  const r = await jmap(
    [
      ['Email/query', { accountId: account, filter: { subject: 'long gas thread' }, limit: 100 }, 'q'],
      ['Email/get', { accountId: account, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['threadId'] }, 'g'],
    ],
    CAROL,
  );
  const counts = new Map<string, number>();
  for (const e of r.g.list as { threadId: string }[]) counts.set(e.threadId, (counts.get(e.threadId) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (!best) throw new Error('No long thread in carol\'s mailbox: deliver one, or import a corpus that has threads');
  return { threadId: best[0], size: best[1] };
}

test.afterAll(() => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/perf.json', JSON.stringify(results, null, 2));
  console.table(results);
});

test('@perf start, scroll and search in a large mailbox', async ({ page }) => {
  await signInThroughStalwart(page, CAROL);
  await firstRows(page);

  // Cold start: no snapshot in IndexedDB.
  await page.evaluate(async () => {
    for (const db of await indexedDB.databases()) await new Promise((done) => { const r = indexedDB.deleteDatabase(db.name!); r.onsuccess = r.onerror = r.onblocked = done; });
    localStorage.removeItem('oinbox.session');
  });
  // Timed from the navigation, so loading the app itself counts.
  let t = Date.now();
  await page.goto('/inbox');
  await firstRows(page);
  record('cold start to first rows', Date.now() - t, 3000);

  // Warm start: the snapshot is written a moment after the first sync.
  await page.waitForTimeout(5000);
  t = Date.now();
  await page.reload();
  await firstRows(page);
  record('warm start to first rows', Date.now() - t, 1000);

  // Scroll towards row 5000 (or the end), sampling frames and how long the list shows no rows.
  const scroll = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.list-scroll')!;
    const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 40;
    const target = Math.min(rowH * 5000, scroller.scrollHeight - scroller.clientHeight);
    const frames: number[] = [];
    let longestBlank = 0;
    let blankSince: number | null = null;
    let last = performance.now();
    await new Promise<void>((done) => {
      const tick = (now: number) => {
        frames.push(now - last);
        last = now;
        const blank = !scroller.querySelector('a.row[data-thread-id]');
        if (blank && blankSince === null) blankSince = now;
        if (!blank && blankSince !== null) {
          longestBlank = Math.max(longestBlank, now - blankSince);
          blankSince = null;
        }
        if (scroller.scrollTop < target - 1) {
          scroller.scrollTop = Math.min(target, scroller.scrollTop + rowH * 30);
          requestAnimationFrame(tick);
        } else setTimeout(done, 1500);
      };
      requestAnimationFrame(tick);
    });
    if (blankSince !== null) longestBlank = Math.max(longestBlank, performance.now() - blankSince);
    frames.sort((a, b) => a - b);
    return { p95: frames[Math.floor(frames.length * 0.95)] ?? 0, longestBlank, rowsScrolled: Math.round(target / rowH) };
  });
  console.log(`scrolled ${scroll.rowsScrolled} rows`);
  record('scroll: longest time with no rows', scroll.longestBlank, 500);
  record('scroll: 95th percentile frame', scroll.p95, 32);

  // A jump, as when the scrollbar is dragged: straight to row 20000, then how long until rows show.
  const jump = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.list-scroll')!;
    const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 40;
    scroller.scrollTop = Math.min(rowH * 20000, scroller.scrollHeight - scroller.clientHeight);
    const t0 = performance.now();
    while (performance.now() - t0 < 30_000) {
      await new Promise((r) => requestAnimationFrame(r));
      const top = scroller.getBoundingClientRect().top;
      const shown = [...scroller.querySelectorAll<HTMLElement>('a.row[data-thread-id]')].some((el) => el.getBoundingClientRect().top >= top);
      if (shown) break;
    }
    return performance.now() - t0;
  });
  record('jump to a far row: time to rows', jump, 1000);

  // Search.
  await page.goto('/inbox');
  await firstRows(page);
  const search = page.getByRole('searchbox', { name: 'Search mail' });
  await search.fill('meeting');
  const t0 = Date.now();
  await search.press('Enter');
  await page.waitForURL(/\/search\//);
  await rows(page).first().waitFor({ timeout: 30_000 });
  record('search to first results', Date.now() - t0, 2000);

  record('browser storage used', await page.evaluate(() => navigator.storage.estimate().then((e) => (e.usage ?? 0) / 1e6)), 20, 'MB');
});

test('@perf a long thread opens quickly', async ({ page }) => {
  const { threadId, size } = await longestThread();
  console.log(`longest thread has ${size} messages`);
  await signInThroughStalwart(page, CAROL);
  await rows(page).first().waitFor();
  const t0 = Date.now();
  await page.goto(`/inbox/t/${threadId}`);
  await page.locator('article.msg').last().waitFor();
  await expect(page.locator('article.msg:not(.collapsed)').last()).toBeVisible();
  record(`open a ${size}-message thread`, Date.now() - t0, 1500);
});

test('@perf the heap stays flat while mail arrives', async ({ page, context }) => {
  await signInThroughStalwart(page, CAROL);
  await firstRows(page);
  const cdp = await context.newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize;
  };
  await page.waitForTimeout(QUICK ? 10_000 : 60_000);
  const start = await heap();
  const pushes = QUICK ? 6 : 54;
  for (let i = 0; i < pushes; i++) {
    await sendMail({ from: 'Perf Push <perf@partner.test>', to: [CAROL], subject: `perf push ${Date.now()}`, text: 'x' });
    await page.waitForTimeout(10_000);
  }
  record(`heap growth over ${QUICK ? 1 : 9} minutes of pushes`, ((await heap()) / start - 1) * 100, 20, '%');
});
