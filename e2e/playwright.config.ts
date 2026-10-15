import { defineConfig, devices } from '@playwright/test';

// Integration tests: the built command-line tool (and the MCP server) serve the
// built web app, and a real browser signs. Run them with `pnpm test:integration`,
// which builds both first. There is no shared web server: every test starts its
// own loopback server on a random free port and stops it.
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : [['list']],
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
