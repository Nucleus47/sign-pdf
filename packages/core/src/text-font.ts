/**
 * The font text values are drawn with, opened for measuring without a PDF.
 * The same bytes are embedded at signing, so a check made here holds there.
 */
import * as fontkit from '@cantoo/fontkit';
import { SignPdfError, errorMessage } from './errors.ts';
import { base64ToBytes } from './hash.ts';
import type { TextMeasure } from './text-layout.ts';

export interface TextFontOptions {
  /**
   * TrueType or OpenType font bytes to draw text with, instead of the bundled
   * Noto Sans (Latin, Greek, Cyrillic). Supply one for scripts the bundled font
   * lacks, such as CJK. The core never downloads a font.
   */
  font?: Uint8Array;
}

export interface TextFont extends TextMeasure {
  /** The font file, for embedding. */
  bytes: Uint8Array;
  /** The distinct characters of `text` the font has no glyph for. */
  missingCharacters(text: string): string[];
}

function open(bytes: Uint8Array): TextFont {
  let opened: fontkit.Font | fontkit.FontCollection;
  try {
    opened = fontkit.create(bytes);
  } catch (error) {
    throw new SignPdfError('invalid-request', `The supplied font could not be read: ${errorMessage(error)}`);
  }
  if ('fonts' in opened) {
    throw new SignPdfError('invalid-request', 'Font collections are not supported. Supply a single TTF or OTF font.');
  }
  const font = opened;
  return {
    bytes,
    // Mirrors how pdf-lib measures an embedded font, so layout and drawing agree.
    widthOfTextAtSize(text, size) {
      let total = 0;
      for (const glyph of font.layout(text).glyphs) total += glyph.advanceWidth;
      return (total / font.unitsPerEm) * size;
    },
    missingCharacters(text) {
      const missing = new Set<string>();
      for (const char of text) {
        if (char === '\n') continue;
        if (!font.hasGlyphForCodePoint(char.codePointAt(0) ?? 0)) missing.add(char);
      }
      return [...missing];
    },
  };
}

let bundled: Promise<TextFont> | undefined;
const supplied = new WeakMap<Uint8Array, TextFont>();

async function openBundled(): Promise<TextFont> {
  // Loaded on demand so the font stays out of the main bundle of apps that never need it.
  const { NOTO_SANS_REGULAR_BASE64 } = await import('./font/noto-sans-regular.ts');
  const bytes = base64ToBytes(NOTO_SANS_REGULAR_BASE64);
  if (!bytes) throw new Error('The bundled font is corrupt.');
  return open(bytes);
}

export function loadTextFont(options: TextFontOptions = {}): Promise<TextFont> {
  const custom = options.font;
  if (!custom) {
    const loading = bundled ?? openBundled();
    bundled = loading;
    return loading;
  }
  let font = supplied.get(custom);
  if (!font) {
    font = open(custom);
    supplied.set(custom, font);
  }
  return Promise.resolve(font);
}
