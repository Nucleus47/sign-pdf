import { spawn } from 'node:child_process';

export type BrowserOpener = (url: string) => void | Promise<void>;

/**
 * Open a URL in the user's default browser. Refuses when `SIGN_PDF_NO_OPEN` is
 * set (test runs set it), so a caller never reports a browser that was not
 * opened. Failures reject; the caller decides what the human is told.
 *
 * The URL is one argument of the launcher process, so other programs of the
 * same user can read it for a moment. The signing link is built for that: its
 * nonce works once, and a page that finds it already used says so.
 */
export const openInDefaultBrowser: BrowserOpener = (url) => {
  if (process.env['SIGN_PDF_NO_OPEN']) return Promise.reject(new Error('Opening a browser is disabled (SIGN_PDF_NO_OPEN).'));
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise<void>((resolve, reject) => {
    // No shell: the URL is passed as one argument and never interpreted.
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
};
