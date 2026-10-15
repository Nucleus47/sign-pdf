import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    // No test may open a real browser, even if it forgets to pass an opener.
    env: { SIGN_PDF_NO_OPEN: '1' },
  },
});
