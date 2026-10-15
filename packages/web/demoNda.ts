import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, type PDFContext, type PDFObject } from '@cantoo/pdf-lib';

/**
 * The demo document for agents: the sample NDA with its form fields removed,
 * so an agent must place every field itself. Served at /demo-nda.pdf.
 *
 * The output is deterministic: the same input gives the same bytes, so the
 * SHA-256 of the demo document stays stable from build to build.
 */
export async function flattenForDemo(input: Uint8Array): Promise<Uint8Array> {
  // updateMetadata: false keeps the producer and dates as they are, so no clock reaches the output.
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const { context, catalog } = doc;
  const removed = new Set<PDFRef>();

  // The form: the AcroForm dictionary and every field object it lists.
  const acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (acroForm) {
    const collect = (ref: unknown) => {
      if (!(ref instanceof PDFRef) || removed.has(ref)) return;
      removed.add(ref);
      const kids = context.lookupMaybe(ref, PDFDict)?.lookupMaybe(PDFName.of('Kids'), PDFArray);
      for (const kid of kids?.asArray() ?? []) collect(kid);
    };
    for (const field of acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray)?.asArray() ?? []) collect(field);
  }
  catalog.delete(PDFName.of('AcroForm'));

  // The widgets: every widget annotation on every page. Other annotations stay.
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    const kept = annots.asArray().filter((entry) => {
      const annot = entry instanceof PDFRef ? context.lookupMaybe(entry, PDFDict) : entry instanceof PDFDict ? entry : undefined;
      const isWidget = annot?.get(PDFName.of('Subtype')) === PDFName.of('Widget');
      if (isWidget && entry instanceof PDFRef) removed.add(entry);
      return !isWidget;
    });
    if (kept.length === 0) page.node.delete(PDFName.of('Annots'));
    else page.node.set(PDFName.of('Annots'), context.obj(kept));
  }

  for (const ref of removed) context.delete(ref);
  pruneUnreachable(context);
  return doc.save({ useObjectStreams: false });
}

/**
 * Delete every object that the document no longer reaches from its catalog or
 * its info dictionary: the old form dictionary and annotation arrays, widget
 * appearances and fonts, and the cross-reference and linearization objects of
 * the input.
 */
function pruneUnreachable(context: PDFContext): void {
  const reached = new Set<PDFRef>();
  const pending: PDFObject[] = [context.trailerInfo.Root, context.trailerInfo.Info].filter((root): root is PDFObject => !!root);
  while (pending.length > 0) {
    const object = pending.pop()!;
    if (object instanceof PDFRef) {
      if (reached.has(object)) continue;
      reached.add(object);
      const target = context.lookup(object);
      if (target) pending.push(target);
    } else if (object instanceof PDFDict) {
      pending.push(...object.values());
    } else if (object instanceof PDFArray) {
      pending.push(...object.asArray());
    } else if (object instanceof PDFStream) {
      pending.push(object.dict);
    }
  }
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reached.has(ref)) context.delete(ref);
  }
}
