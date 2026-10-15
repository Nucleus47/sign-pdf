/** File IO shared by the CLI and the MCP server. */
import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { MAX_PDF_BYTES } from '@sign-pdf/core';
import { CliError } from './errors.ts';

/** Request files are small; this only stops a mistaken path from filling memory. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** Mode of every file this package writes: readable and writable by the owner only. */
export const OUTPUT_FILE_MODE = 0o600;
const MAX_NUMBERED_NAMES = 1000;
const NO_HARD_LINKS: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK']);

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** Read a regular file of at most `maxBytes`. The size and type are checked before any byte is read. */
async function readBytes(path: string, what: string, maxBytes: number): Promise<Uint8Array> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) throw new CliError('file-unreadable', `${what} is a directory, not a file: ${path}`);
    if (!info.isFile()) throw new CliError('file-unreadable', `${what} is not a regular file: ${path}`);
    if (info.size > maxBytes) {
      throw new CliError('file-too-large', `${what} is ${info.size} bytes; the limit is ${maxBytes} bytes: ${path}`);
    }
    const bytes = new Uint8Array(await readFile(path));
    // The file may have grown between the check and the read.
    if (bytes.length > maxBytes) {
      throw new CliError('file-too-large', `${what} is larger than the limit of ${maxBytes} bytes: ${path}`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = errnoCode(error);
    if (code === 'ENOENT') throw new CliError('file-not-found', `${what} not found: ${path}`);
    if (code === 'EISDIR') throw new CliError('file-unreadable', `${what} is a directory, not a file: ${path}`);
    throw new CliError('file-unreadable', `${what} could not be read: ${path} (${code ?? 'unknown error'})`);
  }
}

/** Read a PDF. Refuses directories, devices, pipes and files larger than core's `MAX_PDF_BYTES`. */
export function readPdfFile(path: string): Promise<Uint8Array> {
  return readBytes(path, 'PDF file', MAX_PDF_BYTES);
}

/** Read and parse a JSON file. The content is returned unvalidated. */
export async function readJsonFile(path: string, what = 'JSON file'): Promise<unknown> {
  const bytes = await readBytes(path, what, MAX_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    const detail = error instanceof SyntaxError ? `: ${error.message}` : '';
    throw new CliError('invalid-json', `${what} is not valid UTF-8 JSON: ${path}${detail}`);
  }
}

export interface OutputOptions {
  /** Replace an existing regular file (atomically). Default false: an existing file is an error. */
  force?: boolean;
  /** Files that were read to make the output. The output must not be any of them. */
  inputs?: readonly string[];
}

const existsError = (path: string): CliError =>
  new CliError('file-exists', `The output file already exists: ${path}`, 'Choose another output path, or pass --force to replace it.');

