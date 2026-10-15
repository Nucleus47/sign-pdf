/**
 * File safety: what is read is a regular file of a sane size, and what is
 * written is private, complete, never an input and never behind a symlink.
 */
import { execFile } from 'node:child_process';
import { chmod, link, lstat, mkdir, readFile, readdir, readlink, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { MAX_PDF_BYTES } from '@sign-pdf/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OUTPUT_FILE_MODE,
  checkOutputPath,
  nextFreePath,
  numberedPath,
  readJsonFile,
  readPdfFile,
  writeOutputFile,
  writeToFreePath,
} from './files.ts';
import { fixturePdf, requestFor, runCli, signInBrowser, workspace, type Workspace } from './test-helpers.ts';

const WINDOWS = process.platform === 'win32';

let ws: Workspace;

beforeEach(async () => {
  ws = await workspace();
});

afterEach(async () => {
  await ws.cleanup();
});

/** Permission bits of a file. Windows has no such bits, so the check is skipped there. */
async function expectPrivate(path: string): Promise<void> {
  const info = await lstat(path);
  expect(info.isFile()).toBe(true);
  if (!WINDOWS) expect(info.mode & 0o777).toBe(0o600);
}

const names = async (dir = ws.dir): Promise<string[]> => (await readdir(dir)).sort();

describe('readPdfFile', () => {
  it('reads a regular file and reports a missing one', async () => {
    const pdf = await fixturePdf();
    expect(await readPdfFile(await ws.write('fixture.pdf', pdf))).toEqual(pdf);
    await expect(readPdfFile(ws.path('absent.pdf'))).rejects.toMatchObject({ code: 'file-not-found' });
  });

  it('refuses a directory', async () => {
    await mkdir(ws.path('folder.pdf'));
    await expect(readPdfFile(ws.path('folder.pdf'))).rejects.toMatchObject({ code: 'file-unreadable', message: expect.stringContaining('directory') as unknown });
    await expect(readPdfFile(ws.dir)).rejects.toMatchObject({ code: 'file-unreadable' });
    await expect(readJsonFile(ws.dir)).rejects.toMatchObject({ code: 'file-unreadable' });
  });

  it.skipIf(WINDOWS)('refuses a FIFO without opening it', async () => {
    const fifo = ws.path('pipe.pdf');
    await promisify(execFile)('mkfifo', [fifo]);
    expect((await stat(fifo)).isFIFO()).toBe(true);
    // Opening a FIFO with no writer would block for ever: the answer must come from the type check alone.
    await expect(readPdfFile(fifo)).rejects.toMatchObject({ code: 'file-unreadable', message: expect.stringContaining('not a regular file') as unknown });
    const viaCli = await runCli(['inspect', fifo, '--json']);
    expect(viaCli.code).toBe(1);
    expect(viaCli.json()).toMatchObject({ ok: false, error: { code: 'file-unreadable' } });
  });

  it.skipIf(WINDOWS)('refuses a device file', async () => {
    await expect(readPdfFile('/dev/null')).rejects.toMatchObject({ code: 'file-unreadable' });
  });

  it("refuses a file larger than core's MAX_PDF_BYTES before reading it", async () => {
    const big = await ws.write('big.pdf', '%PDF-1.7\n');
    // A sparse file: the size is set, nothing is written.
    await truncate(big, MAX_PDF_BYTES + 1);
    expect((await stat(big)).size).toBe(MAX_PDF_BYTES + 1);
    await expect(readPdfFile(big)).rejects.toMatchObject({ code: 'file-too-large', message: expect.stringContaining(String(MAX_PDF_BYTES)) as unknown });

    for (const args of [['inspect', big], ['verify', big], ['validate', big, ws.path('r.json')], ['request', big, await ws.write('r.json', '{}')]]) {
      const result = await runCli([...args, '--json']);
      expect(result.code, args[0]).toBe(1);
      expect(result.json(), args[0]).toMatchObject({ ok: false, error: { code: 'file-too-large' } });
    }

    // Exactly at the limit the size check passes (the content is then not a PDF, which is another error).
    const atLimit = await ws.write('limit.pdf', '%PDF-1.7\n');
    await truncate(atLimit, MAX_PDF_BYTES);
    expect((await readPdfFile(atLimit)).length).toBe(MAX_PDF_BYTES);
  });
});

