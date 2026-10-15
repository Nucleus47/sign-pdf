import { describe, expect, it } from 'vitest';
import { installLegacyPolyfills } from './legacyPolyfills.ts';

// The TypeScript lib is held to the browser target (tsconfig.json), so these features have no types.
type WithResolvers = { withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } };
type Transferable = { transferToFixedLength(length?: number): ArrayBuffer };

/** Promise and ArrayBuffer as Safari 16.4 has them: no withResolvers, no transferToFixedLength. */
function olderScope() {
  class OldPromise<T> extends Promise<T> {}
  Object.defineProperty(OldPromise, 'withResolvers', { value: undefined, configurable: true, writable: true });
  class OldArrayBuffer extends ArrayBuffer {}
  Object.defineProperty(OldArrayBuffer.prototype, 'transferToFixedLength', { value: undefined, configurable: true, writable: true });
  return { Promise: OldPromise as unknown as PromiseConstructor, ArrayBuffer: OldArrayBuffer as unknown as ArrayBufferConstructor };
}

describe('installLegacyPolyfills', () => {
  it('adds Promise.withResolvers', async () => {
    const scope = olderScope();
    installLegacyPolyfills(scope);
    const promise = scope.Promise as unknown as WithResolvers;
    const resolved = promise.withResolvers<number>();
    resolved.resolve(7);
    await expect(resolved.promise).resolves.toBe(7);
    const rejected = promise.withResolvers<number>();
    rejected.reject(new Error('no'));
    await expect(rejected.promise).rejects.toThrow('no');
  });

  it('adds ArrayBuffer.prototype.transferToFixedLength, shorter and longer', () => {
    const scope = olderScope();
    installLegacyPolyfills(scope);
    const source = new scope.ArrayBuffer(4);
    new Uint8Array(source).set([1, 2, 3, 4]);
    const transferable = source as unknown as Transferable;
    expect([...new Uint8Array(transferable.transferToFixedLength(2))]).toEqual([1, 2]);
    expect([...new Uint8Array(transferable.transferToFixedLength(6))]).toEqual([1, 2, 3, 4, 0, 0]);
    expect(transferable.transferToFixedLength().byteLength).toBe(4);
  });

  it('leaves native implementations alone', () => {
    const promise = Promise as unknown as Record<string, unknown>;
    const buffer = ArrayBuffer.prototype as unknown as Record<string, unknown>;
    const nativeWithResolvers = promise.withResolvers;
    const nativeTransfer = buffer.transferToFixedLength;
    expect(typeof nativeWithResolvers).toBe('function');
    installLegacyPolyfills();
    expect(promise.withResolvers).toBe(nativeWithResolvers);
    expect(buffer.transferToFixedLength).toBe(nativeTransfer);
  });
});
