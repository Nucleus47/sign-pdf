import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSignPdfMcp } from './server.ts';
import { MCP_VERSION } from './version.ts';
import { nodeVersionError, nodeVersionHint } from '@sign-pdf/cli';

const args = process.argv.slice(2);
const unsupportedNode = nodeVersionError(process.version);
if (unsupportedNode !== undefined) {
  process.stderr.write(`error [unsupported-node]: ${unsupportedNode}\nhint: ${nodeVersionHint()}\n`);
  process.exitCode = 1;
} else if (args.includes('--version')) {
  process.stdout.write(`${MCP_VERSION}\n`);
} else if (args.length > 0) {
  // stdout belongs to the protocol once the server runs, so help goes out only here.
  process.stdout.write(
    `sign-pdf-mcp ${MCP_VERSION}\n\nMCP server for sign-pdf over stdio. Takes no arguments: start it from an MCP client.\n` +
      'Environment: SIGN_PDF_WEB_DIR (built web app, default packages/web/dist), ' +
      'SIGN_PDF_OUTPUT_DIR (one more directory that output_path can point into), ' +
      'SIGN_PDF_NO_OPEN=1 (never open a browser; request_signature then fails with browser-unavailable).\n',
  );
  process.exitCode = args.includes('--help') || args.includes('-h') ? 0 : 1;
} else {
  const mcp = createSignPdfMcp({ env: process.env });
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    // Closing ends every signature session, after which nothing keeps the process alive.
    void mcp.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  await mcp.server.connect(new StdioServerTransport());
}
