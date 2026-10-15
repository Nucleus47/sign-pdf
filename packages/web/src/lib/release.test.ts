import { describe, expect, it, vi } from 'vitest';
import { isMissingCode, loadCode } from './release.ts';

describe('reload for a new release', () => {
  it('knows the browsers’ messages for a code file that could not be fetched', () => {
    expect(isMissingCode(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js'))).toBe(true);
    expect(isMissingCode(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isMissingCode(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isMissingCode(new TypeError('undefined is not a function'))).toBe(false);
    expect(isMissingCode('Failed to fetch dynamically imported module')).toBe(false);
  });

  it('never reloads for another failure: it is reported as it is', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    try {
      await expect(loadCode(() => Promise.reject(new Error('the module threw')))).rejects.toThrow('the module threw');
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
