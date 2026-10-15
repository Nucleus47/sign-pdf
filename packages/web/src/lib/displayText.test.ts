import { describe, expect, it } from 'vitest';
import { makeAudit } from '../testing/fixtures.ts';
import { displayText } from './displayText.ts';
import { fieldName, summarizeAudit } from './signing.ts';

// Every bidirectional control character, written as escapes so this file stays readable.
const CONTROLS = [
  '\u202A', '\u202B', '\u202C', '\u202D', '\u202E',
  '\u2066', '\u2067', '\u2068', '\u2069',
  '\u200E', '\u200F', '\u061C',
];

describe('displayText', () => {
  it('removes every bidirectional control character', () => {
    for (const control of CONTROLS) {
      expect(displayText(`ab${control}cd`)).toBe('abcd');
    }
    expect(displayText(CONTROLS.join(''))).toBe('');
  });

  it('shows a disguised file name as it is stored', () => {
    // On screen the raw name reads "invoiceexe.pdf".
    expect(displayText('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
  });

  it('leaves ordinary text alone, including right-to-left letters and line breaks', () => {
    const text = 'Line one\nשלום עולם \u0645\u0631\u062D\u0628\u0627 – café';
    expect(displayText(text)).toBe(text);
  });

  it('is applied to field labels and to what the audit view lists', () => {
    expect(fieldName({ id: 'f1', type: 'text', label: '\u202EemaN' })).toBe('emaN');
    expect(fieldName({ id: 'f1', type: 'text', label: '\u202E \u200F' })).toBe('Text field');
    const rect = { page: 1, x: 0, y: 0, width: 10, height: 10 };
    const audit = {
      ...makeAudit(),
      fields: [
        { id: 'f1', type: 'text' as const, assignee: 'agent' as const, filledBy: 'agent' as const, changedByHuman: false, movedByHuman: false, rect, value: '\u202Edeyalp' },
      ],
    };
    expect(summarizeAudit(audit, new Map([['f1', '\u2067Label']])).agentFilled).toEqual(['Label: deyalp']);
  });
});
