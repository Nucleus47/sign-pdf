/**
 * Features the pdf.js legacy build calls without a polyfill of its own, which
 * Safari before 17.4 lacks: Promise.withResolvers (main thread and worker) and
 * ArrayBuffer.prototype.transferToFixedLength (worker, system font data).
 * The other new features it calls come with core-js inside pdf.js.
 * Imported first by the app and by the pdf.js worker. See docs/browser-support.md.
 */
type Scope = { Promise?: PromiseConstructor; ArrayBuffer?: ArrayBufferConstructor };
type WithResolvers = <T>() => { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void };

export function installLegacyPolyfills(scope: Scope = globalThis): void {
  const promise = scope.Promise as (PromiseConstructor & { withResolvers?: WithResolvers }) | undefined;
  if (promise && typeof promise.withResolvers !== 'function') {
    const withResolvers: WithResolvers = function <T>(this: PromiseConstructor) {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const created = new this<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise: created, resolve, reject };
    };
    Object.defineProperty(promise, 'withResolvers', { value: withResolvers, writable: true, configurable: true });
  }

  const buffer = scope.ArrayBuffer?.prototype as (ArrayBuffer & { transferToFixedLength?: unknown }) | undefined;
  if (buffer && typeof buffer.transferToFixedLength !== 'function') {
    // A copy, not a transfer: the source stays attached. pdf.js does not use the source again.
    function transferToFixedLength(this: ArrayBuffer, length: number = this.byteLength): ArrayBuffer {
      const copy = new ArrayBuffer(length);
      new Uint8Array(copy).set(new Uint8Array(this, 0, Math.min(length, this.byteLength)));
      return copy;
    }
    Object.defineProperty(buffer, 'transferToFixedLength', { value: transferToFixedLength, writable: true, configurable: true });
  }
}

installLegacyPolyfills();
