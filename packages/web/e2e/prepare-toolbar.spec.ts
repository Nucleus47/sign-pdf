import { expect, test } from '@playwright/test';
import { openSample } from './helpers.ts';

const TYPES = ['text', 'date', 'checkbox', 'signature', 'initials'] as const;

// #80: on a phone the field types stay in one row and scroll sideways, and the page itself never scrolls sideways.
test('phone: the field types sit in one row that scrolls inside the toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSample(page);

  const tops: number[] = [];
  for (const type of TYPES) {
    const box = await page.getByTestId(`place-${type}`).boundingBox();
    if (!box) throw new Error(`place-${type} has no box`);
    tops.push(Math.round(box.y));
  }
  const help = await page.getByTestId('show-shortcuts').boundingBox();
  if (!help) throw new Error('show-shortcuts has no box');
  tops.push(Math.round(help.y));
  expect(new Set(tops).size, 'one row').toBe(1);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'no sideways page scroll').toBeLessThanOrEqual(0);

  // The last control can be reached and used.
  await page.getByTestId('place-initials').click();
  await expect(page.getByTestId('place-initials')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('place-initials')).toBeInViewport();
});
