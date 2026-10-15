/** Fitting text into a rectangle. Pure: needs only a way to measure text. */

export interface TextMeasure {
  widthOfTextAtSize(text: string, size: number): number;
}

export interface TextLayoutOptions {
  /** Preferred font size. Default: sized from the rectangle, 12 at most. */
  fontSize?: number;
  multiline?: boolean;
}

export interface TextLayout {
  size: number;
  /** Lines with their origin in the rectangle's own frame: x right, y up from the bottom-left corner. */
  lines: Array<{ text: string; x: number; baseline: number }>;
}

/** Text is never drawn smaller than this; a value that needs less does not fit. */
export const MIN_FONT_SIZE = 4;
const DEFAULT_MAX_FONT_SIZE = 12;
const LINE_HEIGHT = 1.2;
/** Share of the font size that capital letters rise above the baseline. */
const CAP_HEIGHT = 0.7;
/** Share of the font size kept free below a baseline for descenders. */
const DESCENT = 0.25;

/**
 * The text as it will be drawn: line breaks normalized (and kept only where the
 * field allows them), control characters and invisible format characters
 * (zero-width spaces and joiners, direction overrides, soft hyphens) removed.
 */
export function cleanText(text: string, multiline: boolean): string {
  const normalized = text
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[^\P{Cc}\n]|\p{Cf}/gu, '');
  return multiline ? normalized : normalized.replace(/\n+/g, ' ');
}

/** True when cleaned text would leave nothing visible on the page. */
export function isBlankText(cleaned: string): boolean {
  return cleaned.trim() === '';
}

function wrapParagraph(paragraph: string, width: (text: string) => number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  const fits = (candidate: string) => width(candidate) <= maxWidth;
  for (const word of paragraph.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    current = '';
    // A word wider than the rectangle is broken between characters.
    for (const char of Array.from(word)) {
      if (current !== '' && !fits(current + char)) {
        lines.push(current);
        current = char;
      } else {
        current += char;
      }
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Lay cleaned text out inside a `width` x `height` rectangle, shrinking the
 * font (down to MIN_FONT_SIZE) until it fits. Single-line text sits on the
 * bottom edge, where a form line is; multiline text wraps and starts at the top. Returns undefined
 * when the text does not fit even at the smallest size: nothing may be drawn
 * outside the rectangle.
 */
export function layoutText(
  text: string,
  font: TextMeasure,
  width: number,
  height: number,
  options: TextLayoutOptions = {},
): TextLayout | undefined {
  const multiline = options.multiline === true;
  const padding = Math.min(2, width * 0.1);
  const maxWidth = width - 2 * padding;
  const preferred = options.fontSize ?? Math.min(DEFAULT_MAX_FONT_SIZE, multiline ? 10 : height * 0.75);

  // Width grows in proportion to the font size, so each string is measured once.
  const unitWidths = new Map<string, number>();
  const unitWidth = (candidate: string): number => {
    let measured = unitWidths.get(candidate);
    if (measured === undefined) {
      measured = font.widthOfTextAtSize(candidate, 1);
      unitWidths.set(candidate, measured);
    }
    return measured;
  };

  for (let size = Math.max(MIN_FONT_SIZE, preferred); ; size = Math.max(MIN_FONT_SIZE, size - 0.5)) {
    const widthAtSize = (candidate: string) => unitWidth(candidate) * size;
    const lines = multiline
      ? text.split('\n').flatMap((paragraph) => wrapParagraph(paragraph, widthAtSize, maxWidth))
      : [text];
    const blockHeight = multiline
      ? size * (1 + DESCENT + (lines.length - 1) * LINE_HEIGHT)
      : size * (CAP_HEIGHT + 2 * DESCENT);
    let widest = 0;
    for (const line of lines) widest = Math.max(widest, widthAtSize(line));
    if (widest <= maxWidth && blockHeight <= height) {
      const first = multiline ? height - size : size * DESCENT;
      return {
        size,
        lines: lines.map((line, index) => ({
          text: line,
          x: padding,
          baseline: first - index * size * LINE_HEIGHT,
        })),
      };
    }
    if (size <= MIN_FONT_SIZE) return undefined;
  }
}
