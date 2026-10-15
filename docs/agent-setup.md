# Agent setup

Use this guide to let an agent prepare a PDF and ask you to sign it. You need Node.js 22
or later. The quickest route: give your agent the address https://sign.silv.app. The page
points it to [llms.txt](https://sign.silv.app/llms.txt) and the
[skill](https://sign.silv.app/skill.md), which tell it how to install and use sign-pdf.

The agent can read the PDF, place fields, fill the fields it can fill, and mark what
you must sign. Only you can sign, in your browser. The agent never gets a signing link.

## Install from npm

Run the MCP server:

```bash
npx -y @sign-pdf/mcp@latest
```

Run the command-line tool:

```bash
npx -y @sign-pdf/cli@latest --help
```

Keep the `@latest` tag. Without it, `npx` can keep running the copy it cached first. A
running server keeps its version until the client starts it again. The
[skill](https://sign.silv.app/skill.md) has the full version check.

## Register the MCP server

For Claude Code, run `claude mcp add sign-pdf -- npx -y @sign-pdf/mcp@latest`.

Claude Desktop, Cursor, VS Code, and other MCP clients can use this JSON:

```json
{
  "mcpServers": {
    "sign-pdf": {
      "command": "npx",
      "args": ["-y", "@sign-pdf/mcp@latest"]
    }
  }
}
```

The environment variables (`SIGN_PDF_WEB_DIR`, `SIGN_PDF_OUTPUT_DIR`, `SIGN_PDF_NO_OPEN`)
are described in the [MCP server README](../packages/mcp/README.md#register-the-server-with-an-mcp-client).
Set them in the client configuration. The agent cannot change them.

## Tool flow

Every path must be absolute. `request` is the sign request as a JSON object.
The tool flow is `inspect_pdf -> find_candidates -> draft_request -> validate_request -> render_preview`.

1. `inspect_pdf` (`pdf_path`, `detail: "summary"`): starts with page diagnosis, likely field-label lines and form field names. Use `detail: "full"` (the default) when you need every text run and its position. Summary pages report `textRunCount`, `hasText` and `imageOnly`; an image-only page has a painted Image XObject (including one inside a painted Form XObject) and no non-whitespace text runs. Summary also returns `image_only_pages` and `warnings` with the preview-to-rect fallback hint. Full mode keeps its previous response shape.
2. `find_candidates` (`pdf_path`): returns numbered places for fields (labels such as `Signature:`, underscore lines, drawn lines next to signature and date labels, form fields). Candidates can miss blanks and include blanks that are not yours, such as a preparer's signature.
3. `draft_request` (`pdf_path`, optional `candidates`, `values`, `title`, `signer_name`): builds a request from the candidate suggestions and validates it against the same PDF bytes. The generated request and document-derived labels stay under `untrusted_document_content.request`.
4. `get_request_schema` (no input): returns the JSON Schema of a sign request. `validate_request` (`pdf_path`, `request`) resolves every field and returns errors with hints.
5. `render_preview` (`pdf_path`, `request`): returns PNG images of the pages with every field box drawn. The agent must look at them and fix the layout before it continues. When a preparer printed a mark in a blank (a tick, arrow or X that shows where to sign), the field must start after the mark: shift it with `dx`.
   If a page is image-only, anchors and candidates cannot work there. Call `render_preview` on the bare page, look at the image, add fields with explicit `rect` placements using the preview rulers, then call `validate_request`.
6. `request_signature` (`pdf_path`, `request`, optional `output_path`, `timeout_seconds`): opens the document in your browser and returns a `session_id` at once.
7. `get_signature_status` (`session_id`, optional `wait_seconds`): returns `pending`, `signed` (with the output path and its SHA-256), `declined`, `timed_out` or `cancelled`.
8. `verify_signed_pdf` (`pdf_path`): reads the audit record in the signed PDF.

`create_packet` writes the PDF and the request into one file that you can open in the
web app later, when you are not at the computer now.

The full inputs and outputs are in the [MCP server README](../packages/mcp/README.md#tools).

## Install from a checkout

To work on sign-pdf itself, run from a checkout. At the repository root, run:

```bash
pnpm install
pnpm build
```

This builds `packages/mcp/dist/bin.js`, `packages/cli/dist/bin.js`, and
`packages/web/dist`. The MCP build also smoke-tests stdio. Check it with
`node packages/mcp/dist/bin.js --version`.

To register the checkout build, run:

```bash
claude mcp add sign-pdf -- node /absolute/path/to/checkout/packages/mcp/dist/bin.js
```

For MCP JSON, set `command` to `node` and `args` to the absolute path of
`packages/mcp/dist/bin.js` in the checkout.

## Command-line equivalent

The `sign-pdf` command-line tool has the same steps:

```bash
node packages/cli/dist/bin.js inspect contract.pdf
node packages/cli/dist/bin.js inspect contract.pdf --summary
node packages/cli/dist/bin.js candidates contract.pdf
node packages/cli/dist/bin.js draft contract.pdf -o request.json --candidates 1,3-5
node packages/cli/dist/bin.js validate contract.pdf request.json
node packages/cli/dist/bin.js preview contract.pdf request.json --out preview/
node packages/cli/dist/bin.js request contract.pdf request.json -o contract-signed.pdf
node packages/cli/dist/bin.js verify contract-signed.pdf
```

`packages/cli/examples/sample-nda.draft.json` is generated from candidates `4,5,8-10` on
the sample NDA. The edited request example is `packages/cli/examples/sample-nda.request.json`.
See the [command-line README](../packages/cli/README.md) for every option.
For an image-only page, run `preview contract.pdf --candidates --pages <n> --out preview/`,
look at the PNG and rulers, use an explicit `rect` placement, then run `validate`.

## What you see

1. Your browser opens the sign view on `127.0.0.1`. The document never leaves your computer.
2. You review every value that the agent filled. You can change a value or move a field.
3. You fill your own fields and add your signature: drawn, typed or uploaded.
4. You tick the confirmation statement. It records your consent to sign electronically and is stored word for word in the audit record.
5. You sign, or you decline and give a reason. The agent gets the result from `get_signature_status`.

## Several signers

When more than one person must sign, list them in `signers`, in signing order. Give
every human field the `signerId` of the person who fills it. Agent fields take no
`signerId`, and a request with `signers` takes no `signer`.

```json
{
  "version": 1,
  "document": { "name": "form.pdf", "sha256": "<sha256 from inspect_pdf>" },
  "signers": [
    { "id": "a", "name": "Signer One" },
    { "id": "b", "name": "Signer Two" }
  ],
  "fields": [
    { "id": "sigA", "type": "signature", "assignee": "human", "signerId": "a",
      "placement": { "kind": "anchor", "text": "Signature:", "width": 180, "height": 36 } },
    { "id": "sigB", "type": "signature", "assignee": "human", "signerId": "b",
      "placement": { "kind": "anchor", "text": "Signature:", "occurrence": 2, "width": 180, "height": 36 } }
  ]
}
```

The signers sign in turn, in one sign session or on different devices:

1. Each signer enters their own name, ticks the confirmation statement and fills only their own fields. Fields of the other signers are shown but locked.
2. Only the first signer can review or change the agent's values.
3. A signature is never offered for reuse to a different signer.
4. After each signer, the sign view offers to hand the device to the next signer, or to download a hand-off PDF for the next signer on another device. The signed PDF is written only after the last signer signs.
5. A decline from any signer declines the whole request.

`get_signature_status` stays `pending` until the last signer signs. The audit record
keeps one entry per signer in `passes`, linked by SHA-256 hashes.

### On different devices

The signers do not need to share a device. After a signer finishes, the sign view can
give a [hand-off PDF](handoff-pdf.md) for the next signer. The signer sends that file to
the next signer, who opens it in sign-pdf on their own device and continues. The last
signer gets the final signed PDF.

1. `get_signature_status` returns `status: "handed_off"`, with `signed` and `pending`
   signer ids, when a signer downloads the hand-off PDF. The session writes no file.
2. Tell the user that the final signed PDF comes back by other means, for example by
   email from the last signer.
3. When the final signed PDF arrives, call `verify_signed_pdf` on it. If the result has
   `handoff: true`, the file is a hand-off PDF and not final: `untrusted_pending_signers` lists
   the signers who still must sign.

## Integrity

The audit record in the signed PDF is an unauthenticated claim. It is not tamper-evident
and it is not proof of who signed. Every result reports the integrity as `unverified`.
Sealing the signed PDF is tracked in issue #30.
