/**
 * Cloudflare Turnstile, the check in front of the relay's sign-in email. The
 * script is the one third-party resource the app can load, and it is loaded
 * only when the person opens the email sign-in step (ARCHITECTURE.md, "No
 * network by default"). The CSP allows it in `script-src` and `frame-src`.
 */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const TURNSTILE_SCRIPT_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;

/**
 * The token the page sends when the relay has no Turnstile site key (local
 * runs with TURNSTILE_MODE=off): the login body needs a non-empty token, and
 * the relay does not check it in that mode.
 */
export const NO_TURNSTILE_TOKEN = 'none';

export interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'flexible' | 'compact';
}

export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | undefined;

/** Load the Turnstile script once. A failed load can be tried again. */
export function loadTurnstile(doc: Document = document): Promise<TurnstileApi> {
  const ready = doc.defaultView?.turnstile;
  if (ready) return Promise.resolve(ready);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.onload = () => {
      const api = doc.defaultView?.turnstile;
      if (api) resolve(api);
      else reject(new Error('Turnstile did not start.'));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Turnstile could not be loaded.'));
    };
    doc.head.append(script);
  }).catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
