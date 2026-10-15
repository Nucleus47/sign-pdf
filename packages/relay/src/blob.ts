/**
 * Streams an uploaded blob into R2 without buffering it, and enforces the size
 * cap twice: on the declared Content-Length, and on the bytes that arrive
 * (a counting stream that fails past the declared length).
 */
import { RELAY_MAX_BLOB_BYTES } from '@sign-pdf/spec';
import { newDocId } from './crypto.ts';
import { HttpError, badRequest } from './http.ts';

export const tooLarge = (): HttpError =>
  new HttpError(413, 'too-large', 'The file is too large to send by email.');

/** The declared size, checked before any byte is read. */
export function declaredLength(request: Request): number {
  const header = request.headers.get('Content-Length');
  if (header === null || !/^\d{1,12}$/.test(header)) {
    throw new HttpError(411, 'bad-request', 'Content-Length is required.');
  }
  const length = Number(header);
  if (length > RELAY_MAX_BLOB_BYTES) throw tooLarge();
  if (length === 0 || !request.body) throw badRequest('The body is empty.');
  return length;
}

/**
 * Writes the request body to R2 under `key`. Returns the put result (null when
 * an `onlyIf` condition failed). Throws 413 when more bytes arrive than were
 * declared, and 400 when fewer arrive.
 */
export async function putStream(
  bucket: R2Bucket,
  key: string,
  request: Request,
  length: number,
  options: R2PutOptions,
): Promise<R2Object | null> {
  let received = 0;
  let overflow = false;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > length) {
        overflow = true;
        controller.error(new Error('body longer than Content-Length'));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  // R2 needs a stream of known length; FixedLengthStream also fails a short body.
  const fixed = new FixedLengthStream(length);
  // Two explicit pipes, each with a handler: a failed `onlyIf` can return before
  // the body is read, and the pipes then fail with nobody waiting on them.
  request.body!.pipeTo(counter.writable).catch(() => {});
  const piping = counter.readable.pipeTo(fixed.writable);
  piping.catch(() => {});
  const failed = () => (overflow ? tooLarge() : badRequest('The upload did not complete.'));
  // Marks this upload's object, so a cleanup never deletes a parallel upload's object.
  const upload = newDocId();
  const tagged: R2PutOptions = { ...options, customMetadata: { ...options.customMetadata, upload } };
  const cleanUp = async () => {
    if ((await bucket.head(key))?.customMetadata?.upload === upload) await bucket.delete(key);
  };
  let result: R2Object | null;
  try {
    result = await bucket.put(key, fixed.readable, tagged);
    // R2 can commit once it has `length` bytes; the pipe then shows whether more followed.
    if (result) await piping;
  } catch {
    // The put can fail after it stored the first `length` bytes (seen in the emulator).
    await cleanUp();
    throw failed();
  }
  return result;
}
