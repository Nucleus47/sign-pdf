/**
 * WebMCP adapter: registers the browser agent API's tools with the browser's
 * model context, so an agent built into the browser can call them.
 *
 * The API surface follows the W3C WebML CG draft (webmachinelearning/webmcp)
 * and Chrome's docs (developer.chrome.com/docs/ai/webmcp):
 * `document.modelContext.registerTool(tool, { signal })`, unregistered by
 * aborting the signal. Older builds and the MCP-B polyfill put it on
 * `navigator.modelContext` and also offer `unregisterTool(name)`. The draft
 * changes, so this stays small and feature-detected: without the API it does
 * nothing.
 *
 * No `exposedTo`: the tools are for agents of this page's own origin only.
 */
import { BROWSER_TOOLS, toolInputJsonSchema, type BrowserToolName } from '@sign-pdf/core/tools';
import type { AgentApi, AgentResult } from './api.ts';

interface WebMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute(input: unknown): Promise<WebMcpResult>;
}

type WebMcpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface WebMcpResult {
  content: WebMcpContent[];
  structuredContent: AgentResult;
  isError?: boolean;
}

/** The part of a model context this adapter uses. */
export interface ModelContextLike {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): Promise<unknown> | unknown;
  unregisterTool?(name: string): unknown;
}

/** The browser's model context, if it has one: the spec's place first, then the older one. */
export function findModelContext(scope: { document?: unknown; navigator?: unknown } = globalThis): ModelContextLike | null {
  for (const host of [scope.document, scope.navigator]) {
    const context = (host as { modelContext?: Partial<ModelContextLike> } | undefined)?.modelContext;
    if (context && typeof context.registerTool === 'function') return context as ModelContextLike;
  }
  return null;
}

/**
 * The tool result as MCP shapes it: the JSON as text, render_preview's PNGs as
 * image blocks (taken out of the JSON, so they are sent once), the JSON again
 * as structuredContent.
 */
export function toWebMcpResult(result: AgentResult): WebMcpResult {
  const images: WebMcpContent[] = [];
  let structured = result;
  if (Array.isArray(result['images'])) {
    const pages = (result['images'] as Array<Record<string, unknown>>).map(({ png_base64, ...meta }) => {
      if (typeof png_base64 === 'string') images.push({ type: 'image', data: png_base64, mimeType: 'image/png' });
      return meta;
    });
    structured = {
      ...result,
      images: pages,
      how_to_read: 'pixel = origin + point * scale. The images follow this text in the same order as "images".',
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }, ...images],
    structuredContent: structured,
    ...('error' in result ? { isError: true } : {}),
  };
}

/** Chrome before 155 passes the input as a JSON string. */
function inputObject(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

/**
 * Register every browser tool. Returns the function that unregisters them all;
 * the prepare view calls it when it unmounts, so no tool exists in the sign view.
 */
export function registerWebMcpTools(api: AgentApi, context: ModelContextLike | null = findModelContext()): () => void {
  if (!context) return () => {};
  const controller = new AbortController();
  const names = Object.keys(BROWSER_TOOLS) as BrowserToolName[];
  for (const name of names) {
    const tool = BROWSER_TOOLS[name];
    const registration: WebMcpTool = {
      name,
      title: tool.title,
      description: tool.description,
      inputSchema: toolInputJsonSchema(tool),
      annotations: { readOnlyHint: tool.annotations.readOnlyHint, untrustedContentHint: tool.annotations.untrustedContentHint },
      execute: async (input) => toWebMcpResult(await api[name](inputObject(input))),
    };
    try {
      // The spec rejects the promise with the abort reason when the tool is unregistered later.
      void Promise.resolve(context.registerTool(registration, { signal: controller.signal })).catch(() => {});
    } catch {
      // A browser that refuses one tool (for example a policy that blocks `tools`) gets none of it as an error on the page.
    }
  }
  return () => {
    controller.abort();
    if (typeof context.unregisterTool === 'function') {
      for (const name of names) {
        try {
          context.unregisterTool(name);
        } catch {
          // Already gone.
        }
      }
    }
  };
}
