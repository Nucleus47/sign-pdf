import { describe, expect, it } from 'vitest';
import { nodeVersionError, nodeVersionHint } from './node-version.ts';

describe('node version check', () => {
  it('accepts the supported runtime', () => {
    expect(nodeVersionError('v22.0.0')).toBeUndefined();
    expect(nodeVersionError('v26.3.0')).toBeUndefined();
  });

  it('returns a short error and actionable hint for an old or invalid runtime', () => {
    expect(nodeVersionError('v20.19.0')).toBe('sign-pdf requires Node.js 22 or later; found v20.19.0.');
    expect(nodeVersionError('not-a-version')).toContain('requires Node.js 22 or later');
    expect(nodeVersionHint()).toContain('Install Node.js 22 or later');
  });
});
