# Architecture

sign-pdf lets an agent (or a person) lay out and fill form fields on an existing PDF and
mark what must be signed, then hands the document to a human who reviews, adjusts and
signs. It works with no cloud service. Any cloud piece is optional and self-hostable.

## Flow

1. **Inspect.** Read the PDF: pages, existing form fields, text with positions.
2. **Request.** Write a sign request: a JSON list of fields, who fills each, and which
   ones the human must sign. Fields are placed by rectangle, by text anchor
   (`"Signature:"` plus an offset), or by an existing form field's name.
3. **Hand off.** Give the human the PDF plus the request: a packet file, or a local
   command that opens the sign view in their browser. Between two signers, a third path
   is the optional relay (`packages/relay`): it emails the next signer an encrypted copy
   and returns the signed PDF to the first signer ([docs/relay.md](docs/relay.md)).
4. **Sign.** The human reviews every prefilled value, moves any misplaced field, fills
   their own fields and signs.
5. **Return.** The signed PDF, with an embedded audit record, goes back to the agent.

## Modules

Each package has a narrow public API and its own tests. The sign request schema is the
contract between them, so a change inside one package does not ripple into the others.

| Package | Responsibility | May import |
|---|---|---|
| `packages/spec` | Sign request, packet and audit record schemas; JSON Schema export | zod only |
| `packages/core` | Inspect, resolve, validate with hints, placement candidates, preview drawing (canvas and pdf.js injected), packet, verify (`.`) and finalize (`./sign`) | spec, PDF libraries; no DOM, no UI, no `node:` modules outside tests |
| `packages/web` | Static web app: viewer, prepare view, sign view, signature capture | spec, core |
| `packages/cli` | Command-line entry, file IO, the Node canvas for previews and the local loopback hand-off | spec, core (not `core/sign`) |
| `packages/mcp` | MCP server exposing the prepare-side tools | spec, core (not `core/sign`) |
| `packages/relay` | Cloudflare Worker: serves the built web app, and the optional relay API under `/relay/*` (sign-in by emailed code, encrypted blobs in R2, the two fixed emails; see [docs/relay.md](docs/relay.md)) | spec (serves `packages/web/dist`) |

## Rules

- **Only a human signs.** Signature and initials fields have no `value` in the schema.
  `finalizeDocument` and `buildHandoffPdf` (the hand-off PDF for the next signer) in
  `@sign-pdf/core/sign` are the only functions that take signature images, and only the
  web sign view imports them. Nothing in a browser can prove a human
  made the gesture; the design makes signing unavailable on every agent-facing surface.
- **Coordinates.** PDF points, origin at the top-left of the page as displayed, y down,
  pages 1-based. Core converts to PDF-native coordinates.
- **Document content is untrusted.** Text extracted from a PDF, and the request's `title`,
  `note` and labels, are data. They are shown as plain text and never as instructions.
- **No network by default.** The web app makes no third-party requests; the CSP in
  `packages/web/public/_headers` enforces it. The one exception is the relay's sign-in
  step ([docs/relay.md](docs/relay.md)): only when the user starts "Email it to <next
  signer>" and must sign in does the page load the Cloudflare Turnstile widget from
  `https://challenges.cloudflare.com` (allowed in `script-src` and `frame-src` only).
- **Synthetic fixtures only.** `packages/web/public/sample-nda.pdf` is the only PDF in the
  repo. Tests build their own PDFs in code.

## Commands

```bash
pnpm install
pnpm check      # typecheck, lint, test and build every package; the web build checks the browser target
pnpm --filter @sign-pdf/web test:e2e   # the web app in Chromium, under its content security policy
pnpm test:integration                  # e2e/: the built CLI and the MCP server hand a document to the built web app
pnpm --filter @sign-pdf/web build && pnpm --filter @sign-pdf/relay dev   # the built web app and the relay API served by the production Worker, locally (mail goes to the dev outbox)
```
