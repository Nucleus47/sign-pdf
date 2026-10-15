/** Copying text for the person, with a fallback for browsers without the Clipboard API. */

export interface CopyEnv {
  clipboard?: { writeText?: (text: string) => Promise<void> } | undefined;
  execCommand?: ((command: string) => boolean) | undefined;
}

function defaultEnv(): CopyEnv {
  return {
    clipboard: typeof navigator === 'undefined' ? undefined : navigator.clipboard,
    execCommand: typeof document === 'undefined' ? undefined : (command) => document.execCommand(command),
  };
}

/**
 * Copy `text`. When the Clipboard API is missing or refuses, the text in
 * `field` is selected and copied the old way. Returns false when neither
 * works: the text is then left selected for the person to copy.
 */
export async function copyText(text: string, field: HTMLTextAreaElement | null, env: CopyEnv = defaultEnv()): Promise<boolean> {
  if (typeof env.clipboard?.writeText === 'function') {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (no permission, or the page is not focused): try the fallback.
    }
  }
  if (!field) return false;
  field.focus();
  field.select();
  field.setSelectionRange(0, field.value.length);
  try {
    return env.execCommand?.('copy') === true;
  } catch {
    return false;
  }
}
