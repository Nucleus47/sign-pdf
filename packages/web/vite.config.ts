import { execFileSync } from 'node:child_process';
import { cpSync, createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { esbuildTargets } from './browserTargets.ts';
import { flattenForDemo } from './demoNda.ts';
import { derivedPort } from './ports.ts';

/**
 * `vite preview` serves the production build with the same security headers
 * the static host applies from public/_headers, so end-to-end tests run under
 * the real Content-Security-Policy.
 */
function headersForAllPaths(): Record<string, string> {
  const file = fileURLToPath(new URL('./public/_headers', import.meta.url));
  const headers: Record<string, string> = {};
  let inAllPaths = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!/^\s/.test(line)) {
      inAllPaths = line.trim() === '/*';
      continue;
    }
    if (!inAllPaths) continue;
    const match = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (match?.[1] && match[2]) headers[match[1]] = match[2].trim();
  }
  return headers;
}

/**
 * pdf.js loads fonts, CMaps, colour profiles and image decoders by fixed file
 * name at run time. They are served from /pdfjs/ on our own origin: copied
 * into the build, and read straight from node_modules by the dev server.
 */
function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  const folders = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
  // The scripting sandbox is never used: scripts inside a PDF are not run.
  const wanted = (file: string) => !/quickjs/.test(file);
  let outDir = 'dist';
  return {
    name: 'sign-pdf:pdfjs-assets',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const relative = normalize(decodeURIComponent((request.url ?? '').split('?')[0] ?? ''));
        const file = join(root, relative);
        const allowed = folders.some((folder) => file.startsWith(join(root, folder) + sep));
        if (!allowed || !wanted(file) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        if (file.endsWith('.wasm')) response.setHeader('Content-Type', 'application/wasm');
        createReadStream(file).pipe(response);
      });
    },
    closeBundle() {
      if (this.meta.watchMode) return;
      for (const folder of folders) {
        if (!existsSync(join(root, folder))) continue;
        cpSync(join(root, folder), join(outDir, 'pdfjs', folder), { recursive: true, filter: wanted });
      }
    },
  };
}

/**
 * The agent skill is served at /skill.md so an agent can read it by URL.
 * skills/sign-pdf/SKILL.md stays the one source; it is copied into the build.
 */
function agentSkill(): Plugin {
  const source = fileURLToPath(new URL('../../skills/sign-pdf/SKILL.md', import.meta.url));
  let outDir = 'dist';
  return {
    name: 'sign-pdf:agent-skill',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/skill.md', (_request, response) => {
        response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        createReadStream(source).pipe(response);
      });
    },
    closeBundle() {
      if (this.meta.watchMode) return;
      cpSync(source, join(outDir, 'skill.md'));
    },
  };
}

/**
 * The demo document for agents, served at /demo-nda.pdf: the sample NDA with
 * its form fields removed (demoNda.ts). It is made at build time, so no second
 * PDF is kept in the repository.
 */
function demoNda(): Plugin {
  const source = fileURLToPath(new URL('./public/sample-nda.pdf', import.meta.url));
  let outDir = 'dist';
  return {
    name: 'sign-pdf:demo-nda',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/demo-nda.pdf', (_request, response, next) => {
        flattenForDemo(readFileSync(source)).then((pdf) => {
          response.setHeader('Content-Type', 'application/pdf');
          response.end(pdf);
        }, next);
      });
    },
    async closeBundle() {
      if (this.meta.watchMode) return;
      writeFileSync(join(outDir, 'demo-nda.pdf'), await flattenForDemo(readFileSync(source)));
    },
  };
}

/**
 * The commit the app was built from, for error reports. APP_COMMIT names it
 * (deploy.yml passes the commit CI tested and checked out); else HEAD; else "unknown".
 * GITHUB_SHA is not used: in a workflow_run deploy it is not the commit that is built.
 */
export function appCommit(): string {
  const given = process.env.APP_COMMIT;
  if (given && /^[0-9a-f]{7,40}$/i.test(given)) return given.slice(0, 12);
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  plugins: [react(), pdfjsAssets(), agentSkill(), demoNda()],
  define: { __APP_COMMIT__: JSON.stringify(appCommit()) },
  server: { port: derivedPort(), strictPort: true },
  preview: { port: derivedPort(1), strictPort: true, headers: headersForAllPaths() },
  // The pdf.js worker is a module worker (src/pdf/pdfjs.ts).
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    // Derived from `browserslist` in package.json; docs/browser-support.md.
    target: esbuildTargets(),
    // pdf.js and the PDF writer are loaded on demand; their chunks are large by nature.
    chunkSizeWarningLimit: 1500,
  },
});
