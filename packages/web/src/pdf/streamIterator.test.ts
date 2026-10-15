import { describe, expect, it } from 'vitest';
import { installStreamIterator } from './streamIterator.ts';

/** A stream class as an older Safari has it: getReader, no async iteration. */
function olderStreamClass(chunks: number[]) {
  const log: string[] = [];
  class OldStream {
    getReader() {
      let index = 0;
      return {
        read: () => Promise.resolve(index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }),
        cancel: () => {
          log.push('cancel');
          return Promise.resolve();
        },
        releaseLock: () => log.push('release'),
      };
    }
  }
  return { ReadableStream: OldStream as unknown as typeof ReadableStream, log };
}

describe('installStreamIterator', () => {
  it('makes a stream without async iteration iterable with for await', async () => {
    const scope = olderStreamClass([1, 2, 3]);
    installStreamIterator(scope);
    const seen: unknown[] = [];
    for await (const chunk of new scope.ReadableStream() as unknown as AsyncIterable<unknown>) seen.push(chunk);
    expect(seen).toEqual([1, 2, 3]);
    expect(scope.log).toEqual(['release']);
  });

  it('cancels the stream when the loop ends early', async () => {
    const scope = olderStreamClass([1, 2, 3]);
    installStreamIterator(scope);
    for await (const chunk of new scope.ReadableStream() as unknown as AsyncIterable<unknown>) if (chunk === 1) break;
    expect(scope.log).toEqual(['cancel', 'release']);
  });

  it('leaves a native implementation alone', () => {
    const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
    const native = proto[Symbol.asyncIterator];
    installStreamIterator();
    expect(proto[Symbol.asyncIterator]).toBe(native);
  });
});
