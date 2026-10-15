/** The browser-side values of an error report: read from the page, never from the document. */
import { startupFeatures } from './browserSupport.ts';
import type { Failure, FileFacts, ReportContext } from './errorReport.ts';

function attribute(selector: string, name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.querySelector(selector)?.getAttribute(name) ?? undefined;
}

export function reportContext(file: FileFacts | undefined, uncaught: Failure | null, at: Date = new Date()): ReportContext {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const win = typeof window === 'undefined' ? undefined : window;
  const pass = attribute('[data-pass]', 'data-pass');
  return {
    version: typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'unknown',
    userAgent: nav?.userAgent ?? '',
    platform: nav?.platform ?? '',
    viewport: win ? `${win.innerWidth}x${win.innerHeight}` : '',
    devicePixelRatio: win?.devicePixelRatio ?? 0,
    features: startupFeatures,
    time: at.toISOString(),
    view: attribute('[data-testid="app-root"]', 'data-view'),
    state: attribute('[data-testid="app-root"]', 'data-state'),
    step: attribute('[data-testid="guide-step"]', 'data-step'),
    ...(pass === undefined ? {} : { pass }),
    file,
    uncaught: uncaught ?? undefined,
  };
}
