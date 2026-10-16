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
const DEMO_NDA_SHA256 = '61399e89c8263dfde18da38d4ef70be776a72675823cf314b479958e4ac7609f';

/** What the user tells the agent. Synthetic: no real name or company. */
const USER_COMPANY = 'Example Labs LLC';
const OTHER_PARTY = 'Sample Partner Co.';

/**
 * Where each value belongs: the printed underscore run of each blank, in
 * points with the origin at the top-left (measured from the text positions of
 * the sample NDA). Party A's block on page 3 is the user's.
 */
const EXPECTED: Record<string, Rect> = {
  effective_date: { page: 1, x: 366.6, y: 74, width: 119, height: 12 },
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
  // No trace of the form is left in the file, reachable or not.
  const bytes = pdf.toString('latin1');
  for (const name of ['/AcroForm', '/Widget', '/Fields']) expect(bytes, name).not.toContain(name);

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
    const inspected = (await call('inspect_pdf', { pdf_path: pdfPath, detail: 'full' })).structuredContent;
    expect(inspected['sha256']).toBe(DEMO_NDA_SHA256);
    expect((inspected['untrusted_document_content'] as { form_fields: unknown[] }).form_fields).toEqual([]);
    // Scan every printed underscore run, not only candidates or chosen fields.
    // The first three runs form one logical Effective Date.
    const text = (inspected['untrusted_document_content'] as { text: Array<{ page: number; text: string }> }).text;
    const runsByPage = [1, 2, 3].map((pageNumber) =>
      text.filter((run) => run.page === pageNumber).reduce((count, run) => count + [...run.text.matchAll(/_+/g)].length, 0),
    );
    expect(runsByPage).toEqual([6, 1, 6]);


    // Step 3: candidates, then a marked preview of every page.
    const found = (await call('find_candidates', { pdf_path: pdfPath })).structuredContent;
    const candidates = (found['untrusted_document_content'] as { candidates: Candidate[] }).candidates;
    const marked = await call('render_preview', { pdf_path: pdfPath, mark_candidates: true, pages: [1, 2, 3], scale: 1 });
    expect(marked.content.filter((block) => block.type === 'image')).toHaveLength(3);

    // Step 4: the request. The party names are on text anchors the agent writes;
    // the effective date on page 1 and Party A's block on page 3 copy their candidates.
    const pick = (pageNumber: number, text: string, type: string) => {
      const candidate = candidates.find((item) => item.page === pageNumber && item.text === text && item.suggested.type === type);
      expect(candidate, `a ${type} candidate for "${text}" on page ${pageNumber}`).toBeDefined();
      return candidate!.suggested.placement;
    };
    const request: SignRequestInput = {
      version: 1,
      document: { name: 'demo-nda.pdf', sha256: DEMO_NDA_SHA256 },
      title: 'Mutual NDA (demo)',
      signer: { name: SIGNER },
      fields: [
        { id: 'effective_date', type: 'date', label: 'Effective date', assignee: 'human', placement: pick(1, 'day of', 'date') },
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
        { id: 'signature', type: 'signature', label: 'Signature', assignee: 'human', placement: pick(3, 'Party A’s Signature', 'signature') },
        { id: 'date', type: 'date', label: 'Date', assignee: 'human', placement: pick(3, 'Date', 'date') },
        { id: 'print_name', type: 'text', label: 'Print name', assignee: 'agent', value: SIGNER, placement: pick(3, 'Print Name', 'text') },
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

    // The ready request for both routes (/demo-request.json, also what the start
    // page's sample opens) validates and puts the same fields on the same blanks.
    const ready = JSON.parse(await readFile(join(WEB_DIR, 'demo-request.json'), 'utf8')) as Omit<SignRequestInput, 'version' | 'document'>;
    expect(ready).not.toHaveProperty('document');
    const readyReport = (
      await call('validate_request', { pdf_path: pdfPath, request: { version: 1, document: request.document, ...ready } })
    ).structuredContent;
    expect(readyReport['errors']).toEqual([]);
    expect(readyReport['warnings']).toEqual([]);
    const readyFields = readyReport['fields'] as Array<{ id: string; rect: Rect }>;
    expect(readyFields.map((field) => field.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const field of readyFields) {
      expect(intersectionOverUnion(field.rect, EXPECTED[field.id]!), `demo-request.json ${field.id}`).toBeGreaterThanOrEqual(IOU_THRESHOLD);
    }

    const preview = await call('render_preview', { pdf_path: pdfPath, request });
    const images = preview.structuredContent['images'] as Array<{ page: number; field_ids: string[] }>;
    expect(images.map((image) => [image.page, [...image.field_ids].sort()])).toEqual([
      [1, ['effective_date', 'party_a', 'party_b']],
      [3, ['date', 'print_name', 'signature']],
    ]);
    expect(preview.content.filter((block) => block.type === 'image')).toHaveLength(2);

    // The filled names are drawn in the preview image: inside each party box,
    // page 1 differs from a preview of the same boxes with no values. (The tags
    // above the boxes differ too, as they name the assignee.)
    const unfilled = {
      ...request,
      fields: request.fields.map((field) => (field.assignee === 'agent' ? { ...field, assignee: 'human', value: undefined } : field)),
    } as SignRequestInput;
    const [filledPng, unfilledPng] = await Promise.all(
      [request, unfilled].map(async (each) => {
        const result = await call('render_preview', { pdf_path: pdfPath, request: each, pages: [1], scale: 2 });
        const image = result.content.find((block) => block.type === 'image') as { data: string } | undefined;
        const [layout] = result.structuredContent['images'] as Array<{ page: number; scale: number; origin: { x: number; y: number } }>;
        expect(layout?.page).toBe(1);
        return { png: image!.data, layout: layout! };
      }),
    );
    const { scale, origin } = filledPng!.layout;
    expect(unfilledPng!.layout).toEqual(filledPng!.layout);
    const boxes = fields
      .filter((field) => field.rect.page === 1)
      .map(({ id, rect }) => ({ id, x: origin.x + rect.x * scale, y: origin.y + rect.y * scale, width: rect.width * scale, height: rect.height * scale }));
    const changed = await page.evaluate(
      async ({ a, b, boxes }) => {
        const pixels = async (png: string) => {
          const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext('2d')!;
          context.drawImage(bitmap, 0, 0);
          return context.getImageData(0, 0, bitmap.width, bitmap.height);
        };
        const [one, two] = [await pixels(a), await pixels(b)];
        const inside = (x: number, y: number) => boxes.find((box) => x > box.x + 2 && x < box.x + box.width - 2 && y > box.y + 2 && y < box.y + box.height - 2);
        const counts: Record<string, number> = {};
        for (const box of boxes) counts[box.id] = 0;
        for (let y = 0; y < one.height; y++) {
          for (let x = 0; x < one.width; x++) {
            const i = (y * one.width + x) * 4;
            if (one.data[i] === two.data[i] && one.data[i + 1] === two.data[i + 1] && one.data[i + 2] === two.data[i + 2]) continue;
            const box = inside(x, y);
            if (box) counts[box.id]!++;
          }
        }
        return counts;
      },
      { a: filledPng!.png, b: unfilledPng!.png, boxes },
    );
    // A name at scale 2 inks thousands of pixels; 100 rules out only noise.
    expect(changed['party_a']).toBeGreaterThan(100);
    expect(changed['party_b']).toBeGreaterThan(100);

    // Step 6: the demo stops here. The test goes on to open the sign view, as
    // it would open if the user asked to sign, and checks the filled names on
    // the rendered document. Nobody signs.
    expect(links).toEqual([]);
    const started = (await call('request_signature', { pdf_path: pdfPath, request, timeout_seconds: 120 })).structuredContent;
    expect(started).toMatchObject({ status: 'pending', browser_opened: true });
    expect(links).toHaveLength(1);

    const problems = watch(page);
    await openSignView(page, links[0]!);
    await expect(page.getByTestId('field-box-effective_date')).toContainText(/^\d{4}-\d{2}-\d{2}/);
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
