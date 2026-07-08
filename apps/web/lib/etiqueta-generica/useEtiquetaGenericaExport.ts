'use client';

/**
 * Capture an `<EtiquetaGenericaSheet>` to a 10×15cm PDF `Blob`. Three surfaces:
 *
 *   - `exportEtiquetaGenericaPdf(node)` — the low-level node→PDF capture
 *     (`html-to-image` `toCanvas` → single-page `jsPDF`), reused by both paths.
 *   - `renderAndExportEtiquetaGenericaPdf(model)` — a self-contained HEADLESS
 *     path: it renders the Sheet into a detached off-screen node, captures it,
 *     and tears it down. The etiqueta PROVIDER (a non-React flow) calls this.
 *   - `useEtiquetaGenericaExport(model)` — the hook (a ref + `exportPdf`) for a
 *     UI that already renders the Sheet on screen (mirrors `useOrcamentoExport`).
 *
 * `html-to-image` + `jsPDF` are lazy-`import()`'d so they ship as a separate
 * chunk, never in the main bundle. Errors on the hook path surface via a
 * returned `error` string (set in the promise's `.catch`); the headless path
 * lets them propagate to its caller (the provider maps/handles them).
 */
import { useCallback, useRef, useState } from 'react';

import type { EtiquetaGenericaModel } from './model';

const JPEG_QUALITY = 0.95;
const PIXEL_RATIO = 2;

/** 10×15cm label page (portrait) in millimeters. */
const LABEL_FORMAT_MM: [number, number] = [100, 150];

/**
 * Capture an on-screen (or detached-but-attached) node to a single-page
 * 10×15cm PDF. The label is one page — no pagination.
 */
export async function exportEtiquetaGenericaPdf(node: HTMLElement): Promise<Blob> {
  const { toCanvas } = await import('html-to-image');
  const canvas = await toCanvas(node, {
    pixelRatio: PIXEL_RATIO,
    backgroundColor: '#ffffff',
    cacheBust: false,
  });

  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'mm', format: LABEL_FORMAT_MM });
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  pdf.addImage(dataUrl, 'JPEG', 0, 0, pageW, pageH);
  return pdf.output('blob');
}

/**
 * Headless build+capture: render the Sheet into a detached off-screen node,
 * export it to a PDF `Blob`, then unmount + remove the node. Used by the
 * generic-label provider, which has a model but no on-screen Sheet. The label
 * is text-only (no images to await), so a synchronous `flushSync` render is
 * fully painted before capture.
 */
export async function renderAndExportEtiquetaGenericaPdf(
  model: EtiquetaGenericaModel,
): Promise<Blob> {
  const { createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { flushSync } = await import('react-dom');
  const { EtiquetaGenericaSheet } = await import('./EtiquetaGenericaSheet');

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '0';
  container.style.pointerEvents = 'none';
  document.body.appendChild(container);

  const root = createRoot(container);
  try {
    // `flushSync` forces a synchronous commit so the DOM is painted before we
    // read it back with html-to-image.
    flushSync(() => {
      root.render(createElement(EtiquetaGenericaSheet, { model }));
    });
    const node = container.firstElementChild;
    if (!(node instanceof HTMLElement)) {
      throw new Error('Falha ao renderizar a etiqueta genérica.');
    }
    return await exportEtiquetaGenericaPdf(node);
  } finally {
    root.unmount();
    container.remove();
  }
}

export interface EtiquetaGenericaExport {
  /** Attach to the `<EtiquetaGenericaSheet>` wrapper. */
  readonly ref: React.RefObject<HTMLDivElement | null>;
  readonly exporting: boolean;
  readonly error: string | null;
  /** Capture the on-screen Sheet and download it as a PDF. */
  readonly exportPdf: () => Promise<Blob | null>;
}

export function useEtiquetaGenericaExport(
  model: EtiquetaGenericaModel | null,
): EtiquetaGenericaExport {
  const ref = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportPdf = useCallback((): Promise<Blob | null> => {
    const node = ref.current;
    if (!node || !model) return Promise.resolve(null);
    setExporting(true);
    setError(null);
    // Errors surface via the returned `error` string (set in `.catch`, not a
    // `catch` clause — mirrors `useOrcamentoExport`) so a failed capture never
    // crashes the page.
    return exportEtiquetaGenericaPdf(node)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      })
      .finally(() => setExporting(false));
  }, [model]);

  return { ref, exporting, error, exportPdf };
}
