/** Reading files the person picks, and handing files back as downloads. */
import { PACKET_FILE_SUFFIX, safeParseSignRequest, type SignRequest } from '@sign-pdf/spec';

export async function readBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** A PDF starts with "%PDF-" within its first kilobyte. The file name is not evidence. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  const marker = [0x25, 0x50, 0x44, 0x46, 0x2d];
  outer: for (let i = 0; i + marker.length <= head.length; i += 1) {
    for (let j = 0; j < marker.length; j += 1) {
      if (head[i + j] !== marker[j]) continue outer;
    }
    return true;
  }
  return false;
}

export type PickedKind = 'pdf' | 'packet' | 'json' | 'other';

export function kindFromName(name: string): PickedKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(PACKET_FILE_SUFFIX)) return 'packet';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.json')) return 'json';
  return 'other';
}

export type RequestParse = { ok: true; request: SignRequest } | { ok: false; error: string };

/** Parse request JSON text. Problems come back as one plain sentence. */
export function parseRequestText(text: string): RequestParse {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The request file is not valid JSON.' };
  }
  const result = safeParseSignRequest(data);
  if (result.success) return { ok: true, request: result.data };
  const first = result.error.issues[0];
  const where = first && first.path.length > 0 ? ` (at ${first.path.join('.')})` : '';
  return {
    ok: false,
    error: `The request file is not a valid sign request${where}: ${first?.message ?? 'unknown problem'}.`,
  };
}

/** Does this JSON text look like a packet rather than a bare request? */
export function looksLikePacketText(text: string): boolean {
  return /"kind"\s*:\s*"sign-pdf-packet"/.test(text.slice(0, 4096)) || /"pdfBase64"\s*:/.test(text.slice(0, 4096));
}

export function baseName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '').trim() || 'document';
}

/** Save bytes or text through a temporary object URL. Nothing leaves the device. */
export function downloadFile(name: string, content: Uint8Array | string, mime: string): void {
  const part = typeof content === 'string' ? content : content.slice();
  const url = URL.createObjectURL(new Blob([part], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
