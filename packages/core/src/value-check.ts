/**
 * Whether a text or date value can be drawn: every character has a glyph and
 * the text fits its rectangle. Shared by resolveRequest, finalizeDocument and
 * the `checkFieldValue` helper a UI calls while the user types.
 */
import { DateField, TextField, type Field } from '@sign-pdf/spec';
import { SignPdfError, formatIssues } from './errors.ts';
import { loadTextFont, type TextFont, type TextFontOptions } from './text-font.ts';
import { MIN_FONT_SIZE, cleanText, isBlankText, layoutText, type TextLayout } from './text-layout.ts';

/** The parts of a field that decide how its value is drawn. */
export interface CheckableField {
  type: Field['type'];
  fontSize?: number | undefined;
  multiline?: boolean | undefined;
}

export interface FieldValueProblem {
  code: 'invalid-request' | 'value-does-not-fit' | 'unsupported-characters';
  message: string;
}

export type FieldValueCheck =
  | {
      ok: true;
      /** The value as it will be drawn and recorded: text with invisible characters removed. */
      value: string | boolean;
    }
  | ({ ok: false } & FieldValueProblem);

export type CheckFieldValueOptions = TextFontOptions;

const isMultiline = (field: CheckableField): boolean => field.type === 'text' && field.multiline === true;

const describeCharacter = (char: string): string =>
  `"${char}" (U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')})`;

export function cleanFieldText(field: CheckableField, value: string): string {
  return cleanText(value, isMultiline(field));
}

/** Lay out cleaned text for a field, or say why it cannot be drawn. */
export function layoutFieldText(
  field: CheckableField,
  size: { width: number; height: number },
  cleaned: string,
  font: TextFont,
): TextLayout | FieldValueProblem {
  const missing = font.missingCharacters(cleaned);
  if (missing.length > 0) {
    const shown = missing.slice(0, 10).map(describeCharacter).join(', ');
    const more = missing.length > 10 ? `, and ${missing.length - 10} more` : '';
    return {
      code: 'unsupported-characters',
      message: `the font cannot draw ${shown}${more}. Remove them, or supply a font that has them.`,
    };
  }
  const layout = layoutText(cleaned, font, size.width, size.height, {
    ...(field.fontSize !== undefined ? { fontSize: field.fontSize } : {}),
    multiline: isMultiline(field),
  });
  if (!layout) {
    const r = (n: number) => Math.round(n * 10) / 10;
    return {
      code: 'value-does-not-fit',
      message:
        `the text does not fit in ${r(size.width)} x ${r(size.height)} points, even at the smallest ` +
        `font size (${MIN_FONT_SIZE}). Shorten it or enlarge the field.`,
    };
  }
  return layout;
}

function check(
  field: CheckableField,
  size: { width: number; height: number },
  value: string | boolean,
  font: TextFont,
): FieldValueCheck {
  if (field.type === 'signature' || field.type === 'initials') {
    return { ok: false, code: 'invalid-request', message: `a ${field.type} field cannot take a value.` };
  }
  if (field.type === 'checkbox') {
    return typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false, code: 'invalid-request', message: 'a checkbox needs true or false.' };
  }
  if (typeof value !== 'string') {
    return { ok: false, code: 'invalid-request', message: `a ${field.type} field needs a text value.` };
  }
  const cleaned = cleanFieldText(field, value);
  // Nothing to draw: the field is empty. Whether that is allowed is the caller's `required` rule.
  if (isBlankText(cleaned)) return { ok: true, value: cleaned };
  const schema = field.type === 'date' ? DateField.shape.value : TextField.shape.value;
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    return { ok: false, code: 'invalid-request', message: `${formatIssues(parsed.error.issues)}.` };
  }
  const layout = layoutFieldText(field, size, cleaned, font);
  return 'code' in layout ? { ok: false, ...layout } : { ok: true, value: cleaned };
}

/**
 * Check a value before signing: right type for the field, every character
 * drawable, and the text fits the rectangle. `finalizeDocument` applies the
 * same rules and throws where this returns `ok: false`. Does not judge
 * `required`: an empty value is `ok`.
 */
export async function checkFieldValue(
  field: CheckableField,
  rect: { width: number; height: number },
  value: string | boolean,
  options?: CheckFieldValueOptions,
): Promise<FieldValueCheck> {
  return check(field, rect, value, await loadTextFont(options));
}

/** As `checkFieldValue`, but throws a SignPdfError carrying the field id. */
export function assertFieldValue(
  field: CheckableField & { id: string },
  rect: { width: number; height: number },
  value: string | boolean,
  font: TextFont,
): string | boolean {
  const result = check(field, rect, value, font);
  if (!result.ok) throw new SignPdfError(result.code, `Field "${field.id}": ${result.message}`, field.id);
  return result.value;
}
