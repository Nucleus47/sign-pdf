import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AuditField, AuditRecord } from '@sign-pdf/spec';
import type { FinalizeResult } from '../lib/core.ts';
import { UNTRUSTED_TEXT_CLASS } from '../lib/displayText.ts';
import { makeAudit, makeResolved, SHA } from '../testing/fixtures.ts';
import { AuditView, Signed } from './Signed.tsx';

// pdf.js needs a real browser.
vi.mock('../components/PdfViewer.tsx', () => ({ PdfViewer: () => <div data-testid="viewer-stub" /> }));

const rect = { page: 1, x: 10, y: 10, width: 100, height: 20 };
const signature: AuditField = {
  id: 'signature',
  type: 'signature',
  assignee: 'human',
  filledBy: 'human',
  changedByHuman: false,
  movedByHuman: false,
  rect,
  signatureMethod: 'typed',
  signatureSha256: SHA,
};

function show(audit: AuditRecord) {
  const result: FinalizeResult = { pdf: new Uint8Array([1]), audit, sha256: 'd'.repeat(64) };
  render(
    <Signed documentName="agreement.pdf" resolved={makeResolved()} result={result} sent={null} onStartOver={() => undefined} />,
  );
}

describe('Signed', () => {
  it('shows each fact once: the file name, who signed, and the fingerprint', () => {
    const company: AuditField = {
      id: 'company',
      type: 'text',
      assignee: 'agent',
      filledBy: 'agent',
      changedByHuman: false,
      movedByHuman: false,
      rect,
      value: 'Example Company Ltd',
    };
    show({ ...makeAudit(), fields: [signature, company] });

    // The file name is in the download button only.
    expect(screen.getAllByText('agreement-signed.pdf')).toHaveLength(1);
    expect(screen.getByTestId('download-signed')).toHaveTextContent('agreement-signed.pdf');

    // One signer: name, time and the signed fields, once.
    expect(screen.getAllByText('Test Signer')).toHaveLength(1);
    expect(screen.getByTestId('audit-signer')).toHaveTextContent('Test Signer');
    expect(screen.getByTestId('audit-signed')).toHaveTextContent('Signature');
    // Both hold untrusted text from the document or the signer.
    expect(screen.getByTestId('audit-signer')).toHaveClass(UNTRUSTED_TEXT_CLASS);
    expect(screen.getByTestId('audit-signed')).toHaveClass(UNTRUSTED_TEXT_CLASS);
    expect(screen.getAllByText('Signature')).toHaveLength(1);
    expect(document.querySelectorAll('time')).toHaveLength(1);
    expect(screen.queryByText('Signed by the human')).toBeNull();
    // The preparer's group is a different fact and stays.
    expect(screen.getByTestId('audit-agent-filled')).toHaveTextContent('Company name: Example Company Ltd');

    // The fingerprint stays visible; the original document folds into its own disclosure.
    expect(screen.getByTestId('signed-sha256')).toHaveTextContent('d'.repeat(64));
    const original = screen.getByTestId('audit-original');
    expect(original.tagName).toBe('DETAILS');
    expect(original).not.toHaveAttribute('open');
    expect(within(original).getByText('Original document', { selector: 'summary' })).toBeInTheDocument();
    expect(within(original).getByTestId('audit-document-name')).toHaveTextContent('agreement.pdf');
    expect(original).toHaveTextContent(SHA);
  });

  it('lists several signers once, in turn, without a second list of signed fields', () => {
    const base = makeAudit();
    const pass = { consent: base.consent, signedAt: base.signedAt, previousSha256: SHA };
    show({
      ...base,
      passes: [
        { ...pass, signerId: 'a', signer: { name: 'Signer One' }, fieldIds: ['signature'] },
        { ...pass, signerId: 'b', signer: { name: 'Signer Two' }, fieldIds: [] },
      ],
      fields: [{ ...signature, signerId: 'a' }],
    });
    expect(screen.getByTestId('audit-pass-a')).toHaveTextContent('Signer One');
    expect(screen.getByTestId('audit-pass-a')).toHaveTextContent('Signature');
    expect(screen.getByTestId('audit-pass-b')).toHaveTextContent('Signer Two');
    expect(screen.getAllByText('Signature')).toHaveLength(1);
    expect(screen.queryByTestId('audit-signed')).toBeNull();
    expect(screen.queryByTestId('audit-signer')).toBeNull();
  });

  it('the verify view, without field names, still shows the signer and the original document', () => {
    render(<AuditView audit={{ ...makeAudit(), fields: [signature] }} />);
    expect(screen.getByTestId('audit-signer')).toHaveTextContent('Test Signer');
    expect(screen.getByTestId('audit-signed')).toHaveTextContent('signature');
    const original = screen.getByTestId('audit-original');
    expect(original.tagName).toBe('DETAILS');
    expect(within(original).getByText('Original document', { selector: 'summary' })).toBeInTheDocument();
    expect(within(original).getByTestId('audit-document-name')).toHaveTextContent('agreement.pdf');
  });
});
