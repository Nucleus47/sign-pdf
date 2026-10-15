import { expect, test } from '@playwright/test';

// A tab open across a release asks for a code file the new release no longer has.
test('a missing code file after a release reloads the page once', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('load-sample')).toBeVisible();
  let refused = 0;
  await page.route(/\/assets\/pdf-[^/]*\.js$/, (route) => {
    refused += 1;
    return route.fulfill({ status: 404, body: 'gone' });
  });
  const reloaded = page.waitForEvent('load');
  await page.getByTestId('load-sample').click();
  await reloaded;
  expect(refused).toBeGreaterThan(0);
  // After the reload the files are there again, and the page works.
  await page.unroute(/\/assets\/pdf-[^/]*\.js$/);
  await expect(page.getByTestId('load-sample')).toBeVisible();
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-view', 'prepare');
});
