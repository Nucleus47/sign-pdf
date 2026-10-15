/**
 * Drawing helpers shared by the signing step and the hand-off PDF. Reached
 * only through `./sign.ts`.
 */
import {
  LineCapStyle,
  LineJoinStyle,
  concatTransformationMatrix,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingColor,
  stroke,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from '@cantoo/pdf-lib';
import type { Rect } from '@sign-pdf/spec';
import { rectFrameMatrix, type PageGeometry } from './geometry.ts';
import type { TextLayout } from './text-layout.ts';

export const BLACK = rgb(0, 0, 0);

/** Run drawing calls in a frame whose origin is the rect's displayed bottom-left corner, y up. */
export function drawInRect(page: PDFPage, geometry: PageGeometry, rect: Rect, draw: () => void): void {
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...rectFrameMatrix(geometry, rect)));
  draw();
  page.pushOperators(popGraphicsState());
}

export function drawTextLayout(page: PDFPage, layout: TextLayout, font: PDFFont): void {
  for (const line of layout.lines) {
    if (line.text === '') continue;
    page.drawText(line.text, { x: line.x, y: line.baseline, size: layout.size, font, color: BLACK });
  }
}

export function drawCheckMark(page: PDFPage, rect: Rect): void {
  const side = Math.min(rect.width, rect.height);
  const left = (rect.width - side) / 2;
  const bottom = (rect.height - side) / 2;
  const at = (u: number, v: number): [number, number] => [left + u * side, bottom + v * side];
  page.pushOperators(
    setStrokingColor(BLACK),
    setLineWidth(Math.max(0.8, side * 0.1)),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
    moveTo(...at(0.2, 0.5)),
    lineTo(...at(0.42, 0.24)),
    lineTo(...at(0.8, 0.78)),
    stroke(),
  );
}

export function drawSignature(page: PDFPage, rect: Rect, image: PDFImage): void {
  const scale = Math.min(rect.width / image.width, rect.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  page.drawImage(image, { x: (rect.width - width) / 2, y: (rect.height - height) / 2, width, height });
}
