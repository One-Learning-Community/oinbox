import { expect, type Page } from '@playwright/test';

export const threadList = (page: Page) => page.locator('[role=list]');
export const rows = (page: Page) => threadList(page).locator('a.row[data-thread-id]');
export const rowFor = (page: Page, threadId: string) => threadList(page).locator(`a.row[data-thread-id="${threadId}"]`);

/**
 * Rows are virtualised and absolutely positioned; order them by their translateY
 * so "first" means visually topmost regardless of DOM order.
 */
export async function visibleThreadOrder(page: Page): Promise<string[]> {
  return rows(page).evaluateAll((els) =>
    els
      .map((el) => ({ id: el.getAttribute('data-thread-id')!, y: new DOMMatrixReadOnly(getComputedStyle(el).transform).m42 }))
      .sort((a, b) => a.y - b.y)
      .map((r) => r.id),
  );
}

export async function openInbox(page: Page) {
  await page.goto('/inbox');
  await expect(rows(page).first()).toBeVisible();
}

export async function waitLive(page: Page) {
  await expect(page.locator('.status-dot.online')).toBeVisible({ timeout: 15_000 });
}

/**
 * After arranging server state over JMAP, let the page's push stream deliver those changes
 * before interacting (Stalwart coalesces EventSource changes for up to 1 s), so they don't
 * re-render the view mid-test.
 */
export async function settleAfterArrange(page: Page, changed: boolean) {
  await waitLive(page);
  if (changed) await page.waitForTimeout(1500);
}
