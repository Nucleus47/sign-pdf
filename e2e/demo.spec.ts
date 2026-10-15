/**
 * The agent demo (skills/sign-pdf/SKILL.md, "Demo"): a scripted agent with no
 * model places and fills fields on the flat demo NDA through the real MCP
 * server, in this process. The demo stops before signing. To check what the
 * human would see, the test then opens the sign view and does not sign.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from '@playwright/test';
import { createSignPdfMcp } from '@sign-pdf/mcp';
import type { FieldInput, Rect, SignRequestInput } from '@sign-pdf/spec';
import { openSignView, SIGNER, watch, WEB_DIR } from './helpers.ts';

/**
 * The SHA-256 of the built demo-nda.pdf. The build is deterministic, so this
 * changes only when the sample NDA or the PDF writer changes. Update it then.
 */
const DEMO_NDA_SHA256 = 'dab1a58229ea5b4cc9cd632677a0762a2df601ac28c91c0bab8b0099078b9be1';

/** What the user tells the agent. Synthetic: no real name or company. */
const USER_COMPANY = 'Example Labs LLC';
const OTHER_PARTY = 'Sample Partner Co.';

/**
 * Where each value belongs: the printed underscore run of each blank, in
 * points with the origin at the top-left (measured from the text positions of
 * the sample NDA). Party A's block on page 3 is the user's.
 */
const EXPECTED: Record<string, Rect> = {
  party_a: { page: 1, x: 282.8, y: 94.8, width: 119.6, height: 12 },
  party_b: { page: 1, x: 157, y: 115.3, width: 119, height: 12 },
  signature: { page: 3, x: 185.8, y: 102.5, width: 173.9, height: 12 },
  date: { page: 3, x: 392, y: 102.5, width: 113, height: 12 },
  print_name: { page: 3, x: 135.5, y: 143.8, width: 173.3, height: 12 },
};
const IOU_THRESHOLD = 0.5;

function intersectionOverUnion(a: Rect, b: Rect): number {
  if (a.page !== b.page) return 0;
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

interface Candidate {
  number: number;
  text: string;
  page: number;
  suggested: { placement: FieldInput['placement']; type?: string };
}

test('demo: a scripted agent places and fills fields on the flat NDA, and the human sees the values', async ({ page }) => {
  const pdf = await readFile(join(WEB_DIR, 'demo-nda.pdf'));
  expect(createHash('sha256').update(pdf).digest('hex')).toBe(DEMO_NDA_SHA256);

  // The agent downloads the demo PDF into a private directory.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sign-pdf-demo-')));
  const pdfPath = join(dir, 'demo-nda.pdf');
  await copyFile(join(WEB_DIR, 'demo-nda.pdf'), pdfPath);

  const links: string[] = [];
  const mcp = createSignPdfMcp({ openBrowser: (url) => void links.push(url), webDir: WEB_DIR, env: {} });
  const agent = new Client({ name: 'demo-agent', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await agent.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result as { structuredContent: Record<string, unknown>; content: Array<{ type: string }> };
  };

  try {
    await Promise.all([mcp.server.connect(serverSide), agent.connect(clientSide)]);

    // Step 2: the PDF has no form fields.
    const inspected = (await call('inspect_pdf', { pdf_path: pdfPath, include_text: false })).structuredContent;
    expect(inspected['sha256']).toBe(DEMO_NDA_SHA256);
    expect((inspected['untrusted_document_content'] as { form_fields: unknown[] }).form_fields).toEqual([]);

    // Step 3: candidates, then a marked preview of every page.
    const found = (await call('find_candidates', { pdf_path: pdfPath })).structuredContent;
    const candidates = (found['untrusted_document_content'] as { candidates: Candidate[] }).candidates;
    const marked = await call('render_preview', { pdf_path: pdfPath, mark_candidates: true, pages: [1, 2, 3], scale: 1 });
    expect(marked.content.filter((block) => block.type === 'image')).toHaveLength(3);

    // Step 4: the request. The party names are on text anchors the agent writes;
    // the human's fields copy the candidates of Party A's block.
    const pick = (text: string, type: string) => {
      const candidate = candidates.find((item) => item.page === 3 && item.text === text && item.suggested.type === type);
      expect(candidate, `a ${type} candidate for "${text}"`).toBeDefined();
      return candidate!.suggested.placement;
    };
    const request: SignRequestInput = {
      version: 1,
      document: { name: 'demo-nda.pdf', sha256: DEMO_NDA_SHA256 },
      title: 'Mutual NDA (demo)',
      signer: { name: SIGNER },
      fields: [
        {
          id: 'party_a',
          type: 'text',
          label: 'Party A',
          assignee: 'agent',
          value: USER_COMPANY,
          placement: { kind: 'anchor', text: 'by and between', page: 1, align: 'right', dx: 5, dy: -1, width: 119, height: 14 },
        },
        {
          id: 'party_b',
          type: 'text',
          label: 'Party B',
          assignee: 'agent',
          value: OTHER_PARTY,
          placement: { kind: 'anchor', text: '"Party A", and', page: 1, align: 'right', dx: 5.5, dy: -1, width: 119, height: 14 },
        },
        { id: 'signature', type: 'signature', label: 'Signature', assignee: 'human', placement: pick('Party A’s Signature', 'signature') },
        { id: 'date', type: 'date', label: 'Date', assignee: 'human', placement: pick('Date', 'date') },
        { id: 'print_name', type: 'text', label: 'Print name', assignee: 'human', placement: pick('Print Name', 'text') },
      ],
    };

    // Step 5: the request validates, and every field sits on its blank.
    const validated = (await call('validate_request', { pdf_path: pdfPath, request })).structuredContent;
    expect(validated['errors']).toEqual([]);
    expect(validated['warnings']).toEqual([]);
    const fields = validated['fields'] as Array<{ id: string; rect: Rect }>;
    expect(fields.map((field) => field.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const field of fields) {
      expect(intersectionOverUnion(field.rect, EXPECTED[field.id]!), field.id).toBeGreaterThanOrEqual(IOU_THRESHOLD);
    }

    const preview = await call('render_preview', { pdf_path: pdfPath, request });
    const images = preview.structuredContent['images'] as Array<{ page: number; field_ids: string[] }>;
    expect(images.map((image) => [image.page, [...image.field_ids].sort()])).toEqual([
      [1, ['party_a', 'party_b']],
      [3, ['date', 'print_name', 'signature']],
    ]);
    expect(preview.content.filter((block) => block.type === 'image')).toHaveLength(2);

    // Step 6: the demo stops here. The test goes on to open the sign view, as
    // it would open if the user asked to sign, and checks the filled names on
    // the rendered document. Nobody signs.
    expect(links).toEqual([]);
    const started = (await call('request_signature', { pdf_path: pdfPath, request, timeout_seconds: 120 })).structuredContent;
    expect(started).toMatchObject({ status: 'pending', browser_opened: true });
    expect(links).toHaveLength(1);

    const problems = watch(page);
    await openSignView(page, links[0]!);
    await expect(page.getByTestId('field-box-party_a')).toContainText(USER_COMPANY);
    await expect(page.getByTestId('field-box-party_b')).toContainText(OTHER_PARTY);
    expect(problems).toEqual([]);

    const status = (await call('get_signature_status', { session_id: started['session_id'], wait_seconds: 0 })).structuredContent;
    expect(status).toMatchObject({ status: 'pending' });
  } finally {
    await agent.close().catch(() => undefined);
    await mcp.close();
    await rm(dir, { recursive: true, force: true });
  }
});
