'use client';

/**
 * Capture an on-screen `<OrcamentoSheet>` once and **silently download** both a
 * JPEG image (to share on WhatsApp) and a PDF file (the same raster, paginated
 * onto A4) — no browser print dialog. `html-to-image` + `jsPDF` are
 * lazy-`import()`'d so they ship as a separate chunk, never in the main bundle.
 *
 * Errors surface via a returned `error` string (set in the promise's `.catch`,
 * not a `catch` clause — mirrors the EmitirLoteDialog pattern) so a failed
 * capture never crashes the page.
 */
import { useCallback, useRef, useState } from 'react';

import { saveBlob } from '@/lib/nfe/saveBlob';
import type { PedidoPrintModel } from '@/lib/pedido-print/model';

const JPEG_QUALITY = 0.95;
const PIXEL_RATIO = 2;

/** A4 portrait in points (jsPDF default unit). */
function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Capture the node to a canvas and save both the JPEG and a paginated A4 PDF. */
async function captureOrcamento(node: HTMLElement, baseName: string): Promise<void> {
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')]);

  const canvas = await toCanvas(node, {
    pixelRatio: PIXEL_RATIO,
    backgroundColor: '#ffffff',
    // The product photos are tokenized Storage URLs; cacheBust would append a
    // second `?` and break them, so leave it off.
    cacheBust: false,
  });

  // 1. JPEG image — silent download.
  const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
  if (blob) saveBlob(blob, `${baseName}.jpg`);

  // 2. PDF — the same raster, sliced across A4 pages so a long orçamento
  // paginates instead of overflowing one tall page.
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgH = (canvas.height * pageW) / canvas.width;

  let position = 0;
  let heightLeft = imgH;
  pdf.addImage(dataUrl, 'JPEG', 0, position, pageW, imgH);
  heightLeft -= pageH;
  while (heightLeft > 0) {
    position -= pageH;
    pdf.addPage();
    pdf.addImage(dataUrl, 'JPEG', 0, position, pageW, imgH);
    heightLeft -= pageH;
  }
  saveBlob(pdf.output('blob'), `${baseName}.pdf`);
}

export interface OrcamentoExport {
  /** Attach to the `<OrcamentoSheet>` wrapper. */
  readonly ref: React.RefObject<HTMLDivElement | null>;
  readonly exporting: boolean;
  readonly error: string | null;
  /** Capture once → download the JPEG and the PDF. */
  readonly run: () => Promise<void>;
}

export function useOrcamentoExport(model: PedidoPrintModel | null): OrcamentoExport {
  const ref = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    const node = ref.current;
    if (!node || !model) return Promise.resolve();
    setExporting(true);
    setError(null);
    const baseName = `orcamento-${model.numero ?? model.pedidoId}`;
    return captureOrcamento(node, baseName)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setExporting(false));
  }, [model]);

  return { ref, exporting, error, run };
}
