/**
 * The browser target, declared once as `browserslist` in package.json, turned
 * into the esbuild targets Vite builds for (vite.config.ts). es-check reads the
 * same declaration (scripts/check-bundle.mjs). See docs/browser-support.md.
 */
import { fileURLToPath } from 'node:url';
import browserslist from 'browserslist';

// browserslist name -> esbuild name. An unknown name fails the build rather than being skipped.
const esbuildNames: Record<string, string> = {
  chrome: 'chrome',
  edge: 'edge',
  firefox: 'firefox',
  safari: 'safari',
  ios_saf: 'ios',
};

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The oldest version of each browser, as esbuild targets such as "safari16.4". */
export function esbuildTargets(queries?: string | readonly string[]): string[] {
  const path = fileURLToPath(new URL('.', import.meta.url));
  const oldest = new Map<string, string>();
  for (const entry of browserslist(queries, { path })) {
    const [name = '', range = ''] = entry.split(' ');
    const esbuildName = esbuildNames[name];
    if (!esbuildName) throw new Error(`browserTargets: no esbuild target for "${entry}"; add it to esbuildNames.`);
    // A range such as "16.6-16.7" starts at its first version.
    const version = range.split('-')[0] ?? range;
    if (!/^\d+(\.\d+)*$/.test(version)) throw new Error(`browserTargets: no numeric version in "${entry}".`);
    const current = oldest.get(esbuildName);
    if (current === undefined || compareVersions(version, current) < 0) oldest.set(esbuildName, version);
  }
  return [...oldest].map(([name, version]) => `${name}${version}`).sort();
}
