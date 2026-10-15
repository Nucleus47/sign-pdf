/**
 * Lints the app source against the browser target in package.json (`browserslist`):
 * eslint-plugin-compat reports web APIs the target lacks. It does not see new methods
 * on built-ins (Map.prototype.getOrInsertComputed) or for-await over a ReadableStream:
 * the TypeScript lib (tsconfig.json) and scripts/check-bundle.mjs cover those.
 * See docs/browser-support.md.
 */
import compat from 'eslint-plugin-compat';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
    // react-hooks is registered so the source's existing disable comments resolve; its rules are not run here.
    plugins: { compat, 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'compat/compat': 'error' },
  },
];
