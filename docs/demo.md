# Agent demo

When a user asks their agent for a demo, the agent places and fills fields on a standard
NDA that has no form fields. The demo stops before signing. The steps for the agent are in
the "Demo" section of the [agent skill](../skills/sign-pdf/SKILL.md#demo) and in
[llms.txt](../packages/web/public/llms.txt).

## The demo document

`/demo-nda.pdf` is made at build time from `packages/web/public/sample-nda.pdf`: a Vite
plugin (`packages/web/demoNda.ts`) removes the form (AcroForm) fields and their widgets and
writes the result into the web build. The repository holds no second PDF.

The output is deterministic, so its SHA-256 is stable from build to build. The
[end-to-end test](../e2e/demo.spec.ts) pins it. When the sample or the PDF writer changes,
update the pinned value.

Every blank of the demo has a printed label to anchor on: no field needs a `rect`
placement.

## The check in CI

`e2e/demo.spec.ts` drives the real MCP server in memory as a scripted agent with no model,
on the built `demo-nda.pdf`. It checks that:

- the PDF has no form fields;
- a request built from `find_candidates` output and text anchors passes validation;
- each field overlaps its blank by at least 0.5 IoU (intersection over union);
- the filled party names show in the sign view. The test opens the sign view and does not sign.

It runs in the `e2e` CI job (`pnpm test:integration`), so it gates the deploy.
