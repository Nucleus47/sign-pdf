import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  define: { __APP_COMMIT__: JSON.stringify('test') },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/testing/setup.ts'],
    restoreMocks: true,
  },
});
