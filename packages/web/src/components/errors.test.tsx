import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordUncaught, resetUncaught } from '../lib/lastError.ts';
import { BrowserBanner, NOT_SECURE_TEXT, OUT_OF_DATE_TEXT } from './BrowserBanner.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { ErrorDetails } from './ErrorDetails.tsx';

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

function openDetails(): HTMLTextAreaElement {
  const details = screen.getByTestId('error-details') as HTMLDetailsElement;
  expect(details.open).toBe(false);
  details.open = true;
  fireEvent(details, new Event('toggle'));
  return screen.getByTestId('error-details-text') as HTMLTextAreaElement;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
  resetUncaught();
});

describe('ErrorDetails', () => {
  it('starts collapsed, shows a read-only report when opened, and copies it', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    stubClipboard(writeText);
    render(<ErrorDetails failure={{ code: 'invalid-pdf', message: 'The PDF has no pages.' }} file={{ extension: 'pdf', bytes: 10 }} />);
    expect(screen.queryByTestId('error-details-text')).toBeNull();
    const text = openDetails();
    expect(text).toHaveAttribute('readonly');
    expect(text.value).toContain('code: invalid-pdf');
    expect(text.value).toContain('file: .pdf 10 bytes');
    fireEvent.click(screen.getByTestId('error-details-copy'));
    await waitFor(() => expect(screen.getByTestId('error-details-status')).toHaveTextContent('The details are copied.'));
    expect(writeText).toHaveBeenCalledWith(text.value);
  });

  it('asks the person to copy the text when no copy method works', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
    render(<ErrorDetails failure={{ code: 'x', message: 'y' }} />);
    openDetails();
    fireEvent.click(screen.getByTestId('error-details-copy'));
    await waitFor(() => expect(screen.getByTestId('error-details-status')).toHaveTextContent('Select the text, then copy it.'));
  });

  it('includes the last error that nothing caught', () => {
    render(<ErrorDetails failure={{ code: 'invalid-pdf', message: 'x' }} />);
    const text = openDetails();
    act(() => recordUncaught(new TypeError('undefined is not a function'), 'unhandled-rejection'));
    expect(text.value).toContain('last uncaught error: unhandled-rejection: TypeError: undefined is not a function');
  });
});

describe('ErrorBoundary', () => {
  it('shows the fallback with the details when a view throws while it draws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Broken(): never {
      throw Object.assign(new Error('synthetic render failure'), { code: 'synthetic' });
    }
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('boundary-error')).toHaveTextContent('The page stopped working');
    expect(screen.getByTestId('boundary-reload')).toBeInTheDocument();
    const text = openDetails();
    expect(text.value).toContain('code: synthetic');
    expect(text.value).toContain('message: synthetic render failure');
    // The component stack says which component failed.
    expect(text.value).toMatch(/at Broken/);
  });

  it('shows its children when nothing fails', () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
  });
});

describe('BrowserBanner', () => {
  it('says the browser is out of date and names what is missing', () => {
    render(<BrowserBanner missing={['structuredClone', 'crypto.subtle']} secure />);
    const banner = screen.getByTestId('browser-banner');
    expect(banner).toHaveTextContent(OUT_OF_DATE_TEXT);
    expect(banner).toHaveTextContent('Missing: structuredClone, crypto.subtle.');
    expect(OUT_OF_DATE_TEXT).toBe('This browser is out of date. Update it, then open this page again.');
  });

  it('shows nothing when no required feature is missing', () => {
    const { container } = render(<BrowserBanner missing={[]} secure />);
    expect(container).toBeEmptyDOMElement();
  });

  it('on plain http, asks for an https address instead of an update', () => {
    render(<BrowserBanner missing={['crypto.subtle']} secure={false} />);
    const banner = screen.getByTestId('browser-banner');
    expect(banner).toHaveTextContent(NOT_SECURE_TEXT);
    expect(banner).not.toHaveTextContent(OUT_OF_DATE_TEXT);
  });
});
