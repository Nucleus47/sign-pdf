/**
 * The Node side of the preview: loads the native canvas and the legacy pdf.js
 * build, then lets core's `renderPreview` draw. Core does the drawing, so the
 * CLI, the MCP server and the web app produce the same images.
 *
 * pdf.js and the native canvas are loaded on first use, so every other command
 * works when the canvas cannot be loaded.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  SignPdfError,
  checkPreviewOptions,
  renderPreview as renderPreviewWith,
  type CanvasLike,
  type PdfjsRenderModule,
  type PreviewLayout,
  type PreviewOptions,
  type PreviewPage,
  type PreviewRenderer,
} from '@sign-pdf/core';
import { CliError } from './errors.ts';

interface NativeCanvas extends CanvasLike {
  encode(format: 'png'): Promise<Uint8Array>;
}

// The cast in loadRenderer narrows the module to this part of its API.
interface CanvasModule {
  createCanvas(width: number, height: number): NativeCanvas;
  GlobalFonts: { registerFromPath(path: string, alias?: string): unknown };
}

const LABEL_FONT = 'SignPdfPreview';
let renderer: Promise<PreviewRenderer> | undefined;

async function loadRenderer(): Promise<PreviewRenderer> {
  let canvas: CanvasModule;
  try {
    canvas = (await import('@napi-rs/canvas')) as unknown as CanvasModule;
    canvas.createCanvas(1, 1).getContext('2d');
  } catch (error) {
    throw new CliError(
      'preview-unavailable',
      `The preview needs the native canvas package "@napi-rs/canvas", which could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      'Reinstall the dependencies on this machine (pnpm install). Every other command works without it.',
    );
  }
  const require = createRequire(import.meta.url);
  const pdfjsDir = `${dirname(require.resolve('pdfjs-dist/package.json'))}/`;
  // pdf.js ships Liberation Sans. Registering it makes the labels render on
  // machines that have no system fonts, such as minimal containers.
  canvas.GlobalFonts.registerFromPath(join(pdfjsDir, 'standard_fonts', 'LiberationSans-Regular.ttf'), LABEL_FONT);
  // The cast narrows pdf.js to the part of its API core declares.
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsRenderModule;
  return {
    createCanvas: (width, height) => canvas.createCanvas(width, height),
    // Only canvases made by createCanvas above reach here.
    encodePng: (made) => (made as NativeCanvas).encode('png'),
    pdfjs,
    documentOptions: {
      useSystemFonts: false,
      standardFontDataUrl: `${pdfjsDir}standard_fonts/`,
      cMapUrl: `${pdfjsDir}cmaps/`,
      cMapPacked: true,
      wasmUrl: `${pdfjsDir}wasm/`,
      iccUrl: `${pdfjsDir}iccs/`,
    },
    labelFont: LABEL_FONT,
  };
}

function getRenderer(): Promise<PreviewRenderer> {
  renderer ??= loadRenderer().catch((error: unknown) => {
    renderer = undefined;
    throw error;
  });
  return renderer;
}

/** A bad scale or page is a usage error in the CLI and the MCP server. */
function asUsage(error: unknown): unknown {
  return error instanceof SignPdfError && error.code === 'invalid-argument' ? new CliError('usage', error.message) : error;
}

/** Parse a page list such as `1,3-5`. */
export function parsePageList(text: string): number[] {
  const pages = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    const first = match ? Number(match[1]) : 0;
    const last = match?.[2] !== undefined ? Number(match[2]) : first;
    if (!match || first < 1 || last < first || last - first > 10_000) {
      throw new CliError('usage', `Invalid page list ${JSON.stringify(text)}. Use numbers and ranges, such as 1,3-5.`);
    }
    for (let page = first; page <= last; page++) pages.add(page);
  }
  return [...pages].sort((p, q) => p - q);
}

/**
 * Render the chosen pages with every resolved field, and any candidate marks,
 * drawn on them. The options are checked before the canvas is loaded.
 */
export async function renderPreview(
  pdf: Uint8Array,
  resolved: PreviewLayout,
  options: PreviewOptions = {},
): Promise<PreviewPage[]> {
  try {
    checkPreviewOptions(resolved, options);
    return await renderPreviewWith(pdf, resolved, await getRenderer(), options);
  } catch (error) {
    throw asUsage(error);
  }
}
