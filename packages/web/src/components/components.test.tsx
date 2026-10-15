import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Rect } from '@sign-pdf/spec';
import { looksLikePdf, parseRequestText } from '../lib/files.ts';
import { SHA } from '../testing/fixtures.ts';
import { Dialog } from './Dialog.tsx';
import { FieldCanvas, type CanvasField } from './FieldCanvas.tsx';
import { PreparerNote } from './ui.tsx';

describe('PreparerNote', () => {
  it('renders untrusted text as text', () => {
    render(<PreparerNote title="<h1>Title</h1>" note={'line one\n<script>alert(1)</script>'} />);
    const note = screen.getByTestId('preparer-note');
    expect(note.querySelector('h1, script')).toBeNull();
    expect(screen.getByTestId('preparer-title').textContent).toBe('<h1>Title</h1>');
    expect(screen.getByTestId('preparer-text').textContent).toBe('line one\n<script>alert(1)</script>');
    expect(note).toHaveTextContent('It was not written by sign-pdf');
  });

  it('removes direction overrides and isolates the text', () => {
    render(<PreparerNote title={'\u202Eeltit'} note={'\u202Edesrever \u2066eton\u2069'} />);
    expect(screen.getByTestId('preparer-title').textContent).toBe('eltit');
    expect(screen.getByTestId('preparer-text').textContent).toBe('desrever eton');
    expect(screen.getByTestId('preparer-text')).toHaveClass('untrusted-text');
  });

  it('renders nothing when there is no title or note', () => {
    const { container } = render(<PreparerNote title="  " />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Dialog', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          open
        </button>
        {open && (
          <Dialog title="Leave?" onClose={() => setOpen(false)} footer={<button type="button">Last</button>}>
            <button type="button" data-autofocus="">
              First
            </button>
          </Dialog>
        )}
      </>
    );
  }

  it('is a labelled modal, traps focus, closes on Escape and returns focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByText('open');
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Leave?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('First')).toHaveFocus();

    // Tab order inside the dialog: Close, First, Last.
    await user.tab();
    expect(screen.getByText('Last')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByText('Last')).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe('FieldCanvas', () => {
  const page = { page: 1, width: 612, height: 792 };
  const rect: Rect = { page: 1, x: 100, y: 200, width: 180, height: 18 };
  const field: CanvasField = { id: 'name', type: 'text', name: 'Full name', rect };

  function mount(scale: number, extra: Partial<Parameters<typeof FieldCanvas>[0]> = {}) {
    const onChangeRect = vi.fn();
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    render(
      <FieldCanvas
        page={page}
        scale={scale}
        fields={[field, { ...field, id: 'other', rect: { ...rect, page: 2 } }]}
        selectedId="name"
        onSelect={onSelect}
        onChangeRect={onChangeRect}
        onDelete={onDelete}
        {...extra}
      />,
    );
    return { onChangeRect, onDelete, onSelect, box: screen.getByTestId('field-box-name') };
  }

  it('draws only the fields of its page, positioned in pixels at the zoom', () => {
    const { box } = mount(1.5);
    expect(screen.queryByTestId('field-box-other')).toBeNull();
    expect(box.style.left).toBe('150px');
    expect(box.style.top).toBe('300px');
    expect(box.style.width).toBe('270px');
    expect(box).toHaveAccessibleName(/Text field Full name: page 1, 100 pt from the left, 200 pt from the top/);
    expect(box).toHaveAttribute('tabindex', '0');
  });

  it('moves with arrow keys, resizes with Alt, deletes with Delete', () => {
    const { box, onChangeRect, onDelete } = mount(2);
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(onChangeRect).toHaveBeenLastCalledWith('name', { ...rect, x: 101 });
    fireEvent.keyDown(box, { key: 'ArrowUp', shiftKey: true });
    expect(onChangeRect).toHaveBeenLastCalledWith('name', { ...rect, y: 190 });
    fireEvent.keyDown(box, { key: 'ArrowDown', altKey: true });
    expect(onChangeRect).toHaveBeenLastCalledWith('name', { ...rect, height: 19 });
    fireEvent.keyDown(box, { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledWith('name');
  });

  it('turns a drag in pixels into a move in points at the current zoom', () => {
    const { box, onChangeRect } = mount(2);
    fireEvent.pointerDown(box, { pointerId: 1, button: 0, clientX: 300, clientY: 500 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 340, clientY: 480 });
    // 40px right and 20px up at zoom 2 is 20pt right and 10pt up.
    expect(onChangeRect).toHaveBeenLastCalledWith('name', { ...rect, x: 120, y: 190 });
    fireEvent.pointerUp(box, { pointerId: 1 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 400, clientY: 400 });
    expect(onChangeRect).toHaveBeenCalledTimes(1);
  });

  it('reports the clicked point in page points when placing', () => {
    const onPlace = vi.fn();
    mount(2, { placingType: 'signature', onPlace });
    const canvas = screen.getByTestId('field-canvas-1');
    fireEvent.click(canvas, { clientX: 144, clientY: 72 });
    expect(onPlace).toHaveBeenCalledWith({ page: 1, x: 72, y: 36 });
  });

  it('does not move a locked field', () => {
    const onChangeRect = vi.fn();
    render(
      <FieldCanvas page={page} scale={1} fields={[{ ...field, locked: true }]} selectedId={null} onSelect={() => undefined} onChangeRect={onChangeRect} />,
    );
    fireEvent.keyDown(screen.getByTestId('field-box-name'), { key: 'ArrowRight' });
    expect(onChangeRect).not.toHaveBeenCalled();
  });
});

describe('opened files', () => {
  it('recognises a PDF by its content, not its name', () => {
    expect(looksLikePdf(new TextEncoder().encode('%PDF-1.7\n...'))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode('\n\n%PDF-1.4'))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode('plain text'))).toBe(false);
    expect(looksLikePdf(new Uint8Array())).toBe(false);
  });

  it('parses a request file and explains what is wrong with a bad one', () => {
    const good = {
      version: 1,
      document: { name: 'a.pdf', sha256: SHA },
      fields: [{ id: 'sig', type: 'signature', assignee: 'human', placement: { kind: 'rect', page: 1, x: 1, y: 1, width: 10, height: 10 } }],
    };
    expect(parseRequestText(JSON.stringify(good)).ok).toBe(true);
    expect(parseRequestText('{')).toEqual({ ok: false, error: 'The request file is not valid JSON.' });
    const forged = { ...good, fields: [{ ...good.fields[0], value: 'forged' }] };
    const result = parseRequestText(JSON.stringify(forged));
    expect(result.ok).toBe(false);
  });
});
