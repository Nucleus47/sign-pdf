import { describe, expect, it } from 'vitest';
import { acroFieldLabel, isPlainLabel, labelEchoesPageText } from './labels.ts';

describe('isPlainLabel', () => {
  it('accepts short names', () => {
    for (const label of ['Party A', 'Date', 'Print Name', 'Party A’s Signature', 'Company name']) expect(isPlainLabel(label), label).toBe(true);
  });

  it('rejects fragments of running text, numbers and placeholders', () => {
    for (const label of ['day of', '20', 'undefined', 'hereinafter known as', 'from the date of disclosure refrain from', 'This Agreement shall remain in effect']) {
      expect(isPlainLabel(label), label).toBe(false);
    }
  });
});

describe('acroFieldLabel', () => {
  it('prefers a plain tooltip, then a plain name, then the type and number', () => {
    expect(acroFieldLabel({ name: 'hereinafter known as', type: 'text', tooltip: 'Party A' }, 4)).toBe('Party A');
    expect(acroFieldLabel({ name: 'Date_2', type: 'text', tooltip: 'of' }, 9)).toBe('Date 2');
    expect(acroFieldLabel({ name: 'day of', type: 'text' }, 1)).toBe('Text 1');
    expect(acroFieldLabel({ name: 'x of', type: 'checkbox' }, 2)).toBe('Checkbox 2');
  });
});

describe('labelEchoesPageText', () => {
  it('is true only for a fragment that the nearby text contains', () => {
    expect(labelEchoesPageText('hereinafter known as', ['Example Co, hereinafter known as Party A'])).toBe(true);
    expect(labelEchoesPageText('hereinafter known as', ['Something else'])).toBe(false);
    expect(labelEchoesPageText('Date', ['Date ____'])).toBe(false);
  });
});
