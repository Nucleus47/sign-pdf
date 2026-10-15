import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Packet } from '@sign-pdf/spec';
import { setCore } from '../lib/core.ts';
import { fakeCore, SHA, TWO_SIGNERS } from '../testing/fixtures.ts';
import { openPdfBytes, openSample, SAMPLE_REQUEST } from './open.ts';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]);
const ORIGINAL = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 2]);
let restore: () => void = () => undefined;

afterEach(() => {
  restore();
  vi.unstubAllGlobals();
});

describe('opening the sample', () => {
  it('reports an error, not a half-opened demo, when the demo request is missing', async () => {
    let opened = false;
    restore = setCore(fakeCore({ readHandoffPdf: () => { opened = true; return Promise.resolve(null); } }));
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(url.endsWith(SAMPLE_REQUEST) ? new Response('Not found', { status: 404 }) : new Response(PDF)),
    );
    const result = await openSample();
    expect(result).toMatchObject({ kind: 'error', message: 'The sample document could not be loaded.', failure: { code: 'sample-http-404' } });
    expect(opened).toBe(false);
  });
});

describe('opening a PDF', () => {
  it('resumes a hand-off PDF at the next turn, on the original PDF it carries', async () => {
    const request = { version: 1 as const, document: { name: 'agreement.pdf', sha256: SHA }, signers: TWO_SIGNERS, fields: [] };
    const pass = {
      signerId: 'a',
      signerName: 'Signer One',
      consent: { text: 'x', acceptedAt: '2026-01-02T03:04:05.000Z' },
      signedAt: '2026-01-02T03:04:05.000Z',
      values: {},
      signatures: {},
    };
    restore = setCore(
      fakeCore({
        readHandoffPdf: () =>
          Promise.resolve({ packet: { request, passes: [] } as unknown as Packet & { passes: [] }, pdf: ORIGINAL, passes: [pass] }),
      }),
    );
    const opened = await openPdfBytes('agreement-handoff.pdf', PDF);
    expect(opened.kind).toBe('sign');
    if (opened.kind !== 'sign') return;
    expect(opened.job.document).toEqual({ name: 'agreement.pdf', bytes: ORIGINAL });
    expect(opened.job.handoff?.passes).toEqual([pass]);
    expect(opened.job.request).toBe(request);
  });

  it('explains a damaged hand-off PDF', async () => {
    restore = setCore(
      fakeCore({ readHandoffPdf: () => Promise.reject(Object.assign(new Error('changed'), { code: 'invalid-handoff' })) }),
    );
    const opened = await openPdfBytes('x-handoff.pdf', PDF);
    expect(opened).toMatchObject({
      kind: 'error',
      message: 'This hand-off PDF is damaged or was changed. Ask the signer who sent it for a new copy.',
      failure: { code: 'invalid-handoff', message: 'changed' },
      file: { extension: 'pdf', bytes: PDF.length },
    });
  });

  it('opens any other PDF in the prepare view', async () => {
    restore = setCore(
      fakeCore({
        inspectPdf: () => Promise.resolve({ sha256: SHA, pageCount: 1, pages: [], acroFields: [] } as never),
      }),
    );
    const opened = await openPdfBytes('plain.pdf', PDF);
    expect(opened.kind).toBe('prepare');
  });
});
