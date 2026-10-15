import { describe, expect, it } from 'vitest';
import { probeFeatures, requiredMissing, type ProbeScope } from './browserSupport.ts';

function modernScope(): ProbeScope {
  class Stream {}
  (Stream.prototype as unknown as Record<PropertyKey, unknown>)[Symbol.asyncIterator] = () => undefined;
  class FakeMap {}
  (FakeMap.prototype as unknown as Record<string, unknown>).getOrInsertComputed = () => undefined;
  return {
    ReadableStream: Stream,
    Map: FakeMap,
    DecompressionStream: class {},
    OffscreenCanvas: class {},
    WebAssembly: {},
    structuredClone: () => undefined,
    crypto: { subtle: {} },
    navigator: { clipboard: { writeText: () => undefined } },
  };
}

describe('browser support', () => {
  it('finds every feature in a modern browser', () => {
    const features = probeFeatures(modernScope());
    expect(Object.values(features).every(Boolean)).toBe(true);
    expect(requiredMissing(features)).toEqual([]);
  });

  it('reports a missing feature that is shimmed, but does not call it required', () => {
    const scope = modernScope();
    scope.ReadableStream = class {};
    scope.Map = class {};
    const features = probeFeatures(scope);
    expect(features['ReadableStream async iteration']).toBe(false);
    expect(features['Map.prototype.getOrInsertComputed']).toBe(false);
    expect(requiredMissing(features)).toEqual([]);
  });

  it('lists required features that nothing supplies', () => {
    const scope = modernScope();
    delete scope.structuredClone;
    scope.crypto = {};
    delete scope.navigator;
    delete scope.WebAssembly;
    const features = probeFeatures(scope);
    expect(features['navigator.clipboard']).toBe(false);
    expect(requiredMissing(features)).toEqual(['structuredClone', 'crypto.subtle']);
  });

  it('treats a probe that throws as missing', () => {
    const scope = modernScope();
    Object.defineProperty(scope, 'crypto', {
      get() {
        throw new Error('blocked');
      },
    });
    expect(probeFeatures(scope)['crypto.subtle']).toBe(false);
  });
});
