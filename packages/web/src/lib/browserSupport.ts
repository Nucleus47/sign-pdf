/**
 * Which browser features the app relies on, and which of them this browser has.
 *
 * `startupFeatures` is probed when this module is first evaluated. main.tsx
 * imports it first, so the probe sees the browser as it is, before any shim
 * (such as ../pdf/streamIterator.ts) fills a gap.
 */

interface FeatureRule {
  /** Without it, opening, reading or signing a PDF fails. */
  required: boolean;
  /** The app or pdf.js supplies it when the browser does not. */
  shimmed: boolean;
  present: (scope: ProbeScope) => boolean;
}

/** The parts of the global scope the probe reads. A test passes its own. */
export interface ProbeScope {
  ReadableStream?: unknown;
  Map?: unknown;
  DecompressionStream?: unknown;
  OffscreenCanvas?: unknown;
  WebAssembly?: unknown;
  structuredClone?: unknown;
  crypto?: { subtle?: unknown } | undefined;
  navigator?: { clipboard?: { writeText?: unknown } | undefined } | undefined;
}

const isFunction = (value: unknown): boolean => typeof value === 'function';
const protoOf = (value: unknown): Record<PropertyKey, unknown> | undefined =>
  typeof value === 'function' ? (value as { prototype?: Record<PropertyKey, unknown> }).prototype : undefined;

export const FEATURES = {
  // pdf.js reads page text with `for await` over a stream: ../pdf/streamIterator.ts.
  'ReadableStream async iteration': {
    required: true,
    shimmed: true,
    present: (scope) => isFunction(protoOf(scope.ReadableStream)?.[Symbol.asyncIterator]),
  },
  // The pdf.js legacy build brings its own copy.
  'Map.prototype.getOrInsertComputed': {
    required: true,
    shimmed: true,
    present: (scope) => isFunction(protoOf(scope.Map)?.getOrInsertComputed),
  },
  // pdf.js decodes some streams with it, and has a slower path without it.
  DecompressionStream: { required: false, shimmed: false, present: (scope) => isFunction(scope.DecompressionStream) },
  OffscreenCanvas: { required: false, shimmed: false, present: (scope) => isFunction(scope.OffscreenCanvas) },
  WebAssembly: { required: false, shimmed: false, present: (scope) => typeof scope.WebAssembly === 'object' && scope.WebAssembly !== null },
  // pdf.js copies data between the page and its worker with it.
  structuredClone: { required: true, shimmed: false, present: (scope) => isFunction(scope.structuredClone) },
  // The SHA-256 fingerprint of every PDF. Present only on https or localhost.
  'crypto.subtle': { required: true, shimmed: false, present: (scope) => typeof scope.crypto?.subtle === 'object' && scope.crypto.subtle !== null },
  // "Copy details" has a fallback without it.
  'navigator.clipboard': { required: false, shimmed: false, present: (scope) => isFunction(scope.navigator?.clipboard?.writeText) },
} satisfies Record<string, FeatureRule>;

export type FeatureName = keyof typeof FEATURES;
export type Features = Readonly<Record<FeatureName, boolean>>;

const NAMES = Object.keys(FEATURES) as FeatureName[];

export function probeFeatures(scope: ProbeScope = globalThis as ProbeScope): Features {
  const found = {} as Record<FeatureName, boolean>;
  for (const name of NAMES) {
    let present = false;
    try {
      present = FEATURES[name].present(scope);
    } catch {
      present = false;
    }
    found[name] = present;
  }
  return found;
}

/** Features the app cannot work without that are missing and that nothing supplies. */
export function requiredMissing(features: Features): FeatureName[] {
  return NAMES.filter((name) => FEATURES[name].required && !FEATURES[name].shimmed && !features[name]);
}

/** This browser before any shim ran. */
export const startupFeatures: Features = probeFeatures();
