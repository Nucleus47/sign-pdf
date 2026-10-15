/**
 * A tab left open across a release asks for code files the new release no
 * longer has. The page then reloads once to pick up the new release. A tab
 * that holds a loopback session never reloads by itself: a reload cannot
 * resume the session.
 */
const RELOAD_KEY = 'sign-pdf:reloaded-for-release';
const RELOAD_WINDOW_MS = 10_000;

let allowed = true;

/** Called once at start-up: false while this tab holds a loopback session. */
export function allowReloadForRelease(allow: boolean): void {
  allowed = allow;
}

function storage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Reloads the page, at most once in a short window. True when a reload started. */
export function reloadForNewRelease(): boolean {
  if (!allowed || typeof window === 'undefined') return false;
  const tab = storage();
  const last = Number(tab?.getItem(RELOAD_KEY) ?? 0);
  if (Date.now() - last < RELOAD_WINDOW_MS) return false;
  try {
    tab?.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Without tab storage there is no guard against a reload loop: do not reload.
    return false;
  }
  window.location.reload();
  return true;
}

/**
 * The messages browsers give when a code file could not be fetched (Chrome,
 * Safari, Firefox). Other failures, such as a module that throws, never reload:
 * a reload would lose the signer's work for nothing.
 */
const MISSING_CODE = /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

export function isMissingCode(error: unknown): boolean {
  return error instanceof Error && MISSING_CODE.test(error.message);
}

/** Loads a code file on demand; if it is gone, reloads for the new release. */
export async function loadCode<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    // The page is reloading: never settle, so nothing reports the old failure.
    if (isMissingCode(error) && reloadForNewRelease()) return new Promise<T>(() => undefined);
    throw error;
  }
}
