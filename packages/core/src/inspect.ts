import {
  PDFArray,
  PDFDict,
  PDFButton,
  PDFCheckBox,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFRawStream,
  PDFSignature,
  PDFString,
  PDFTextField,
  type PDFDocument,
  type PDFField,
  type PDFWidgetAnnotation,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import type { Rect } from '@sign-pdf/spec';
import { nativeRectToDisplay, type PageGeometry } from './geometry.ts';
import { sha256Hex } from './hash.ts';
import type {
  AcroFieldInfo,
  InspectOptions,
  InspectionPage,
  InspectionWarning,
  PdfInspection,
  PdfInspectionSummary,
  SummaryAcroField,
  SummaryTextLine,
  TextItem,
} from './index.ts';
import { assertPdfSize } from './limits.ts';
import { loadPdf } from './load.ts';
import { extractPageContent } from './pdfjs.ts';
import { buildLines } from './resolve.ts';

const IMAGE_ONLY_HINT =
  'Anchors and candidates cannot work on this page. Call render_preview on the bare page, look at the image, and place fields with explicit rect placements using the preview rulers.';

function paintedXObjectNames(content: string): string[] {
  const found: string[] = [];
  let previousName: string | undefined;
  for (let index = 0; index < content.length; ) {
    const char = content[index] ?? '';
    if (/\s/.test(char)) {
      index++;
    } else if (char === '%') {
      const newline = content.indexOf('\n', index + 1);
      index = newline < 0 ? content.length : newline + 1;
      previousName = undefined;
    } else if (char === '(') {
      let depth = 1;
      index++;
      while (index < content.length && depth > 0) {
        const current = content[index++];
        if (current === '\\') index++;
        else if (current === '(') depth++;
        else if (current === ')') depth--;
      }
      previousName = undefined;
    } else if (char === '<') {
      if (content[index + 1] === '<') index += 2;
      else {
        const close = content.indexOf('>', index + 1);
        index = close < 0 ? content.length : close + 1;
      }
      previousName = undefined;
    } else if (char === '/') {
      const start = ++index;
      while (index < content.length && !/[\s()<>\[\]{}\/%]/.test(content[index] ?? '')) index++;
      previousName = content.slice(start, index).replace(/#([\da-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    } else {
      const start = index;
      while (index < content.length && !/[\s()<>\[\]{}\/%]/.test(content[index] ?? '')) index++;
      if (index === start) {
        // PDF delimiters are tokens too. Consuming them keeps arrays,
        // dictionaries and stray delimiters from stalling this scanner.
        index++;
        previousName = undefined;
        continue;
      }
      const token = content.slice(start, index);
      if (token === 'Do' && previousName !== undefined) found.push(previousName);
      previousName = undefined;
    }
  }
  return found;
}

function paintedImageXObject(doc: PDFDocument, page: ReturnType<PDFDocument['getPages']>[number]): boolean {
  const visited = new Set<PDFRawStream>();
  const streamHasImage = (stream: PDFRawStream, inheritedResources: PDFDict, depth: number): boolean => {
    if (depth > 10 || visited.has(stream)) return false;
    visited.add(stream);
    const resources = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? inheritedResources;
    const xObjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xObjects) return false;
    const content = new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode());
    for (const name of paintedXObjectNames(content)) {
      const object = xObjects.lookup(PDFName.of(name));
      if (!(object instanceof PDFRawStream)) continue;
      const subtype = object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString();
      if (subtype === '/Image' || (subtype === '/Form' && streamHasImage(object, resources, depth + 1))) return true;
    }
    return false;
  };

  const resources = page.node.Resources();
  const contents = page.node.Contents();
  if (!resources || !contents) return false;
  const streams = contents instanceof PDFArray ? contents.asArray().map((item) => doc.context.lookup(item)) : [contents];
  return streams.some((stream) => stream instanceof PDFRawStream && streamHasImage(stream, resources, 0));
}

function diagnosePages(
  doc: PDFDocument,
  pages: readonly PageGeometry[],
  text: readonly TextItem[],
): InspectionPage[] {
  return pages.map((geometry) => {
    const textRunCount = text.filter((item) => item.page === geometry.page && item.text.trim() !== '').length;
    const hasText = textRunCount > 0;
    return {
      page: geometry.page,
      width: geometry.width,
      height: geometry.height,
      textRunCount,
      hasText,
      // A page is image-only when its content (or a Form XObject it paints) invokes
      // an Image XObject and pdf.js extracts no non-whitespace text runs.
      imageOnly: !hasText && paintedImageXObject(doc, doc.getPages()[geometry.page - 1]!),
    };
  });
}

function imageOnlyWarnings(pages: readonly InspectionPage[]): InspectionWarning[] {
  return pages.flatMap((page) => (page.imageOnly ? [{ code: 'image-only-page' as const, hint: `Page ${page.page}: ${IMAGE_ONLY_HINT}` }] : []));
}

