# sign-pdf

Open-source, agent-friendly PDF signing. An agent prepares the document and a human
signs it. No account, no hosted signing service: everything runs on your device.

- An agent, or you, lays out and fills fields on any PDF and marks what must be signed.
  The agent writes a **sign request** (JSON) that names each field, its placement and who
  fills it; a **packet** bundles the request and the PDF in one file.
- You review every value, fix any misplaced field, and sign in your browser.
- The signed PDF carries an audit record of who filled what.

Three ways to run it, all with the same code:

1. **On the agent's machine.** The agent runs the MCP server or the command-line tool from
   npm, which open the sign view in your browser from a local server.
2. **The agent keeps custody of the file.** It builds the packet and hands you the file,
   and you open it on a copy of the web app it hosts, or on [sign.silv.app](https://sign.silv.app).
3. **In the browser only.** Open a PDF on the site, place the fields yourself, and sign.

The file then goes to the next signer by download, so no file leaves your devices. The
optional email relay (below) is off on sign.silv.app for now; it is a feature flag.

Status: version 2 is being rebuilt on this layout. See [ARCHITECTURE.md](ARCHITECTURE.md)
for the modules and the sign request format in [`packages/spec`](packages/spec/src/index.ts).

## Use with an agent

Give your agent the address https://sign.silv.app. The page points it to
[llms.txt](https://sign.silv.app/llms.txt) and the [skill](https://sign.silv.app/skill.md),
which tell it how to install the MCP server (`npx -y @sign-pdf/mcp@latest`), keep it
current, and use it. You sign in your browser. See [docs/agent-setup.md](docs/agent-setup.md)
for the details. All docs pages are indexed in
[docs/README.md](docs/README.md).

Coding agents can start with the [coding agent guide](docs/coding-agents.md), then follow the
[spec](packages/spec/README.md) and [core](packages/core/README.md) package guides. The
[CLI examples gallery](packages/cli/examples/README.md) shows request patterns.

## Email the next signer

With two signers, the first signer can email the document to the second instead of
sending a file. The browser encrypts the document; the optional relay server stores only
the encrypted copy and emails a link. When the second signer signs, the first signer gets
a link and a code, downloads the signed PDF on the device that sent it, and the server
deletes its copy. You can self-host the relay or leave it out. It is off unless the Worker's `RELAY_MODE`
var is `on`; while off, the site shows only the download flow. See [docs/relay.md](docs/relay.md).

## Develop

```bash
pnpm install
pnpm check
```

The hosted app is the built web app served by a Cloudflare Worker (`packages/relay`). You can serve the same build from any static host that applies
`packages/web/public/_headers`.

## License

MIT
