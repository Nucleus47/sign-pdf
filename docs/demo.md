# Agent demo

When a user asks their agent for a demo, the agent places and fills fields on a standard
NDA that has no form fields. The demo stops before signing. The steps for the agent are in
the "Demo" section of the [agent skill](../skills/sign-pdf/SKILL.md#demo) and in
[llms.txt](../packages/web/public/llms.txt).

## The demo document

`/demo-nda.pdf` is made at build time from `packages/web/public/sample-nda.pdf`: a Vite
plugin (`packages/web/demoNda.ts`) removes the form (AcroForm) fields, their widgets and
every object left unused, and writes the result into the web build. The repository holds
no second PDF.

The output is deterministic, so its SHA-256 is stable from build to build. The
[end-to-end test](../e2e/demo.spec.ts) pins it. When the sample or the PDF writer changes,
update the pinned value.

The demo fills five blanks: the two party names on page 1, and the signature, date and
print name of Party A on page 3. Each has printed text to anchor on, so no field needs a
`rect` placement. The other blanks (the effective date, the terms, and Party B's block)
stay empty on purpose.

## The check in CI

`e2e/demo.spec.ts` drives the real MCP server in memory as a scripted agent with no model,
on the built `demo-nda.pdf`. It checks that:

- the PDF has no form fields;
- a request built from `find_candidates` output and text anchors passes validation;
- each field overlaps its blank by at least 0.5 IoU (intersection over union);
- the filled party names are drawn in the `render_preview` image, and show in the sign view.
  The test opens the sign view only to check this; it does not sign.

It runs in the `e2e` CI job (`pnpm test:integration`), so it gates the deploy.