function summaryLines(text: readonly TextItem[]): SummaryTextLine[] {
  const pages = [...new Set(text.map((item) => item.page))].sort((a, b) => a - b);
  // A first-pass summary keeps short, likely field labels instead of repeating
  // body copy. Full mode remains available when an anchor is not in this subset.
  const fieldClue = /:|_{3,}|\b(signature|initials?|date|name|title|company|address|e-?mail|phone|city|state|zip|witness|sign here|signed here)\b/;
  return pages.flatMap((page) =>
    buildLines(text.filter((item) => item.page === page))
      .map(({ text: line }) => ({ page, text: line }))
      .filter(({ text: line }) => fieldClue.test(line)),
  );
}

export function hasAcroForm(doc: PDFDocument): boolean {
  return doc.catalog.has(PDFName.of('AcroForm'));
}

function fieldType(field: PDFField): AcroFieldInfo['type'] {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'optionList';
  if (field instanceof PDFSignature) return 'signature';
  if (field instanceof PDFButton) return 'button';
  return 'other';
}

function fieldValue(field: PDFField): string | boolean | undefined {
  try {
    if (field instanceof PDFTextField) return field.getText();
    if (field instanceof PDFCheckBox) return field.isChecked();
    if (field instanceof PDFRadioGroup) return field.getSelected();
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      const selected = field.getSelected();
      return selected.length > 0 ? selected.join(', ') : undefined;
    }
  } catch {
    // Some values cannot be read as plain data (rich text, for example). The
    // field is still reported, without a value, so it stays usable as a placement.
  }
  return undefined;
}

/** Zero-based index of the page a widget sits on, or -1. */
export function widgetPageIndex(doc: PDFDocument, widget: PDFWidgetAnnotation): number {
  const pdfPages = doc.getPages();
  const pageRef = widget.P();
  const direct = pageRef ? pdfPages.findIndex((page) => page.ref === pageRef) : -1;
  if (direct >= 0) return direct;
  // /P is optional: fall back to the page whose /Annots lists the widget.
  const widgetRef = doc.context.getObjectRef(widget.dict);
  if (!widgetRef) return -1;
  return pdfPages.findIndex((page) => {
    const annots = page.node.Annots();
    if (!annots) return false;
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      if (entry instanceof PDFRef && entry === widgetRef) return true;
    }
    return false;
  });
}

/** The field's tooltip (TU), trimmed and at most 200 characters; empty when it has none. */
function fieldTooltip(field: PDFField): string {
  const tu = field.acroField.dict.lookup(PDFName.of('TU'));
  if (!(tu instanceof PDFString) && !(tu instanceof PDFHexString)) return '';
  try {
    return tu.decodeText().replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

/** Displayed rect of a field's first widget that sits on a page. */
export function firstWidgetRect(
  doc: PDFDocument,
  field: PDFField,
  pages: readonly PageGeometry[],
): Rect | undefined {
  for (const widget of field.acroField.getWidgets()) {
    const geometry = pages[widgetPageIndex(doc, widget)];
    if (!geometry) continue;
    const rect = nativeRectToDisplay(geometry, widget.getRectangle());
    if (rect.width > 0 && rect.height > 0) return rect;
  }
  return undefined;
}

export function listAcroFields(doc: PDFDocument, pages: readonly PageGeometry[]): AcroFieldInfo[] {
  if (!hasAcroForm(doc)) return [];
  return doc
    .getForm()
    .getFields()
    .map((field) => {
      const info: AcroFieldInfo = {
        name: field.getName(),
        type: fieldType(field),
        readOnly: field.isReadOnly(),
      };
      const rect = firstWidgetRect(doc, field, pages);
      if (rect) info.rect = rect;
      const value = fieldValue(field);
      if (value !== undefined) info.value = value;
      const tooltip = fieldTooltip(field);
      if (tooltip) info.tooltip = tooltip;
      return info;
    });
}

export function inspectPdf(pdf: Uint8Array, options: InspectOptions & { detail: 'summary' }): Promise<PdfInspectionSummary>;
export function inspectPdf(pdf: Uint8Array, options?: InspectOptions & { detail?: 'full' }): Promise<PdfInspection>;
export async function inspectPdf(
  pdf: Uint8Array,
  options: InspectOptions = {},
): Promise<PdfInspection | PdfInspectionSummary> {
  assertPdfSize(pdf.length);
  const { doc, pages } = await loadPdf(pdf);
  const content = await extractPageContent(pdf, pages, { rules: options.text !== false && options.rules === true });
  const inspectionPages = diagnosePages(doc, pages, content.text);
  const imageOnlyPages = inspectionPages.flatMap((page) => (page.imageOnly ? [page.page] : []));
  const warnings = imageOnlyWarnings(inspectionPages);
  const sha256 = await sha256Hex(pdf);
  if (options.detail === 'summary') {
    const acroFields: SummaryAcroField[] = listAcroFields(doc, pages).map(({ name, type, rect }) => ({
      name,
      type,
      ...(rect ? { rect } : {}),
    }));
    return {
      sha256,
      pages: inspectionPages,
      acroFields,
      textLines: options.text === false ? [] : summaryLines(content.text),
      imageOnlyPages,
      warnings,
    };
  }
  return {
    sha256,
    pages: inspectionPages,
    acroFields: listAcroFields(doc, pages),
    text: options.text === false ? [] : content.text,
    rules: options.text === false ? [] : content.rules,
    imageOnlyPages,
    warnings,
  };
}
