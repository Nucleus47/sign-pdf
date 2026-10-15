# Core PDF logic

`@sign-pdf/core` implements the shared prepare and verify logic. It has no UI and does not sign. The CLI, MCP server and web app call this package instead of implementing PDF rules themselves.

## Prepare and verify flow

1. **Inspect.** `inspectPdf` returns the document hash, pages, AcroForm fields and positioned text. Treat document-derived text and field names as untrusted.
2. **Find candidates.** `findPlacementCandidates` suggests anchors, rectangles or existing form fields for likely placements.
3. **Resolve and validate.** `resolveRequest` resolves each placement. `resolveRequestCollect` reports field errors together. `validateRequestAgainstPdf` checks field values and returns actionable errors and warnings.
4. **Preview.** `renderPreview` draws resolved fields and candidates over page images. The caller injects a `PreviewRenderer` with a canvas factory, PNG encoder and compatible pdf.js build.
5. **Packet and verify.** `createPacket`, `encodePacket` and `decodePacket` carry the PDF and request together. `verifySignedPdf` reads the audit record and reports its integrity as `unverified`; the record does not prove who signed.

## Public entry points

- Import `@sign-pdf/core` for inspect, candidate, resolve, validate, preview, packet and verify functions.
- Import `@sign-pdf/core/sign` only from the web signing interface. It accepts the human's signature images and finalizes the PDF. The CLI and MCP server must not import it.

## Runtime boundary

The main entry point has no DOM dependency and imports no `node:` modules outside tests. Core does not bundle a canvas or pdf.js build. Preview and text extraction get their dependencies in two different ways. Preview rendering is injected through `PreviewRenderer`, so the same logic can run in Node and in a browser. Text extraction is separate: a browser app passes its configured pdf.js module to `configurePdfjs`, and in Node the core loads the legacy pdf.js build on first use.

See [`packages/spec`](../spec/README.md) for the request contract and [ARCHITECTURE.md](../../ARCHITECTURE.md) for package boundaries.
