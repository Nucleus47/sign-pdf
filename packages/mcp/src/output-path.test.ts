import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '@sign-pdf/cli';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OUTPUT_DIR_ENV, allowedOutputDirs, checkedOutputPath, isInside } from './output-path.ts';

let root: string;
let pdfPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sign-pdf-out-'));
  await mkdir(join(root, 'a'));
  await mkdir(join(root, 'ab'));
  await mkdir(join(root, 'elsewhere'));
  pdfPath = join(root, 'a', 'form.pdf');
  await writeFile(pdfPath, 'synthetic');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function refused(outputPath: string, env: NodeJS.ProcessEnv = {}): Promise<CliError> {
  const error = await checkedOutputPath(outputPath, pdfPath, env).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe('output-not-allowed');
  return error as CliError;
}

describe('checkedOutputPath', () => {
  it('accepts a path in the directory of the PDF, also in a subdirectory that does not exist yet', async () => {
    expect(await checkedOutputPath(join(root, 'a', 'out.pdf'), pdfPath, {})).toBe(join(root, 'a', 'out.pdf'));
    expect(await checkedOutputPath(join(root, 'a', 'new', 'deeper', 'out.pdf'), pdfPath, {})).toBe(join(root, 'a', 'new', 'deeper', 'out.pdf'));
  });

  it('refuses a relative path', async () => {
    const error = await refused('out.pdf');
    expect(error.message).toContain('absolute');
  });

  it('refuses a name without a .pdf suffix or with a leading dot, and accepts any case of .pdf', async () => {
    for (const name of ['out', 'out.txt', 'out.pdf.sh', '.hidden.pdf', '.pdf', '.bashrc']) {
      const error = await refused(join(root, 'a', name));
      expect(error.message).toContain('.pdf');
    }
    expect(await checkedOutputPath(join(root, 'a', 'OUT.PDF'), pdfPath, {})).toBe(join(root, 'a', 'OUT.PDF'));
    expect(await checkedOutputPath(join(root, 'a', 'out.Pdf'), pdfPath, {})).toBe(join(root, 'a', 'out.Pdf'));
  });

  it('checks a different suffix when the caller names one', async () => {
    const packet = join(root, 'a', 'form.signpacket.json');
    expect(await checkedOutputPath(packet, pdfPath, {}, '.signpacket.json')).toBe(packet);
    await expect(checkedOutputPath(join(root, 'a', 'form.pdf'), pdfPath, {}, '.signpacket.json')).rejects.toMatchObject({ code: 'output-not-allowed' });
    await expect(checkedOutputPath(join(root, 'a', '.signpacket.json'), pdfPath, {}, '.signpacket.json')).rejects.toMatchObject({ code: 'output-not-allowed' });
  });

  it('refuses a path that leaves the directory with ".."', async () => {
    await refused(`${root}/a/../elsewhere/out.pdf`);
    await refused(`${root}/a/new/../../out.pdf`);
    // ".." that stays inside is fine.
    expect(await checkedOutputPath(`${root}/a/new/../out.pdf`, pdfPath, {})).toBe(join(root, 'a', 'out.pdf'));
  });

  it('refuses a sibling directory whose name starts with the allowed name', async () => {
    await refused(join(root, 'ab', 'out.pdf'));
  });

  it('refuses the allowed directory itself and anything above it', async () => {
    await refused(join(root, 'a'));
    await refused(join(root, 'out.pdf'));
  });

  it('refuses a symbolic link to a directory outside, also below a part that does not exist yet', async () => {
    await symlink(join(root, 'elsewhere'), join(root, 'a', 'link'), 'dir');
    await refused(join(root, 'a', 'link', 'out.pdf'));
    await refused(join(root, 'a', 'link', 'new', 'out.pdf'));
  });

  it('accepts a symbolic link that stays inside', async () => {
    await mkdir(join(root, 'a', 'real'));
    await symlink(join(root, 'a', 'real'), join(root, 'a', 'inner'), 'dir');
    expect(await checkedOutputPath(join(root, 'a', 'inner', 'out.pdf'), pdfPath, {})).toBe(join(root, 'a', 'inner', 'out.pdf'));
  });

  it('accepts a path inside SIGN_PDF_OUTPUT_DIR and names the allowed directories in the hint', async () => {
    const env = { [OUTPUT_DIR_ENV]: join(root, 'elsewhere') };
    expect(await checkedOutputPath(join(root, 'elsewhere', 'out.pdf'), pdfPath, env)).toBe(join(root, 'elsewhere', 'out.pdf'));
    const error = await refused(join(root, 'ab', 'out.pdf'), env);
    expect(error.hint).toContain(await realpath(join(root, 'a')));
    expect(error.hint).toContain(await realpath(join(root, 'elsewhere')));
    // Without the variable the same path is refused.
    await refused(join(root, 'elsewhere', 'out.pdf'));
  });

  it('resolves SIGN_PDF_OUTPUT_DIR through symbolic links, and allows one that does not exist yet', async () => {
    await symlink(join(root, 'elsewhere'), join(root, 'alias'), 'dir');
    expect(await allowedOutputDirs(pdfPath, { [OUTPUT_DIR_ENV]: join(root, 'alias') })).toEqual([
      await realpath(join(root, 'a')),
      await realpath(join(root, 'elsewhere')),
    ]);
    const later = { [OUTPUT_DIR_ENV]: join(root, 'later') };
    expect(await checkedOutputPath(join(root, 'later', 'out.pdf'), pdfPath, later)).toBe(join(root, 'later', 'out.pdf'));
    await refused(join(root, 'later-2', 'out.pdf'), later);
  });

  it('reports a PDF directory that does not exist as file-not-found', async () => {
    await expect(checkedOutputPath(join(root, 'a', 'out.pdf'), join(root, 'absent', 'form.pdf'), {})).rejects.toMatchObject({ code: 'file-not-found' });
  });
});

describe('isInside', () => {
  it('is strict and does not compare by string prefix', () => {
    expect(isInside('/tmp/a', '/tmp/a/x.pdf')).toBe(true);
    expect(isInside('/tmp/a', '/tmp/ab/x.pdf')).toBe(false);
    expect(isInside('/tmp/a', '/tmp/a')).toBe(false);
    expect(isInside('/tmp/a', '/tmp/x.pdf')).toBe(false);
    expect(isInside('/tmp/a', '/tmp/a/..x.pdf')).toBe(true);
  });
});