describe('writeOutputFile', () => {
  it('writes the whole file with mode 0600 and leaves no temporary file', async () => {
    expect(OUTPUT_FILE_MODE).toBe(0o600);
    const data = new Uint8Array(300_000).map((_, index) => index % 251);
    await writeOutputFile(ws.path('out/deep/data.bin'), data);
    expect(new Uint8Array(await readFile(ws.path('out/deep/data.bin')))).toEqual(data);
    await expectPrivate(ws.path('out/deep/data.bin'));
    expect(await names(ws.path('out/deep'))).toEqual(['data.bin']);
    // The temporary link is gone: the file has one name.
    expect((await stat(ws.path('out/deep/data.bin'))).nlink).toBe(1);

    await writeOutputFile(ws.path('text.json'), '{"a":1}');
    expect(await readFile(ws.path('text.json'), 'utf8')).toBe('{"a":1}');
    await expectPrivate(ws.path('text.json'));
    expect(await names()).toEqual(['out', 'text.json']);
  });

  it('refuses an existing file without force and leaves it and the directory as they were', async () => {
    const existing = await ws.write('kept.pdf', 'keep me');
    await chmod(existing, 0o644);
    await expect(writeOutputFile(existing, 'new content')).rejects.toMatchObject({ code: 'file-exists' });
    await expect(writeOutputFile(existing, 'new content', { force: false })).rejects.toMatchObject({ code: 'file-exists' });
    expect(await readFile(existing, 'utf8')).toBe('keep me');
    if (!WINDOWS) expect((await stat(existing)).mode & 0o777).toBe(0o644);
    expect(await names()).toEqual(['kept.pdf']);
  });

  it('with force replaces the file atomically: the old content is gone and the new file is private', async () => {
    const existing = await ws.write('kept.pdf', 'old content that is longer than the new one');
    await chmod(existing, 0o644);
    const before = await stat(existing);
    // A second name for the old file shows that it was replaced, not written into.
    await link(existing, ws.path('old-name.pdf'));

    await writeOutputFile(existing, 'new', { force: true });
    expect(await readFile(existing, 'utf8')).toBe('new');
    await expectPrivate(existing);
    const after = await stat(existing);
    expect(after.ino).not.toBe(before.ino);
    expect(await readFile(ws.path('old-name.pdf'), 'utf8')).toBe('old content that is longer than the new one');
    expect(await names()).toEqual(['kept.pdf', 'old-name.pdf']);

    // Force on a path that does not exist yet just writes it.
    await writeOutputFile(ws.path('fresh.pdf'), 'fresh', { force: true });
    await expectPrivate(ws.path('fresh.pdf'));
    expect(await names()).toEqual(['fresh.pdf', 'kept.pdf', 'old-name.pdf']);
  });

  it('refuses a symlink destination, with and without force, and leaves its target untouched', async () => {
    const target = await ws.write('target.txt', 'the link target');
    await symlink(target, ws.path('out.pdf'));
    await symlink(ws.path('nowhere.txt'), ws.path('dangling.pdf'));
    for (const force of [false, true]) {
      await expect(writeOutputFile(ws.path('out.pdf'), 'written through the link', { force })).rejects.toMatchObject({ code: 'unsafe-output' });
      await expect(writeOutputFile(ws.path('dangling.pdf'), 'written through the link', { force })).rejects.toMatchObject({ code: 'unsafe-output' });
      await expect(checkOutputPath(ws.path('out.pdf'), { force })).rejects.toMatchObject({ code: 'unsafe-output' });
      await expect(writeToFreePath(ws.path('out.pdf'), 'x')).rejects.toMatchObject({ code: 'unsafe-output' });
    }
    expect(await readFile(target, 'utf8')).toBe('the link target');
    expect(await readlink(ws.path('out.pdf'))).toBe(target);
    expect(await names()).toEqual(['dangling.pdf', 'out.pdf', 'target.txt']);
  });

  it('refuses a directory as the destination', async () => {
    await mkdir(ws.path('folder'));
    for (const force of [false, true]) {
      await expect(writeOutputFile(ws.path('folder'), 'x', { force })).rejects.toMatchObject({ code: 'unsafe-output' });
    }
    expect(await names(ws.path('folder'))).toEqual([]);
  });

  it('refuses an output that is one of the inputs: same path, through a symlinked directory, or a hard link', async () => {
    const input = await ws.write('input.pdf', 'the input');
    await mkdir(ws.path('real'));
    const nested = await ws.write('real/nested.pdf', 'the nested input');
    await symlink(ws.path('real'), ws.path('alias'));
    await symlink(ws.dir, ws.path('self'));
    await link(input, ws.path('hard.pdf'));

    const cases: Array<[out: string, inputs: string[]]> = [
      [input, [input]],
      [ws.path('./real/../input.pdf'), [input]],
      [ws.path('self/input.pdf'), [input]],
      [input, [ws.path('self/input.pdf')]],
      [ws.path('alias/nested.pdf'), [nested]],
      [nested, [ws.path('alias/nested.pdf')]],
      [ws.path('hard.pdf'), [input]],
      [input, ['other.json', ws.path('hard.pdf')]],
    ];
    for (const [out, inputs] of cases) {
      for (const force of [false, true]) {
        await expect(writeOutputFile(out, 'replaced', { force, inputs }), `${out} force ${force}`).rejects.toMatchObject({ code: 'output-is-input' });
        await expect(checkOutputPath(out, { force, inputs })).rejects.toMatchObject({ code: 'output-is-input' });
      }
      await expect(writeToFreePath(out, 'replaced', { inputs })).rejects.toMatchObject({ code: 'output-is-input' });
      await expect(nextFreePath(out, { inputs })).rejects.toMatchObject({ code: 'output-is-input' });
    }
    expect(await readFile(input, 'utf8')).toBe('the input');
    expect(await readFile(nested, 'utf8')).toBe('the nested input');
    expect(await names()).toEqual(['alias', 'hard.pdf', 'input.pdf', 'real', 'self']);
    expect(await names(ws.path('real'))).toEqual(['nested.pdf']);

    // Another file beside the input is fine.
    await writeOutputFile(ws.path('self/output.pdf'), 'the output', { inputs: [input] });
    expect(await readFile(ws.path('output.pdf'), 'utf8')).toBe('the output');
  });
});

