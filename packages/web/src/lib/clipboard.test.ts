import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard.ts';

function field(text: string): HTMLTextAreaElement {
  const area = document.createElement('textarea');
  area.value = text;
  document.body.append(area);
  return area;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('copyText', () => {
  it('uses the Clipboard API when there is one', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const execCommand = vi.fn(() => true);
    expect(await copyText('report', field('report'), { clipboard: { writeText }, execCommand })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('report');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('selects the text and copies it the old way when the Clipboard API is missing', async () => {
    const area = field('report text');
    const execCommand = vi.fn(() => true);
    expect(await copyText('report text', area, { clipboard: undefined, execCommand })).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe('report text'.length);
  });

  it('falls back when the Clipboard API refuses', async () => {
    const execCommand = vi.fn(() => true);
    const writeText = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
    expect(await copyText('r', field('r'), { clipboard: { writeText }, execCommand })).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  it('returns false and leaves the text selected when nothing can copy', async () => {
    const area = field('report');
    expect(await copyText('report', area, { clipboard: undefined, execCommand: () => false })).toBe(false);
    expect(area.selectionEnd).toBe('report'.length);
    expect(await copyText('report', area, { clipboard: undefined, execCommand: () => { throw new Error('no'); } })).toBe(false);
    expect(await copyText('report', null, { clipboard: undefined, execCommand: () => true })).toBe(false);
  });
});
