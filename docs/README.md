# Documentation

Small, single-topic pages. Add each new page to this index.

## Pages

- [Agent setup](agent-setup.md): install from npm, register the MCP server and keep it current, and the tool flow from inspect to signed PDF, and requests with several signers.
- [Browser agent API](browser-agent.md): how an agent with only a browser prepares a PDF on the website: WebMCP, `window.signPdf`, the paste box and the `#request=` link.
- [Guided signing](signing.md): how the sign view walks a signer through their fields, and what the floating button does.
- [Browser support](browser-support.md): the browsers the web app supports, how the build and CI check it, and the pdf.js exceptions.
- [Error reports](error-reports.md): the copyable technical details on every error screen, what they hold and never hold, and the out-of-date browser banner.
- [Hand-off PDF](handoff-pdf.md): the PDF that carries a document to the next signer on another device: what it shows, what it carries, and its warnings.
- [Relay](relay.md): the optional server that emails the next signer an encrypted copy: the flow, the API, what the server can see, lifetimes and operator setup.

## Elsewhere in the repository

- [README](../README.md): what sign-pdf is and how to develop it.
- [Architecture](../ARCHITECTURE.md): the modules and how they fit together.
- [MCP server](../packages/mcp/README.md): every tool, its inputs and its outputs.
- [Command-line tool](../packages/cli/README.md): every command, the loopback protocol and the security notes.
- [Coding agent guide](coding-agents.md): repository rules and the first commands for coding agents.
- [Sign request contract](../packages/spec/README.md): placement kinds, schema export and request versioning.
- [Core PDF logic](../packages/core/README.md): the prepare and verify pipeline and runtime boundaries.
- [CLI examples](../packages/cli/examples/README.md): sample requests, including multiple signers and anchor-only placement.
