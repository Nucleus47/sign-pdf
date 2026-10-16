# Agent demo

When a user asks their agent for a demo, the agent places and fills fields on a standard
NDA that has no form fields. The steps for the agent are in the "Demo" section of the
[agent skill](../skills/sign-pdf/SKILL.md#demo) and in
[llms.txt](../packages/web/public/llms.txt). In short:

- First, the agent says where the data goes: the MCP server, the CLI and the website upload
  nothing; the agent's model provider receives the chat; only the optional email relay
  stores an encrypted copy, for a limited time ([relay](relay.md#state-and-lifetimes)).
- Then it asks before it puts the user's name and company on the NDA. Without a yes, it
  uses demo values ("Example Co.", "Your Name"). Party B is always "Sample Partner Co.".
- The agent scans every page, discloses every skipped blank before the preview, and reports the full blank inventory with it. It asks before it requests a signature.

There are two routes: the MCP server, and the browser only. Both use the same request,
`/demo-request.json` (`packages/web/public/demo-request.json`). It has no `version` or
`document`: the web page fills them in, and an MCP agent adds them.

## The sample on the start page

"Try the sample agreement" opens the same demo: `/demo-nda.pdf` in the prepare view, with
the fields of `/demo-request.json` on the page, "Continue to sign" in the top bar and panel
header, and a note that it is a demo and that nothing is uploaded (`openSample` in
`packages/web/src/app/open.ts`). The
[sample check](../packages/web/e2e/demo-sample.spec.ts) opens it from the start page.

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
`rect` placement. The six other logical blanks stay empty on purpose: Effective Date (page 1), confidentiality
period (page 1, clause 2), agreement duration (page 2, clause 9), and Party B's signature,
date and print name (page 3). The Effective Date has three underscore runs (day, month,
year stub), which count as one logical date even when detection splits them. There are
13 underscore runs and 11 logical blanks in total. The skill, ready request note and
sample notice list the skipped blanks. The agent must disclose them before showing the
preview and include the [full inventory](../skills/sign-pdf/SKILL.md#account-for-all-demo-blanks)
with it. The labels are plain names (Party A, Party B, Signature, Date,
Print name), and the sign view shows no label inside an empty box.

The agent fills the print name, and the request names the signer (`signer.name`) with the
same value, so the sign view does not ask for the name twice. The signer has two steps:
the signature and the confirmation checkbox ("0 of 2 required items"). The date is today's.
While the request loads, the field list says "Loading the fields…", not "No fields yet".

## The check in CI

`e2e/demo.spec.ts` drives the real MCP server in memory as a scripted agent with no model,
on the built `demo-nda.pdf`. It checks that:

- the PDF has no form fields;
- a request built from `find_candidates` output and text anchors passes validation;
- each field overlaps its blank by at least 0.5 IoU (intersection over union);
- the filled party names are drawn in the `render_preview` image, and show in the sign view.
  The test opens the sign view only to check this; it does not sign;
- the served `/demo-request.json` validates on the demo PDF with no errors or warnings, and
  its fields sit on the same blanks.

It runs in the `e2e` CI job (`pnpm test:integration`), so it gates the deploy.