describe('numbered names', () => {
  it('numbers before the extension, keeping .signpacket.json whole', () => {
    expect(numberedPath('/tmp/x-signed.pdf', 1)).toBe('/tmp/x-signed.pdf');
    expect(numberedPath('/tmp/x-signed.pdf', 2)).toBe('/tmp/x-signed-2.pdf');
    expect(numberedPath('/tmp/x-signed.pdf', 11)).toBe('/tmp/x-signed-11.pdf');
    expect(numberedPath('/tmp/a.signpacket.json', 2)).toBe('/tmp/a-2.signpacket.json');
    expect(numberedPath('/tmp/a.b.signpacket.json', 3)).toBe('/tmp/a.b-3.signpacket.json');
    expect(numberedPath('/tmp/data.json', 2)).toBe('/tmp/data-2.json');
    expect(numberedPath('/tmp/noext', 2)).toBe('/tmp/noext-2');
  });

  it('writeToFreePath never replaces a file: it takes the next free name and returns it', async () => {
    const first = ws.path('x-signed.pdf');
    expect(await nextFreePath(first)).toBe(first);
    expect(await writeToFreePath(first, 'one')).toBe(first);
    expect(await nextFreePath(first)).toBe(ws.path('x-signed-2.pdf'));
    expect(await writeToFreePath(first, 'two')).toBe(ws.path('x-signed-2.pdf'));
    expect(await writeToFreePath(first, 'three')).toBe(ws.path('x-signed-3.pdf'));
    expect(await readFile(first, 'utf8')).toBe('one');
    expect(await readFile(ws.path('x-signed-2.pdf'), 'utf8')).toBe('two');
    expect(await readFile(ws.path('x-signed-3.pdf'), 'utf8')).toBe('three');
    for (const name of await names()) await expectPrivate(ws.path(name));

    const packet = ws.path('a.signpacket.json');
    expect(await writeToFreePath(packet, '{}')).toBe(packet);
    expect(await writeToFreePath(packet, '{"n":2}')).toBe(ws.path('a-2.signpacket.json'));
    expect(await readFile(packet, 'utf8')).toBe('{}');
    expect(await names()).toEqual(['a-2.signpacket.json', 'a.signpacket.json', 'x-signed-2.pdf', 'x-signed-3.pdf', 'x-signed.pdf']);
  });

  it('writers that race for one name each get their own file, and no temporary file is left', async () => {
    const wanted = ws.path('raced-signed.pdf');
    const contents = Array.from({ length: 8 }, (_, index) => `writer ${index}`);
    const paths = await Promise.all(contents.map((content) => writeToFreePath(wanted, content)));
    expect(new Set(paths).size).toBe(contents.length);
    expect([...paths].sort()).toEqual(await Promise.all((await names()).map((name) => ws.path(name))));
    expect(await names()).toEqual(['raced-signed-2.pdf', 'raced-signed-3.pdf', 'raced-signed-4.pdf', 'raced-signed-5.pdf', 'raced-signed-6.pdf', 'raced-signed-7.pdf', 'raced-signed-8.pdf', 'raced-signed.pdf']);
    // Every writer's bytes are in the file it was told about, whole.
    for (const [index, path] of paths.entries()) expect(await readFile(path, 'utf8')).toBe(contents[index]);
  });
});

