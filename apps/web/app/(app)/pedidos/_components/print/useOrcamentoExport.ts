'use client';

/**
 * Capture an on-screen `<OrcamentoSheet>` and **silently download** it as a JPEG
 * image (to share on WhatsApp) or a PDF file (the same raster, paginated onto
 * A4) — no browser print dialog, one format at a time (the UI offers them as
 * separate actions). `html-to-image` + `jsPDF` are lazy-`import()`'d so they
 * ship as a separate chunk, never in the main bundle.
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

export type OrcamentoFormat = 'image' | 'pdf';

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Capture the node to a canvas and save it as the requested format. */
async function captureOrcamento(
  node: HTMLElement,
  baseName: string,
  format: OrcamentoFormat,
): Promise<void> {
  const { toCanvas } = await import('html-to-image');
  const canvas = await toCanvas(node, {
    pixelRatio: PIXEL_RATIO,
    backgroundColor: '#ffffff',
    // Product photos are tokenized Storage URLs; cacheBust would append a second
    // `?` and break them, so leave it off.
    cacheBust: false,
  });

  if (format === 'image') {
    const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    if (blob) saveBlob(blob, `${baseName}.jpg`);
    return;
  }

  // PDF — the same raster, sliced across A4 pages so a long orçamento paginates
  // instead of overflowing one tall page.
  const { jsPDF } = await import('jspdf');
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
  /** Capture and download the orçamento in the given format. */
  readonly exportAs: (format: OrcamentoFormat) => Promise<void>;
}

export function useOrcamentoExport(model: PedidoPrintModel | null): OrcamentoExport {
  const ref = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportAs = useCallback(
    (format: OrcamentoFormat) => {
      const node = ref.current;
      if (!node || !model) return Promise.resolve();
      setExporting(true);
      setError(null);
      const baseName = `orcamento-${model.numero ?? model.pedidoId}`;
      return captureOrcamento(node, baseName, format)
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setExporting(false));
    },
    [model],
  );

  return { ref, exporting, error, exportAs };
}
