/**
 * Field labels in plain words. A label is what the signer reads in the side
 * panel, so it must name the field ("Party B", "Date"), not repeat a piece of
 * the sentence printed next to it ("hereinafter known as").
 *
 * Pure functions with no PDF code, so the web app can load them up front
 * (`@sign-pdf/core/labels`).
 */

/**
 * Words that end a sentence fragment, not a name: a label that ends in one is
 * cut from running text, such as "day of" or "hereinafter known as". Not
 * "a": "Party A" and "Schedule A" are names.
 */
const FRAGMENT_END = new Set([
  'an', 'and', 'as', 'at', 'between', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'shall', 'that', 'the',
  'this', 'to', 'with',
]);

/** Names that form tools write when a field has no real name. */
const PLACEHOLDER = /^(undefined|null|nan|none)$/i;

/** More words than this read as a sentence, not a name. */
const MAX_WORDS = 4;

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * True when `label` reads as a short name for a field: it has a letter, at
 * most four words, is not a placeholder such as "undefined", and does not end
 * in a word that continues a sentence ("of", "as", "from").
 */
export function isPlainLabel(label: string): boolean {
  const text = collapse(label);
  if (!/\p{L}/u.test(text) || PLACEHOLDER.test(text)) return false;
  const words = text.split(' ');
  if (words.length > MAX_WORDS) return false;
  const last = (words[words.length - 1] ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return !FRAGMENT_END.has(last);
}

const TYPE_WORD: Record<string, string> = {
  text: 'Text',
  checkbox: 'Checkbox',
  signature: 'Signature',
  radio: 'Choice',
  dropdown: 'Choice',
  optionList: 'Choice',
};

/**
 * The label for a field made from an existing form field: the field's
 * tooltip (TU) or name when it is plain, otherwise the type and the field's
 * number in the form, such as "Text 3". `number` is 1-based. The result is
 * still document content, so it stays untrusted.
 */
export function acroFieldLabel(field: { name: string; type: string; tooltip?: string }, number: number): string {
  for (const text of [field.tooltip, field.name]) {
    if (text !== undefined && isPlainLabel(text)) return collapse(text).replace(/_(\d+)$/, ' $1').slice(0, 200);
  }
  return `${TYPE_WORD[field.type] ?? 'Field'} ${number}`;
}

/**
 * True when `label` is not a plain name and printed text next to its field
 * contains it: the label repeats a fragment of the page, and the signer reads
 * it as a value. `nearbyText` is the printed lines next to the field.
 */
export function labelEchoesPageText(label: string, nearbyText: readonly string[]): boolean {
  const text = collapse(label).toLowerCase();
  if (text === '' || isPlainLabel(text)) return false;
  return nearbyText.some((line) => collapse(line).toLowerCase().includes(text));
}
