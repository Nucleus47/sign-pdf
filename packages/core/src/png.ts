/** Checks on a signature or initials image before it is embedded. */
import { decode, toRGBA8 } from '@cantoo/pdf-lib/upng';
import { errorMessage } from './errors.ts';
import { inflateCapped } from './inflate.ts';
import { MAX_SIGNATURE_IMAGE_SIDE } from './limits.ts';

export type SignatureImageProblem = 'not-png' | 'too-large' | 'no-ink';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A pixel counts as ink when it is at least this opaque and not close to white. */
const MIN_INK_ALPHA = 32;
const MAX_INK_BRIGHTNESS = 235;

/** Width and height from the IHDR chunk, read without decoding any pixels. */
export function readPngSize(png: Uint8Array): { width: number; height: number } | undefined {
  if (png.length < 24 || PNG_SIGNATURE.some((byte, index) => png[index] !== byte)) return undefined;
  if (String.fromCharCode(...png.subarray(12, 16)) !== 'IHDR') return undefined;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Samples per pixel for each PNG colour type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** Adam7 passes: x start, y start, x step, y step. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;
/**
 * Chunks that the PNG decoder inflates outside the image data (compressed
 * text), or that make an animation or an Apple-only variant. A signature
 * needs none of them, so an image with one is refused before decoding.
 */
const REFUSED_CHUNKS = new Set(['zTXt', 'iTXt', 'CgBI', 'acTL', 'fcTL', 'fdAT']);

/** Bytes of filtered image data that the header implies: each row's samples plus its filter byte. */
function expectedDataSize(width: number, height: number, bitsPerPixel: number, interlaced: boolean): number {
  const rows = (w: number, h: number) => (w > 0 && h > 0 ? h * (1 + Math.ceil((w * bitsPerPixel) / 8)) : 0);
  if (!interlaced) return rows(width, height);
  return ADAM7.reduce(
    (total, [x, y, dx, dy]) => total + rows(Math.ceil((width - x) / dx), Math.ceil((height - y) / dy)),
    0,
  );
}

/**
 * Walk the chunks, refuse the ones listed above, and inflate the image data
 * with a cap at the size the header implies, so a small file cannot expand
 * without bound. Returns a problem message, or undefined when the data fits.
 */
function checkImageData(png: Uint8Array, width: number, height: number): string | undefined {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const depth = png[24] ?? 0;
  const channels = CHANNELS[png[25] ?? -1];
  const interlace = png[28];
  if (channels === undefined || ![1, 2, 4, 8, 16].includes(depth) || (interlace !== 0 && interlace !== 1)) {
    return 'the signature image has a PNG header that is not valid.';
  }
  const parts: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > png.length) return 'the signature image is not a usable PNG: a chunk is cut off.';
    if (REFUSED_CHUNKS.has(type)) return `the signature image has a "${type}" chunk, which is not supported.`;
    if (type === 'IDAT') parts.push(png.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset = end;
  }
  const data = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  const expected = expectedDataSize(width, height, channels * depth, interlace === 1);
  let inflated: Uint8Array | undefined;
  try {
    inflated = inflateCapped(data, expected);
  } catch (error) {
    return `the signature image is not a usable PNG: ${errorMessage(error)}`;
  }
  if (inflated === undefined) return 'the signature image holds more data than its size allows.';
  return undefined;
}

/**
 * Returns a problem when the image cannot serve as a signature: not a PNG,
 * larger than MAX_SIGNATURE_IMAGE_SIDE on a side (checked before decoding),
 * with more image data than its size allows or chunks the decoder would
 * inflate (checked before decoding), or with nothing that would show on paper
 * (fully transparent, or white only).
 */
export function checkSignaturePng(png: Uint8Array): { problem: SignatureImageProblem; message: string } | undefined {
  const size = readPngSize(png);
  if (!size || size.width === 0 || size.height === 0) {
    return { problem: 'not-png', message: 'the signature image is not a PNG.' };
  }
  if (size.width > MAX_SIGNATURE_IMAGE_SIDE || size.height > MAX_SIGNATURE_IMAGE_SIDE) {
    return {
      problem: 'too-large',
      message:
        `the signature image is ${size.width} x ${size.height} pixels. ` +
        `The limit is ${MAX_SIGNATURE_IMAGE_SIDE} on each side.`,
    };
  }
  const dataProblem = checkImageData(png, size.width, size.height);
  if (dataProblem) return { problem: 'not-png', message: dataProblem };
  let rgba: Uint8Array;
  try {
    const exact = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
    const frame = toRGBA8(decode(exact as ArrayBuffer))[0];
    if (!frame) throw new Error('no image data');
    rgba = new Uint8Array(frame);
  } catch (error) {
    return { problem: 'not-png', message: `the signature image is not a usable PNG: ${errorMessage(error)}` };
  }
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const alpha = rgba[i + 3] ?? 0;
    if (alpha < MIN_INK_ALPHA) continue;
    const darkest = Math.min(rgba[i] ?? 255, rgba[i + 1] ?? 255, rgba[i + 2] ?? 255);
    if (darkest <= MAX_INK_BRIGHTNESS) return undefined;
  }
  return { problem: 'no-ink', message: 'the signature image is blank: it has no visible ink.' };
}
