/**
 * Where a tool is allowed to write. An agent chooses `output_path`, so it is
 * confined: inside the directory of the input PDF, or inside the directory
 * that the user named in `SIGN_PDF_OUTPUT_DIR`. Symbolic links are resolved
 * before the comparison, so a link cannot lead out of an allowed directory.
 */
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CliError } from '@sign-pdf/cli';

export const OUTPUT_DIR_ENV = 'SIGN_PDF_OUTPUT_DIR';

/**
 * The real location of a path that may not exist yet: the deepest ancestor
 * directory that exists is resolved through its symbolic links and the rest of
 * the path is kept. The last component itself is never resolved (the writer
 * refuses an output that is a symbolic link).
 */
export async function realLocation(path: string): Promise<string> {
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

/** True when `path` is strictly inside `dir`. Both must be real, absolute paths. */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The real directories an output can go to: the input PDF's, then `SIGN_PDF_OUTPUT_DIR` if set. */
export async function allowedOutputDirs(pdfPath: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const pdfDir = dirname(resolve(pdfPath));
  let realPdfDir: string;
  try {
    realPdfDir = await realpath(pdfDir);
  } catch {
    throw new CliError('file-not-found', `The file does not exist: ${resolve(pdfPath)}`);
  }
  const dirs = [realPdfDir];
  const extra = env[OUTPUT_DIR_ENV];
  if (extra !== undefined && extra !== '') {
    const resolved = resolve(extra);
    // The directory may not exist yet: the writer creates it.
    const real = await realpath(resolved).catch(() => realLocation(resolved));
    if (!dirs.includes(real)) dirs.push(real);
  }
  return dirs;
}

/**
 * Check an `output_path` that an agent gave. Returns the path (normalized) when
 * it is absolute, names a file that ends with `suffix` (any case) and does not
 * start with a dot, and is inside an allowed directory; throws
 * `output-not-allowed` otherwise. The name rules stop an agent from creating a
 * dotfile or a file of another type next to the PDF.
 */
export async function checkedOutputPath(
  outputPath: string,
  pdfPath: string,
  env: NodeJS.ProcessEnv = process.env,
  suffix = '.pdf',
): Promise<string> {
  if (!isAbsolute(outputPath)) {
    throw new CliError('output-not-allowed', `output_path must be an absolute path, got ${JSON.stringify(outputPath)}.`);
  }
  const target = resolve(outputPath);
  const name = basename(target);
  if (name.startsWith('.') || !name.toLowerCase().endsWith(suffix.toLowerCase())) {
    throw new CliError(
      'output-not-allowed',
      `output_path must name a ${suffix} file that does not start with a dot, got ${JSON.stringify(name)}.`,
      `Choose a file name such as "signed${suffix}", or omit output_path to write next to the PDF.`,
    );
  }
  const dirs = await allowedOutputDirs(pdfPath, env);
  const real = await realLocation(target);
  if (!dirs.some((dir) => isInside(dir, real))) {
    throw new CliError(
      'output-not-allowed',
      `output_path is outside the directories this server can write to: ${target}`,
      `Choose a path inside one of: ${dirs.join(', ')}. Or omit output_path to write next to the PDF. ` +
        `Only the user can allow another directory, by setting ${OUTPUT_DIR_ENV} for this server.`,
    );
  }
  return target;
}
