import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

// The relay round trip (e2e/relay-worker.spec.ts) against a running relay
// Worker that serves the built app: RELAY_E2E_URL names it, and no preview
// server is started. One worker: the relay limits sign-ins per IP.
export default defineConfig({
  ...base,
  testMatch: 'relay-worker.spec.ts',
  workers: 1,
  outputDir: 'test-results/relay',
  use: { ...base.use, baseURL: process.env.RELAY_E2E_URL ?? 'http://127.0.0.1:8787' },
  webServer: undefined,
});
