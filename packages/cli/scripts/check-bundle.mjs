// Fails the build if a bundle contains core's signing step. Only a human signs:
// the CLI and the MCP server must not ship the code that writes signatures.
//
// Two checks. File and function names catch an unminified bundle. The marker
// string that core keeps beside the signing code catches every bundle, minified
// or not: names can be rewritten, a string constant in use cannot.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = process.argv[2];
if (!file) {
  console.error('usage: node check-bundle.mjs <bundle.js>');
  process.exit(1);
}

// The marker is read from core's source, not imported: this script must not load the signing code.
const signSource = fileURLToPath(new URL('../../core/src/sign.ts', import.meta.url));
let marker;
try {
  marker = /^export const SIGNING_CODE_MARKER = '([^'\\\n]+)';/m.exec(readFileSync(signSource, 'utf8'))?.[1];
} catch (error) {
  console.error(`check-bundle: cannot read ${signSource}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (!marker || marker.length < 12) {
  console.error(
    `check-bundle: cannot find "export const SIGNING_CODE_MARKER = '...'" in ${signSource}. ` +
      'Without the marker a bundle cannot be checked. Restore the constant, or update this script.',
  );
  process.exit(1);
}

let text;
try {
  text = readFileSync(file, 'utf8');
} catch (error) {
  console.error(`check-bundle: cannot read the bundle ${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const found = ['core/src/write.ts', 'core/src/sign.ts', 'finalizeDocument', marker].filter((needle) => text.includes(needle));
if (found.length > 0) {
  console.error(`${file} contains core's signing step (${found.join(', ')}). Remove the import of @sign-pdf/core/sign.`);
  process.exit(1);
}
