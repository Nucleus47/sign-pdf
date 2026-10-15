# Sign request examples

These request files show common layouts for the CLI. Each request names the PDF by its SHA-256 hash. Tests validate the sample NDA request against the one committed sample PDF. They build synthetic anchor-only PDFs in code for the other examples; do not add PDF fixtures here.

- [`sample-nda.request.json`](sample-nda.request.json): fill existing AcroForm fields and place one signature by anchor.
- [`multi-signer.request.json`](multi-signer.request.json): assign two signature fields to two people in signing order.
- [`anchor-only.request.json`](anchor-only.request.json): place a checkbox and signature by text anchor on a PDF with no AcroForm fields.

The tests in `packages/cli/src/examples.test.ts` check each request against its PDF. Keep human signature and initials fields free of `value`.
