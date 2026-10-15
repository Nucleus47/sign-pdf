/**
 * The two files the prepare view hands over: the request JSON and the packet.
 * The buttons and the browser agent API both save them through here.
 */
import type { SignRequestInput } from '@sign-pdf/spec';
import { core } from './core.ts';
import { baseName, downloadFile } from './files.ts';

export function saveRequestFile(documentName: string, request: SignRequestInput): string {
  const name = `${baseName(documentName)}.signrequest.json`;
  downloadFile(name, `${JSON.stringify(request, null, 2)}\n`, 'application/json');
  return name;
}

/** Throws the core's error when the request does not fit the PDF. */
export async function savePacketFile(
  document: { name: string; bytes: Uint8Array },
  request: SignRequestInput,
): Promise<{ name: string; chars: number }> {
  const packet = await core.createPacket(document.bytes, request);
  const text = await core.encodePacket(packet);
  const name = `${baseName(document.name)}.signpacket.json`;
  downloadFile(name, text, 'application/json');
  return { name, chars: text.length };
}
