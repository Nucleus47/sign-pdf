/** Shown above the app when this browser lacks a feature the app cannot work without. */
import type { FeatureName } from '../lib/browserSupport.ts';

export const OUT_OF_DATE_TEXT = 'This browser is out of date. Update it, then open this page again.';
export const NOT_SECURE_TEXT = 'You must open this page at an https address. On this address, the browser turns off features that signing needs.';

/** Features a browser keeps from pages that are not on https or localhost. */
const SECURE_ONLY: readonly FeatureName[] = ['crypto.subtle', 'navigator.clipboard'];

export interface BrowserBannerProps {
  missing: readonly FeatureName[];
  /** False on plain http (not localhost): the browser then hides some features on purpose. */
  secure: boolean;
}

export function BrowserBanner({ missing, secure }: BrowserBannerProps) {
  const outOfDate = secure ? missing : missing.filter((name) => !SECURE_ONLY.includes(name));
  if (secure && outOfDate.length === 0) return null;
  return (
    <div className="browser-banner" role="alert" data-testid="browser-banner">
      {!secure && (
        <p>
          <strong>{NOT_SECURE_TEXT}</strong>
        </p>
      )}
      {outOfDate.length > 0 && (
        <>
          <p>
            <strong>{OUT_OF_DATE_TEXT}</strong>
          </p>
          <p className="browser-banner-missing">Missing: {outOfDate.join(', ')}.</p>
        </>
      )}
    </div>
  );
}
