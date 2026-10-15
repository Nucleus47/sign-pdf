/** Zlib inflation with a hard cap on the output, so a small input cannot expand without bound. */
import { Unzlib } from 'fflate';

/** Compressed bytes fed per step: deflate expands at most about 1032 times, so one step stays small. */
const STEP = 16 * 1024;

class OverCap extends Error {}

/**
 * Inflate zlib data. Returns undefined as soon as the output would pass
 * `maxBytes`, without inflating further. Throws when the data is not zlib.
 */
export function inflateCapped(data: Uint8Array, maxBytes: number): Uint8Array | undefined {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Unzlib((chunk) => {
    total += chunk.length;
    if (total > maxBytes) throw new OverCap();
    chunks.push(chunk);
  });
  try {
    if (data.length === 0) inflater.push(data, true);
    for (let offset = 0; offset < data.length; offset += STEP) {
      inflater.push(data.subarray(offset, offset + STEP), offset + STEP >= data.length);
    }
  } catch (error) {
    if (error instanceof OverCap) return undefined;
    throw error;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
