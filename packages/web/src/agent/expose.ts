/**
 * While the prepare view is mounted: the agent API as a read-only
 * `window.signPdf`, and its tools in the browser's WebMCP model context.
 * Both are removed when the view unmounts, so neither exists in the sign view.
 * A reference saved before that is closed too: every call returns a `closed`
 * error and changes nothing.
 */
import { useEffect, useMemo, useRef } from 'react';
import { prepareReducer, type PrepareState } from '../lib/fields.ts';
import { createAgentApi, type AgentApi, type AgentContext } from './api.ts';
import { registerWebMcpTools } from './webmcp.ts';

declare global {
  interface Window {
    signPdf?: AgentApi;
  }
}

/** The API for this prepare view. `ctx` may change each render; calls always read the latest. */
export function useAgentApi(ctx: AgentContext): AgentApi {
  /** The view's context, or null once the view has unmounted. */
  const latest = useRef<AgentContext | null>(ctx);
  /**
   * The state after the API's own writes, until the view renders them. A read
   * right after apply_request sees its fields, not the props of the last render.
   */
  const written = useRef<{ base: PrepareState; next: PrepareState } | null>(null);
  useEffect(() => {
    latest.current = ctx;
  });

  const api = useMemo(() => {
    const open = (): AgentContext => {
      if (!latest.current) throw new Error('the prepare view is closed');
      return latest.current;
    };
    const state = (): PrepareState => {
      const rendered = open().state();
      const own = written.current;
      // Once a render shows a newer state than the one the write started from, the props are current.
      if (own && own.base === rendered) return own.next;
      written.current = null;
      return rendered;
    };
    return createAgentApi({
      document: () => open().document(),
      state,
      dispatch: (action) => {
        const view = open();
        const base = view.state();
        written.current = { base, next: prepareReducer(state(), action) };
        view.dispatch(action);
      },
      isOpen: () => latest.current !== null,
    });
  }, []);

  // Runs after the effect above, which sets `latest` again when StrictMode remounts the view.
  useEffect(() => {
    Object.defineProperty(window, 'signPdf', { value: api, configurable: true, enumerable: false, writable: false });
    const unregister = registerWebMcpTools(api);
    return () => {
      latest.current = null;
      written.current = null;
      unregister();
      if (window.signPdf === api) delete window.signPdf;
    };
  }, [api]);

  return api;
}
