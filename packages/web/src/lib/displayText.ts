/**
 * Untrusted text on its way to the screen: the preparer's note and title, the
 * document name, field labels and what an audit record says.
 *
 * Bidirectional control characters can make text read differently from what it
 * is (a name with U+202E before "fdp.exe" shows as ending in "exe.pdf"), so
 * they are removed for display. The values handed to the core are never
 * changed here. Elements that show such text also carry the `untrusted-text`
 * class, which isolates their direction from the app's own words around them.
 */
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏؜]/g;

export function displayText(value: string): string {
  return value.replace(BIDI_CONTROLS, '');
}

/** Class for every element that shows untrusted text. Styled in app.css. */
export const UNTRUSTED_TEXT_CLASS = 'untrusted-text';

/**
 * Names that form tools write when a field has no real name, such as the
 * "undefined" that some PDF editors give an unnamed form field. They mean
 * nothing to a person, so the screen never shows one as a field's name.
 */
const PLACEHOLDER_NAME = /^(undefined|null|nan|none)$/i;

export function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_NAME.test(name.trim());
}

/** A time (ISO text) as a date and time in the person's own locale; empty when it is not a time. */
export function formatDateTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
