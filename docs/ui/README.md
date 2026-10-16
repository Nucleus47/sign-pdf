# Demo screen checks

The demo uses two screen states. Capture both at desktop 1440 × 900 and mobile 390 × 844.

| State | Route | Setup | Check |
| --- | --- | --- | --- |
| Prepare | `/` | Open the sample | Six fields, skipped-blank notice, and Continue to sign |
| Sign | `/` | Open the sample, then Continue to sign | Human review and Edit fields |

The [capture manifest](templates.json) and [setup](setup.mjs) use synthetic sample data.
Run the local harness capture command from `packages/web`, with the manifest and setup
paths and a running production preview server. Use `--driver @playwright/test` for the
installed Playwright package. Wait for a PDF page canvas after the sign view opens. Screenshots stay local under the configured
capture directory. The [demo browser tests](../../packages/web/e2e/demo-sample.spec.ts)
check field counts, disclosure, signing controls, and automatic fit after a pane resize.
On phones and coarse-pointer screens, the top-bar signing button uses the shared 44 px target size. The existing phone and
desktop touch-target regression tests also cover it.

See [the demo](../demo.md) for the blank inventory and the [browser agent guide](../browser-agent.md)
for the hand-off rules.
