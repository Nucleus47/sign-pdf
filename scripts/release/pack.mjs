#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ALLOWED_PDFS = new Set(['sample-nda.pdf']);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(await readFile(join(root, 'scripts/release/packages.json'), 'utf8'));
const outputArg = process.argv.indexOf('--out');
const out = outputArg >= 0 ? resolve(process.argv[outputArg + 1] ?? '') : await mkdtemp(join(tmpdir(), 'sign-pdf-release-'));
if (outputArg >= 0 && !process.argv[outputArg + 1]) throw new Error('pack: --out needs a directory');
await mkdir(out, { recursive: true });

async function run(command, args, cwd = root) {
  const { stdout, stderr } = await execFileAsync(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  if (stderr.trim()) process.stderr.write(stderr);
  return stdout;
}

async function resolvedDependencyVersion(packageRoot, name) {
  const packagePath = await realpath(join(packageRoot, 'node_modules', ...name.split('/')));
  const manifest = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
  if (manifest.name !== name || typeof manifest.version !== 'string') throw new Error(`pack: invalid installed package manifest for ${name}`);
  return manifest.version;
}

async function stagePackage(entry) {
  const workspace = join(root, entry.workspace);
  const source = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
  if (source.private !== true) throw new Error(`pack: ${entry.workspace}/package.json must stay private`);
  if (source.name !== entry.name) throw new Error(`pack: configured package ${entry.name} does not match ${source.name}`);

  const stage = await mkdtemp(join(tmpdir(), 'sign-pdf-package-'));
  stages.push(stage);
  const dependencies = {};
  for (const name of Object.keys(source.dependencies ?? {})) {
    dependencies[name] = await resolvedDependencyVersion(workspace, name);
  }
  const files = ['dist', 'web/dist', 'README.md'];
  if (entry.kind === 'cli') files.push('examples');
  await cp(join(workspace, 'dist'), join(stage, 'dist'), { recursive: true });
  // Ship only the PDFs in this allowlist. Vite copies everything in public/, including
  // local files that git ignores, such as signed PDFs from a manual test.
  const webDist = join(root, 'packages/web/dist');
  await cp(webDist, join(stage, 'web/dist'), {
    recursive: true,
    filter: (path) => !path.toLowerCase().endsWith('.pdf') || ALLOWED_PDFS.has(relative(webDist, path)),
  });
  await cp(join(workspace, 'README.md'), join(stage, 'README.md'));
  if (entry.kind === 'cli') await cp(join(workspace, 'examples'), join(stage, 'examples'), { recursive: true });
  await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  files.push('LICENSE');

  const publishManifest = {
    name: entry.name,
    version: source.version,
    private: false,
    type: 'module',
    license: source.license ?? 'MIT',
    description: source.description,
    homepage: 'https://github.com/Nucleus47/sign-pdf#readme',
    // npm provenance (`npm publish --provenance`) needs the source repository.
    repository: { type: 'git', url: 'git+https://github.com/Nucleus47/sign-pdf.git' },
    engines: { node: '>=22' },
    bin: source.bin,
    files,
    dependencies,
    publishConfig: { access: 'public' },
  };
  await writeFile(join(stage, 'package.json'), `${JSON.stringify(publishManifest, null, 2)}\n`);
  return stage;
}

await run('pnpm', ['--filter', '@sign-pdf/web', 'build']);
for (const entry of config.packages) await run('pnpm', ['--filter', entry.name, 'build']);

const summaries = [];
const stages = [];
try {
  for (const entry of config.packages) {
    const stage = await stagePackage(entry);
    const packed = JSON.parse(await run('npm', ['pack', '--json', '--pack-destination', out], stage))[0];
    summaries.push({
      name: entry.name,
      version: packed.version,
      filename: packed.filename,
      packedBytes: packed.size,
      unpackedBytes: packed.unpackedSize,
      files: packed.entryCount,
      bin: JSON.parse(await readFile(join(stages.at(-1), 'package.json'), 'utf8')).bin,
    });
  }
} finally {
  await Promise.all(stages.map((stage) => rm(stage, { recursive: true, force: true })));
}

await writeFile(join(out, 'release-summary.json'), `${JSON.stringify({ output: out, packages: summaries }, null, 2)}\n`);
for (const item of summaries) {
  console.log(`${item.name}@${item.version}: ${item.filename} packed=${item.packedBytes} bytes unpacked=${item.unpackedBytes} bytes (${item.files} files)`);
  if (item.unpackedBytes >= 25 * 1024 * 1024) throw new Error(`pack: ${item.name} exceeds the 25 MB unpacked target`);
}
console.log(`Artifacts: ${out}`);
