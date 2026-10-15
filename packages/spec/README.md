# Sign request contract

`@sign-pdf/spec` defines the JSON contract shared by the CLI, MCP server, core and web app. A sign request names a PDF by its SHA-256 hash, lists fields, assigns each field to the agent or a human, and marks where each field belongs.

Signature and initials fields belong to a human and have no `value`. The human enters them in the sign view. Text, date and checkbox fields can belong to the agent or a human. An agent-assigned field needs a `value`.

## Placement kinds

Use an explicit rectangle only when the position is known. Coordinates are PDF points (1/72 inch), from the displayed page's top-left corner, with y increasing down. Page numbers start at 1.

### Rectangle

```json
{ "kind": "rect", "page": 1, "x": 72, "y": 640, "width": 180, "height": 32 }
```

### Text anchor

Use printed text as an anchor. The field starts to the right of the matched text by default. `align`, `dx` and `dy` can adjust it.

```json
{ "kind": "anchor", "text": "Signature:", "page": 1, "align": "right", "dx": 6, "width": 180, "height": 32 }
```

### Existing AcroForm field

Use the fully qualified name reported by `inspectPdf`.

```json
{ "kind": "acroField", "name": "Signer.Signature" }
```

## JSON Schema and version

The package exports `signRequestJsonSchema()` for a JSON Schema object. The CLI can write the same schema to a file:

```bash
pnpm --filter @sign-pdf/cli build
node packages/cli/dist/bin.js schema > sign-request.schema.json
```

The request's `version` must match `SPEC_VERSION` from this package. It is `1` now. When a schema change requires a new request version, update `SPEC_VERSION`, the schema tests and every affected package in the same change. The spec is the contract across the repository.
