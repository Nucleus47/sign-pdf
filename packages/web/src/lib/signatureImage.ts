/**
 * Turning a drawn, typed or uploaded signature into PNG bytes.
 * Signature images live in memory for this page session only; nothing here
 * writes to localStorage, IndexedDB, cookies or the network.
 */
import caveatLatinExtUrl from '../assets/fonts/caveat-latin-ext-500-normal.woff2?url';
import caveatLatinUrl from '../assets/fonts/caveat-latin-500-normal.woff2?url';

export interface Point {
  x: number;
  y: number;
}

/** One pen-down to pen-up path, in CSS pixels of the drawing pad. */
export type Stroke = Point[];

export const INK = '#14213d';
/** No signature image side may exceed this many pixels (the core rejects above 4096). */
export const MAX_SIDE = 3600;
export const SIGNATURE_FONT = 'Sign Pdf Caveat';

export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The box around every pixel whose alpha is above the threshold, or null when blank. */
export function inkBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold = 8,
): Bounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3] ?? 0;
      if (alpha <= alphaThreshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Make paper-coloured pixels transparent, so a photographed signature has no white box. */
export function fadePaper(data: Uint8ClampedArray, whiteFrom = 200, solidBelow = 120): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    if (luminance >= whiteFrom) data[i + 3] = 0;
    else if (luminance > solidBelow) {
      const keep = (whiteFrom - luminance) / (whiteFrom - solidBelow);
      data[i + 3] = Math.round((data[i + 3] ?? 255) * keep);
    }
  }
}

/** Draw strokes with round joins; a single point becomes a dot. */
export function drawStrokes(
  context: CanvasRenderingContext2D,
  strokes: readonly Stroke[],
  lineWidth: number,
): void {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = INK;
  context.fillStyle = INK;
  context.lineWidth = lineWidth;
  for (const stroke of strokes) {
    const first = stroke[0];
    if (!first) continue;
    if (stroke.length === 1) {
      context.beginPath();
      context.arc(first.x, first.y, lineWidth / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.beginPath();
    context.moveTo(first.x, first.y);
    for (let i = 1; i < stroke.length - 1; i += 1) {
      const current = stroke[i];
      const next = stroke[i + 1];
      if (!current || !next) continue;
      // Quadratic smoothing through midpoints keeps fast strokes from looking angular.
      context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
    }
    const last = stroke.at(-1);
    if (last) context.lineTo(last.x, last.y);
    context.stroke();
  }
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser cannot draw to a canvas.');
  return context;
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The image could not be saved.');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Crop a canvas to its ink plus a small margin. Returns null when there is no ink. */
function cropToInk(source: HTMLCanvasElement, margin: number): HTMLCanvasElement | null {
  const context = context2d(source);
  const image = context.getImageData(0, 0, source.width, source.height);
  const bounds = inkBounds(image.data, source.width, source.height);
  if (!bounds) return null;
  const left = Math.max(0, bounds.left - margin);
  const top = Math.max(0, bounds.top - margin);
  const right = Math.min(source.width, bounds.left + bounds.width + margin);
  const bottom = Math.min(source.height, bounds.top + bounds.height + margin);
  const out = document.createElement('canvas');
  out.width = right - left;
  out.height = bottom - top;
  context2d(out).drawImage(source, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Render pad strokes at 3x for print quality, cropped to the ink. */
export async function strokesToPng(
  strokes: readonly Stroke[],
  padWidth: number,
  padHeight: number,
): Promise<Uint8Array | null> {
  if (strokes.length === 0) return null;
  const factor = Math.min(3, MAX_SIDE / Math.max(padWidth, padHeight, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(padWidth * factor));
  canvas.height = Math.max(1, Math.round(padHeight * factor));
  const context = context2d(canvas);
  context.scale(factor, factor);
  drawStrokes(context, strokes, 2.4);
  const cropped = cropToInk(canvas, 6 * factor);
  return cropped ? canvasToPng(cropped) : null;
}

let fontReady: Promise<void> | undefined;

/** Load the bundled handwriting font (same-origin files; no remote font is ever used). */
export function loadSignatureFont(): Promise<void> {
  fontReady ??= (async () => {
    const faces = [
      new FontFace(SIGNATURE_FONT, `url(${caveatLatinUrl}) format("woff2")`, {
        weight: '500',
        unicodeRange:
          'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
      }),
      new FontFace(SIGNATURE_FONT, `url(${caveatLatinExtUrl}) format("woff2")`, {
        weight: '500',
        unicodeRange:
          'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
      }),
    ];
    for (const face of faces) document.fonts.add(face);
    await Promise.all(faces.map((face) => face.load().catch(() => undefined)));
  })();
  return fontReady;
}

/** Render a typed name in the handwriting font, cropped to the ink. */
export async function typedToPng(text: string): Promise<Uint8Array | null> {
  const value = text.trim();
  if (!value) return null;
  await loadSignatureFont();
  const size = 120;
  const font = `500 ${size}px "${SIGNATURE_FONT}", cursive`;
  const canvas = document.createElement('canvas');
  const measure = context2d(canvas);
  measure.font = font;
  const width = Math.ceil(measure.measureText(value).width) + size;
  canvas.width = Math.min(width, MAX_SIDE);
  canvas.height = size * 2;
  const context = context2d(canvas);
  context.font = font;
  context.fillStyle = INK;
  context.textBaseline = 'middle';
  context.fillText(value, size / 2, size, canvas.width - size);
  const cropped = cropToInk(canvas, 8);
  return cropped ? canvasToPng(cropped) : null;
}

export const UPLOAD_TYPES = ['image/png', 'image/jpeg'] as const;

export function isAcceptedUpload(file: Pick<File, 'type' | 'name'>): boolean {
  if ((UPLOAD_TYPES as readonly string[]).includes(file.type)) return true;
  return file.type === '' && /\.(png|jpe?g)$/i.test(file.name);
}

/** Decode a PNG or JPEG, optionally drop the paper background, and re-encode as PNG. */
export async function imageFileToPng(
  file: Blob,
  options: { removePaper: boolean },
): Promise<Uint8Array | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const limit = 1600;
    const ratio = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = context2d(canvas);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    if (!options.removePaper) {
      // A fully transparent image is not a signature.
      return inkBounds(image.data, canvas.width, canvas.height) ? await canvasToPng(canvas) : null;
    }
    fadePaper(image.data);
    context.putImageData(image, 0, 0);
    const cropped = cropToInk(canvas, 6);
    return cropped ? await canvasToPng(cropped) : null;
  } finally {
    bitmap.close();
  }
}
