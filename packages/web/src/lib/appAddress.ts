/**
 * Where a person opens the web app, to print in a hand-off PDF and to tell
 * the signer where the next signer opens the file. Pure; no DOM.
 *
 * A build can name it with VITE_PUBLIC_APP_URL (for a self-hosted copy).
 * Otherwise it is the address this page was loaded from, unless that is this
 * computer only (the local app's loopback address): another device cannot
 * open that, so there is no address to give.
 */
const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

export interface AppAddress {
  /** The full address, for the stamp in the PDF: printable ASCII. */
  url: string;
  /** The address without the scheme, for a sentence: "sign.example.org". */
  shown: string;
}

export function appAddress(configured: string | undefined, location: Pick<Location, 'hostname' | 'origin'>): AppAddress | null {
  const fromBuild = configured?.trim();
  const url = fromBuild ? fromBuild : LOOPBACK_HOST.test(location.hostname) ? '' : location.origin;
  // Only a web address another device can open: not file://, not an opaque
  // origin ("null"). The stamp is printable ASCII; an address that is not is left out.
  if (!/^https?:\/\/[^/\s]/i.test(url) || !/^[\x20-\x7e]+$/.test(url)) return null;
  return { url, shown: url.replace(/^https?:\/\//i, '').replace(/\/$/, '') };
}

/** The address for this page. */
export function currentAppAddress(): AppAddress | null {
  const configured = (import.meta.env as Record<string, string | undefined>).VITE_PUBLIC_APP_URL;
  return typeof window === 'undefined' ? null : appAddress(configured, window.location);
}
