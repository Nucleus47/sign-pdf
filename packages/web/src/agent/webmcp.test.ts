import { BROWSER_TOOLS, BROWSER_TOOL_RULE, BROWSER_WORKFLOW } from '@sign-pdf/core/tools';
import { describe, expect, it, vi } from 'vitest';
import type { AgentApi } from './api.ts';
import { findModelContext, registerWebMcpTools, toWebMcpResult, type ModelContextLike } from './webmcp.ts';

type Registered = Parameters<ModelContextLike['registerTool']>[0];

/** A stub model context in the spec's shape: registerTool with an AbortSignal that unregisters. */
function stubContext() {
  const tools = new Map<string, Registered>();
  const context: ModelContextLike = {
    registerTool: vi.fn((tool: Registered, options?: { signal?: AbortSignal }) => {
      if (tools.has(tool.name)) return Promise.reject(new DOMException('duplicate', 'InvalidStateError'));
      tools.set(tool.name, tool);
      options?.signal?.addEventListener('abort', () => tools.delete(tool.name));
      return Promise.resolve();
    }),
  };
  return { context, tools };
}

function fakeApi(): AgentApi {
  const api: Record<string, unknown> = { workflow: '', tools: Object.keys(BROWSER_TOOLS) };
  for (const name of Object.keys(BROWSER_TOOLS)) api[name] = vi.fn((input?: unknown) => Promise.resolve({ ok: true, called: name, input }));
  return api as AgentApi;
}

describe('findModelContext', () => {
  it('prefers document.modelContext, falls back to navigator.modelContext, else null', () => {
    const { context } = stubContext();
    expect(findModelContext({ document: { modelContext: context }, navigator: {} })).toBe(context);
    expect(findModelContext({ document: {}, navigator: { modelContext: context } })).toBe(context);
    expect(findModelContext({ document: {}, navigator: {} })).toBeNull();
    expect(findModelContext({ document: { modelContext: {} } })).toBeNull();
  });
});

describe('registerWebMcpTools', () => {
  it('registers every catalog tool with its schema and hints, and removes them all on cleanup', async () => {
    const { context, tools } = stubContext();
    const unregister = registerWebMcpTools(fakeApi(), context);
    expect([...tools.keys()].sort()).toEqual(Object.keys(BROWSER_TOOLS).sort());
    const preview = tools.get('render_preview');
    expect(preview?.inputSchema).toMatchObject({ type: 'object', properties: { mark_candidates: { type: 'boolean' } } });
    expect(preview?.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    expect(tools.get('apply_request')?.annotations.readOnlyHint).toBe(false);
    // No tool can sign: nothing in the catalog is named for it, and every description states the rule and points to /skill.md.
    expect([...tools.keys()].some((name) => /sign(?!_)|consent|initial/.test(name))).toBe(false);
    for (const tool of tools.values()) {
      expect(tool.description).toContain(BROWSER_TOOL_RULE);
    }
    expect(BROWSER_WORKFLOW).toContain(BROWSER_TOOL_RULE);
    unregister();
    expect(tools.size).toBe(0);
  });

  it('calls the API with an object, or with the JSON string older Chrome passes', async () => {
    const { context, tools } = stubContext();
    const api = fakeApi();
    registerWebMcpTools(api, context);
    const result = await tools.get('find_candidates')?.execute({ max: 3 });
    expect(api.find_candidates).toHaveBeenCalledWith({ max: 3 });
    expect(result?.structuredContent).toMatchObject({ called: 'find_candidates' });
    await tools.get('find_candidates')?.execute('{"max":4}');
    expect(api.find_candidates).toHaveBeenLastCalledWith({ max: 4 });
  });

  it('also calls the legacy unregisterTool when the context has it', () => {
    const { context } = stubContext();
    const unregisterTool = vi.fn();
    registerWebMcpTools(fakeApi(), { ...context, unregisterTool })();
    expect(unregisterTool).toHaveBeenCalledTimes(Object.keys(BROWSER_TOOLS).length);
  });

  it('does nothing without a model context', () => {
    expect(() => registerWebMcpTools(fakeApi(), null)()).not.toThrow();
  });
});

describe('toWebMcpResult', () => {
  it('moves preview PNGs into image blocks and marks errors', () => {
    const out = toWebMcpResult({ ok: true, images: [{ page: 1, png_base64: 'AAAA' }] });
    expect(out.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    expect(JSON.stringify(out.structuredContent)).not.toContain('AAAA');
    expect(out.isError).toBeUndefined();
    expect(toWebMcpResult({ error: { code: 'usage', message: 'x' } }).isError).toBe(true);
  });
});