/** The real path of a file that may not exist yet: its directory is resolved, its name is kept. */
async function realTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  let dir = dirname(absolute);
  const tail: string[] = [basename(absolute)];
  for (;;) {
    try {
      return join(await realpath(dir), ...tail);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return absolute;
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}

/**
 * Check an output path without writing: it must not be a symlink or a
 * directory, must not be one of the inputs (by path or as a hard link), and
 * must not exist unless `force` is set. Returns whether a file is there now.
 */
export async function checkOutputPath(path: string, options: OutputOptions = {}): Promise<{ exists: boolean }> {
  const target = resolve(path);
  const existing = await lstat(target).catch(() => undefined);
  if (existing?.isSymbolicLink()) {
    throw new CliError('unsafe-output', `The output path is a symbolic link and will not be followed: ${target}`, 'Give the path of the real file.');
  }
  if (existing && !existing.isFile()) {
    throw new CliError('unsafe-output', `The output path exists and is not a regular file: ${target}`);
  }
  const realOut = await realTarget(target);
  for (const input of options.inputs ?? []) {
    const realIn = await realpath(resolve(input)).catch(() => resolve(input));
    const info = existing ? await stat(realIn).catch(() => undefined) : undefined;
    if (realIn === realOut || (existing && info && info.dev === existing.dev && info.ino === existing.ino)) {
      throw new CliError('output-is-input', `The output path is the same file as an input: ${target}`, 'Choose another output path.');
    }
  }
  if (existing && options.force !== true) throw existsError(target);
  return { exists: existing !== undefined };
}

/** Fail early, before any slow work, when the output could not be written safely. */
export async function assertWritable(path: string, options: OutputOptions = {}): Promise<void> {
  await checkOutputPath(path, options);
}

/**
 * Write a file safely: the bytes go to a new temporary file in the same
 * directory (created exclusively, mode 0600), are flushed to disk, and only
 * then moved into place. A reader never sees a half-written file, a symlink at
 * the destination is never followed, and without `force` an existing file is
 * never replaced (the final step is an atomic create-if-absent).
 */
export async function writeOutputFile(path: string, data: Uint8Array | string, options: OutputOptions = {}): Promise<void> {
  const target = resolve(path);
  const dir = dirname(target);
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw new CliError('file-unreadable', `The output directory could not be created: ${dir} (${errnoCode(error) ?? 'unknown error'})`);
  }
  await checkOutputPath(target, options);

  const temp = join(dir, `.${basename(target)}.${randomBytes(8).toString('hex')}.tmp`);
  let tempExists = false;
  try {
    // 'wx' is O_CREAT | O_EXCL: the temporary file is new, and a symlink planted at its name is not followed.
    const handle = await open(temp, 'wx', OUTPUT_FILE_MODE);
    tempExists = true;
    try {
      await handle.writeFile(data);
      await handle.chmod(OUTPUT_FILE_MODE);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.force === true) {
      // rename replaces the directory entry itself; it never writes through a link at the destination.
      await checkOutputPath(target, options);
      await rename(temp, target);
      tempExists = false;
    } else {
      // link fails with EEXIST if anything, a symlink included, has appeared at the destination.
      try {
        await link(temp, target);
      } catch (error) {
        if (!NO_HARD_LINKS.has(errnoCode(error) ?? '')) throw error;
        // A file system without hard links: create the destination exclusively and write it directly.
        const direct = await open(target, 'wx', OUTPUT_FILE_MODE);
        try {
          await direct.writeFile(data);
          await direct.sync();
        } finally {
          await direct.close();
        }
      }
    }
    await syncDirectory(dir);
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = errnoCode(error);
    if (code === 'EEXIST') throw existsError(target);
    throw new CliError('file-unreadable', `The output file could not be written: ${target} (${code ?? 'unknown error'})`);
  } finally {
    if (tempExists) await unlink(temp).catch(() => undefined);
  }
}

/** Flush a directory entry to disk where the platform allows it. */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not supported everywhere (Windows); the file itself is already flushed.
  }
}

/** Extensions that are kept whole when a number is added to a name. */
const COMPOUND_EXTENSION = /\.signpacket\.json$/i;

/** `report.pdf` -> `report-2.pdf`; `a.signpacket.json` -> `a-2.signpacket.json`. `n` of 1 is the path itself. */
export function numberedPath(path: string, n: number): string {
  if (n <= 1) return path;
  const name = basename(path);
  const ext = COMPOUND_EXTENSION.exec(name)?.[0] ?? extname(name);
  return join(dirname(path), `${name.slice(0, name.length - ext.length)}-${n}${ext}`);
}

/** The first of `path`, `-2`, `-3`, ... that does not exist now. The write must still be exclusive. */
export async function nextFreePath(path: string, options: Pick<OutputOptions, 'inputs'> = {}): Promise<string> {
  for (let n = 1; n <= MAX_NUMBERED_NAMES; n++) {
    const candidate = numberedPath(resolve(path), n);
    try {
      await checkOutputPath(candidate, options);
      return candidate;
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'file-exists') throw error;
    }
  }
  throw existsError(resolve(path));
}

/**
 * Write without ever replacing a file: if `path` exists (or appears while
 * writing), the data goes to the next free numbered name. Returns the path
 * actually written.
 */
export async function writeToFreePath(path: string, data: Uint8Array | string, options: Pick<OutputOptions, 'inputs'> = {}): Promise<string> {
  for (let n = 1; n <= MAX_NUMBERED_NAMES; n++) {
    const candidate = numberedPath(resolve(path), n);
    try {
      await writeOutputFile(candidate, data, options);
      return candidate;
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'file-exists') throw error;
    }
  }
  throw existsError(resolve(path));
}

function stem(pdfPath: string): string {
  const ext = extname(pdfPath);
  return basename(pdfPath, ext.toLowerCase() === '.pdf' ? ext : '');
}

/** `<name>-signed.pdf` next to the input. */
export function defaultSignedPath(pdfPath: string): string {
  const absolute = resolve(pdfPath);
  return join(dirname(absolute), `${stem(absolute)}-signed.pdf`);
}

/** `<name>.signpacket.json` next to the input. */
export function defaultPacketPath(pdfPath: string, suffix: string): string {
  const absolute = resolve(pdfPath);
  return join(dirname(absolute), `${stem(absolute)}${suffix}`);
}
