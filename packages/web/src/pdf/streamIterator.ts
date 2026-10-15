/**
 * `for await (const chunk of readableStream)`: pdf.js reads page text this way.
 * Safari on iPhone added async iteration of ReadableStream only recently, and
 * the pdf.js legacy build does not polyfill it: on an older iPhone, reading a
 * PDF fails with "undefined is not a function (near '...i of e...')".
 * Imported first by the app and by the pdf.js worker.
 */
type Iterable = ReadableStream & { values?: unknown; [Symbol.asyncIterator]?: unknown };

export function installStreamIterator(scope: { ReadableStream?: typeof ReadableStream } = globalThis): void {
  const proto = scope.ReadableStream?.prototype as Iterable | undefined;
  if (!proto || typeof proto[Symbol.asyncIterator] === 'function') return;
  function values(this: ReadableStream, options?: { preventCancel?: boolean }): AsyncIterableIterator<unknown> {
    const reader = this.getReader();
    const iterator: AsyncIterableIterator<unknown> = {
      async next() {
        const result = await reader.read();
        if (result.done) reader.releaseLock();
        return result.done ? { done: true, value: undefined } : { done: false, value: result.value };
      },
      async return(value?: unknown) {
        if (!options?.preventCancel) await reader.cancel(value);
        reader.releaseLock();
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }
  for (const key of ['values', Symbol.asyncIterator] as const) {
    Object.defineProperty(proto, key, { value: values, writable: true, configurable: true });
  }
}

installStreamIterator();
