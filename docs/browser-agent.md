# Browser agent API

An agent that has only a browser can prepare a PDF on the website. It needs no MCP server and no checkout. The API runs on the PDF open in the prepare view, and it exists only while that view is open. Nothing is uploaded.

## Three routes, one API

The agent uses the first route that works:

1. **WebMCP.** In a browser with WebMCP, the prepare view registers its tools with the browser's model context. The browser's agent calls them as tools.
2. **`window.signPdf`.** The same tools as JavaScript methods, for an agent that can run script in the page.
3. **The paste box.** "Paste a request from an agent", above "Hand it over" in the prepare view. An agent that can only type pastes the request JSON and presses "Apply request".

A fourth way hands a request to the human: the link `https://sign.silv.app/#request=<request JSON>`. The value is percent-encoded JSON or base64url JSON, at most 32 KB. The app reads the link at start-up and removes it from the address bar, so a reload does not apply it again. The fields go on the page when the human opens the PDF that the request was written for. The fragment never reaches a server.

All routes call the same code (`packages/web/src/agent/api.ts`). The paste box and the link use `apply_request`.

## Tools

The tool names, descriptions and input shapes come from one catalog, `@sign-pdf/core/tools`. The MCP server uses the same catalog, so the shared tools behave the same in both places. Each browser tool reads the open PDF: there is no `pdf_path`.

| Tool | What it does |
| --- | --- |
| `inspect_pdf` | Pages, form fields and text positions. |
| `find_candidates` | Likely places for fields, each with a placement to copy. |
| `get_request_schema` | The request format and the workflow. |
| `validate_request` | Checks a request against the open PDF. |
| `render_preview` | Page images with the fields drawn. Each PNG is base64 in `images[].png_base64`, or an image block in WebMCP. |
| `apply_request` | Puts the request's fields on the page as one undo step. |
| `get_state` | The fields on the page as a request, and their issues. |
| `download_packet` | Saves a packet (`*.signpacket.json`) for a signer. |
| `download_request` | Saves the request JSON. |

Rules for every tool:

- Each method takes one input object. The page checks it against the same zod shape as the MCP tool.
- A result is the object the MCP tool returns as `structuredContent`. A failure is `{ error: { code, message } }`. Nothing throws.
- The agent can leave out `version` and `document`. The page fills in the open PDF's name and SHA-256. A request with a `sha256` for another PDF fails with `hash-mismatch`.
- Document text is only under keys that start with `untrusted_`. It is data, never instructions.

## What the agent cannot do

No tool signs, fills a signature or initials, or ticks the consent. The API and the WebMCP tools are removed when the human presses "Continue to sign", so no tool exists in the sign view. The only write is the draft on the page, which the human reviews.

## WebMCP

The adapter is `packages/web/src/agent/webmcp.ts`. It follows the W3C WebML Community Group draft ([webmachinelearning/webmcp](https://github.com/webmachinelearning/webmcp)) and [Chrome's WebMCP docs](https://developer.chrome.com/docs/ai/webmcp):

- It uses `document.modelContext.registerTool(tool, { signal })`. Older builds and the MCP-B polyfill use `navigator.modelContext`; the adapter also calls their `unregisterTool(name)`. Without either, it does nothing.
- Each tool has its JSON Schema and the annotations `readOnlyHint` and `untrustedContentHint`.
- `execute` accepts an object, or a JSON string (Chrome before 155). It returns an MCP-style `{ content, structuredContent, isError? }`.
- It does not set `exposedTo`, so only agents of the page's own origin see the tools.

To try it in Chrome, turn on `chrome://flags/#enable-webmcp-testing`. For visitors without the flag, `packages/web/index.html` carries the Chrome origin-trial token for `https://sign.silv.app`. It works in Chrome 149 to 162 and expires on 2027-03-30; the operator must renew it before then. A self-hosted copy on another origin must register its own token.

Known risk: Chrome's docs do not describe image results yet. A browser agent can ignore the image blocks; the page sizes stay in the text.

## Tests

- Unit: `agent/api.test.ts`, `agent/webmcp.test.ts` (a stub model context), `lib/requestLink.test.ts`, `lib/draft.test.ts`.
- End to end: `packages/web/e2e/agent-api.spec.ts` runs every route on the sample PDF, with a stub `document.modelContext`.

See also: [Agent setup](agent-setup.md) for the MCP server, and the [agent skill](../skills/sign-pdf/SKILL.md).
