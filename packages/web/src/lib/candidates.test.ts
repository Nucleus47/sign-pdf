import { describe, expect, it } from 'vitest';
import { safeParseSignRequest, type Rect, type ResolvedRequest, type SignRequestInput } from '@sign-pdf/spec';
import { describeMark, markAt, markLabel, numberMarks, probeRequest, resolveTargets } from './candidates.ts';
import type { PlacementCandidate } from './core.ts';

const doc = { name: 'a.pdf', sha256: 'a'.repeat(64) };

function candidate(page: number, y: number, extra: Partial<PlacementCandidate> = {}): PlacementCandidate {
  return {
    kind: 'label',
    text: 'Signature:',
    page,
    x: 72,
    y,
    width: 60,
    height: 12,
    suggested: { placement: { kind: 'anchor', text: 'Signature:', page, align: 'right', width: 150, height: 20 }, type: 'signature' },
    ...extra,
  } as PlacementCandidate;
}

const target = (page: number, y: number): Rect => ({ page, x: 136, y, width: 150, height: 20 });

describe('numbered places', () => {
  it('numbers per page in the given order and skips places that did not resolve', () => {
    const candidates = [candidate(1, 100), candidate(1, 200), candidate(2, 100), candidate(2, 200), candidate(2, 300)];
    const marks = numberMarks(candidates, [target(1, 100), target(1, 200), target(2, 100), undefined, target(2, 300)]);
    expect(marks.map((mark) => [mark.page, mark.number])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
    ]);
    expect(markAt(marks, 2, 2)?.target).toEqual(target(2, 300));
    expect(markAt(marks, 2, 3)).toBeUndefined();
    expect(markAt(marks, 1, 1)?.placement).toEqual(candidates[0]?.suggested.placement);
  });

  it('describes each kind in words a screen reader or agent can read', () => {
    const [mark] = numberMarks([candidate(2, 100)], [target(2, 100)]);
    expect(mark && markLabel(mark)).toBe('1: after “Signature:”, page 2');
    expect(describeMark({ kind: 'line', text: 'Name' })).toBe('line after “Name”');
    expect(describeMark({ kind: 'line', text: '______' })).toBe('blank line');
    expect(describeMark({ kind: 'widget', text: 'Date_2' })).toBe('form field “Date_2”');
    expect(describeMark({ kind: 'label', text: `x${'y'.repeat(80)}` }).length).toBeLessThan(60);
  });

  it('starts a field as text when the place suggests no type', () => {
    const plain = candidate(1, 100, { suggested: { placement: { kind: 'rect', ...target(1, 100) } } });
    expect(numberMarks([plain], [target(1, 100)])[0]?.type).toBe('text');
  });
});

describe('resolving places', () => {
  const candidates = [candidate(1, 100), candidate(1, 200, { kind: 'widget', text: 'Date', suggested: { placement: { kind: 'acroField', name: 'Date' }, type: 'date' } })];

  it('asks for one valid request with a field per place', () => {
    const request = probeRequest(candidates, doc);
    expect(safeParseSignRequest(request).success).toBe(true);
    expect(request.fields.map((field) => [field.id, field.type, field.placement.kind])).toEqual([
      ['c1', 'signature', 'anchor'],
      ['c2', 'date', 'acroField'],
    ]);
  });

  it('falls back to one request per place when the batch fails, dropping the ones that fail', async () => {
    const calls: SignRequestInput[] = [];
    const resolve = (request: SignRequestInput): Promise<ResolvedRequest> => {
      calls.push(request);
      if (request.fields.length > 1 || request.fields[0]?.placement.kind === 'acroField') {
        return Promise.reject(new Error('cannot resolve'));
      }
      return Promise.resolve({ fields: [{ rect: target(1, 100) }] } as unknown as ResolvedRequest);
    };
    expect(await resolveTargets(candidates, doc, resolve)).toEqual([target(1, 100), undefined]);
    expect(calls).toHaveLength(3);
    expect(await resolveTargets([], doc, resolve)).toEqual([]);
  });
});
