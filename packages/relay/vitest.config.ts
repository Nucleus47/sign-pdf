import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with the bindings from wrangler.jsonc (emulated R2,
// rate limiters and send_email). The overrides keep every test off the network.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          RELAY_MODE: 'on',
          TURNSTILE_MODE: 'off',
          MAIL_TRANSPORT: 'dev-outbox',
          PUBLIC_ORIGIN: 'http://127.0.0.1:8787',
          RELAY_SESSION_SECRET: 'test-only-session-secret-0123456789abcdef',
          TURNSTILE_SECRET: 'test-only-turnstile-secret',
        },
      },
    }),
  ],
});