describe('the commands that write files', () => {
  let pdf: Uint8Array;
  let pdfPath: string;
  let requestPath: string;

  beforeEach(async () => {
    pdf = await fixturePdf();
    pdfPath = await ws.write('fixture.pdf', pdf);
    requestPath = await ws.write('request.json', JSON.stringify(await requestFor(pdf)));
  });

  const untouched = async () => {
    expect(new Uint8Array(await readFile(pdfPath))).toEqual(pdf);
    expect(JSON.parse(await readFile(requestPath, 'utf8'))).toEqual(await requestFor(pdf));
  };

  it('packet and preview write private files and leave nothing else behind', async () => {
    expect((await runCli(['packet', pdfPath, requestPath])).code).toBe(0);
    await expectPrivate(ws.path('fixture.signpacket.json'));
    expect((await runCli(['preview', pdfPath, requestPath, '--out', ws.path('preview')])).code).toBe(0);
    await expectPrivate(ws.path('preview/page-1.png'));
    // A second preview replaces the image.
    expect((await runCli(['preview', pdfPath, requestPath, '--out', ws.path('preview'), '--scale', '1'])).code).toBe(0);
    await expectPrivate(ws.path('preview/page-1.png'));
    expect(await names(ws.path('preview'))).toEqual(['page-1.png']);
    expect(await names()).toEqual(['fixture.pdf', 'fixture.signpacket.json', 'preview', 'request.json']);
  });

  it('packet --force replaces the packet atomically', async () => {
    const out = await ws.write('fixture.signpacket.json', 'an older packet '.repeat(100_000));
    await chmod(out, 0o644);
    const result = await runCli(['packet', pdfPath, requestPath, '--force', '--json']);
    expect(result.code).toBe(0);
    const text = await readFile(out, 'utf8');
    expect(text).not.toContain('an older packet');
    expect(Buffer.byteLength(text)).toBe(result.json<{ bytes: number }>().bytes);
    expect(() => JSON.parse(text) as unknown).not.toThrow();
    await expectPrivate(out);
    expect(await names()).toEqual(['fixture.pdf', 'fixture.signpacket.json', 'request.json']);
  });

  it('packet refuses to write over an input: the same path, a symlinked directory, a hard link', async () => {
    await symlink(ws.dir, ws.path('self'));
    await link(pdfPath, ws.path('hard.pdf'));
    await link(requestPath, ws.path('hard.json'));
    for (const out of [pdfPath, requestPath, ws.path('self/fixture.pdf'), ws.path('self/request.json'), ws.path('hard.pdf'), ws.path('hard.json')]) {
      for (const force of [[], ['--force']]) {
        const result = await runCli(['packet', pdfPath, requestPath, '-o', out, ...force]);
        expect(result.code, out).toBe(1);
        expect(result.stderr, out).toContain('error [output-is-input]');
      }
    }
    await untouched();
    expect(await names()).toEqual(['fixture.pdf', 'hard.json', 'hard.pdf', 'request.json', 'self']);
  });

  it('packet refuses a symlink as its output', async () => {
    const target = await ws.write('target.txt', 'the link target');
    await symlink(target, ws.path('out.signpacket.json'));
    for (const force of [[], ['--force']]) {
      const result = await runCli(['packet', pdfPath, requestPath, '-o', ws.path('out.signpacket.json'), ...force, '--json']);
      expect(result.code).toBe(1);
      expect(result.json()).toMatchObject({ ok: false, error: { code: 'unsafe-output' } });
    }
    expect(await readFile(target, 'utf8')).toBe('the link target');
  });

  it('request refuses to write over an input before it starts a session or opens a browser', async () => {
    const webDir = await ws.webDir();
    await symlink(ws.dir, ws.path('self'));
    await link(pdfPath, ws.path('hard.pdf'));
    let opened = 0;
    for (const out of [pdfPath, requestPath, ws.path('self/fixture.pdf'), ws.path('hard.pdf')]) {
      for (const force of [[], ['--force']]) {
        const result = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, '-o', out, ...force], { openBrowser: () => void (opened += 1) });
        expect(result.code, out).toBe(1);
        expect(result.stderr, out).toContain('error [output-is-input]');
      }
    }
    expect(opened).toBe(0);
    await untouched();
  });

  it('request refuses a symlink as its output, and writes the signed PDF with mode 0600', async () => {
    const webDir = await ws.webDir();
    const target = await ws.write('target.txt', 'the link target');
    await symlink(target, ws.path('linked.pdf'));
    let opened = 0;
    for (const force of [[], ['--force']]) {
      const refused = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, '-o', ws.path('linked.pdf'), ...force], {
        openBrowser: () => void (opened += 1),
      });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('error [unsafe-output]');
    }
    expect(opened).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('the link target');

    // An existing, world-readable file is replaced by a private one with --force.
    const out = await ws.write('done.pdf', 'an older file');
    await chmod(out, 0o644);
    let signing: Promise<void> | undefined;
    const result = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir, '-o', out, '--force', '--json'], {
      openBrowser: (link) => {
        signing = signInBrowser(link).then((reply) => expect(reply.status).toBe(204));
        signing.catch(() => undefined);
      },
    });
    await signing;
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ ok: true, status: 'signed', path: out });
    expect((await readFile(out)).subarray(0, 5).toString()).toBe('%PDF-');
    await expectPrivate(out);
    expect(await names()).toEqual(['done.pdf', 'fixture.pdf', 'linked.pdf', 'request.json', 'secret.txt', 'target.txt', 'web']);

    // The default name, without --force, is private too.
    const plain = await runCli(['request', pdfPath, requestPath, '--web-dir', webDir], {
      openBrowser: (link) => {
        signing = signInBrowser(link).then((reply) => expect(reply.status).toBe(204));
        signing.catch(() => undefined);
      },
    });
    await signing;
    expect(plain.code).toBe(0);
    await expectPrivate(ws.path('fixture-signed.pdf'));
    expect((await stat(ws.path('fixture-signed.pdf'))).nlink).toBe(1);
  });
});
