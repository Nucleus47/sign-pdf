import { defineConfig, devices } from '@playwright/test';
import { derivedPort } from './ports.ts';

// The preview server gets its own port, derived from this checkout's path.
// reuseExistingServer is off: a server we did not start is never trusted.
const port = derivedPort(1);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // CI can run on a shared machine: the default (half the cores) would oversubscribe it.
  workers: process.env.CI ? 2 : undefined,
  // In CI the HTML report is kept so a failed run can be read from its uploaded artifact.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : [['list']],
  outputDir: 'test-results',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
