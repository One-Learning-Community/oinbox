import { test as setup } from '@playwright/test';
import { signInThroughStalwart } from './support/login';

// Signs alice in once through the real OAuth flow; the other specs reuse her tokens.
setup('sign in as alice', async ({ page }) => {
  await signInThroughStalwart(page);
  await page.locator('a.row[data-thread-id]').first().waitFor();
  await page.context().storageState({ path: 'e2e/.auth/alice.json' });
});
