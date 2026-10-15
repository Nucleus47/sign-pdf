/**
 * The same hand-off through the MCP server: an agent calls request_signature,
 * the human signs in the real web build, and get_signature_status reports the
 * signed file. The server runs in this process; the only stub is the browser
 * launcher, which hands the link to Playwright instead of the system browser.
 */
import { stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from '@playwright/test';
import { createSignPdfMcp } from '@sign-pdf/mcp';
import { makeFixture, nonceOf, openSignView, reportCspViolations, signAsTestSigner, SIGNER, watch, WEB_DIR } from './helpers.ts';

test('request_signature: the human signs and get_signature_status reports the signed file', async ({ page }) => {
  const fixture = await makeFixture();
  const links: string[] = [];
  const mcp = createSignPdfMcp({ openBrowser: (url) => void links.push(url), webDir: WEB_DIR, env: {} });
  const agent = new Client({ name: 'integration-agent', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  // Everything the agent is told, as text: tool results in both of their forms.
  const told: string[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await agent.callTool({ name, arguments: args });
    told.push(JSON.stringify(result));
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as Record<string, unknown>;
  };

  try {
    await Promise.all([mcp.server.connect(serverSide), agent.connect(clientSide)]);

    const started = await call('request_signature', {
      pdf_path: fixture.pdfPath,
      request: fixture.request,
      output_path: fixture.outPath,
      timeout_seconds: 120,
    });
    expect(started).toMatchObject({ status: 'pending', browser_opened: true, output_path: fixture.outPath });
    const sessionId = started['session_id'];
    expect(typeof sessionId).toBe('string');

    // The launcher got the one-time link; the agent did not.
    expect(links).toHaveLength(1);
    const link = links[0] ?? '';
    expect(started['origin']).toBe(new URL(link).origin);

    await reportCspViolations(page);
    const problems = watch(page);
    let token = '';
    page.on('response', (response) => {
      if (new URL(response.url()).pathname !== '/api/session') return;
      void response.json().then((body: { token?: string }) => (token = body.token ?? ''));
    });

    const pending = await call('get_signature_status', { session_id: sessionId, wait_seconds: 0 });
    expect(pending).toMatchObject({ status: 'pending' });

    await openSignView(page, link);
    await signAsTestSigner(page);
    const pageSha = (await page.getByTestId('signed-sha256').textContent())?.trim();

    const signed = await call('get_signature_status', { session_id: sessionId, wait_seconds: 20 });
    expect(signed).toMatchObject({
      status: 'signed',
      integrity: 'unverified',
      output_path: fixture.outPath,
      sha256: pageSha,
      untrusted_audit_summary: { signerName: SIGNER, originalSha256: fixture.request.document.sha256 },
    });
    const info = await stat(fixture.outPath);
    expect(info.isFile()).toBe(true);
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);

    // No tool result carries the nonce, the link or the token.
    expect(token).not.toBe('');
    const everything = told.join('\n');
    expect(everything).not.toContain(nonceOf(link));
    expect(everything).not.toContain(token);
    expect(everything).not.toContain('#session=');
    expect(problems).toEqual([]);
  } finally {
    await agent.close().catch(() => undefined);
    await mcp.close();
    await fixture.cleanup();
  }
});
