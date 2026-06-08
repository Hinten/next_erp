/**
 * DANFE renderers — **server-only** entry, exposed via the
 * `@delfrance/integrations-nfe/danfe` subpath (NOT the package root barrel) so
 * pdfkit/bwip-js never leak into the `apps/web` browser bundle. `apps/web` only
 * ever calls the `GET /api/nfe/danfe` route; `apps/nfe` imports this subpath.
 *
 * A DANFE is rendered from an authorized **procNFe** XML
 * (`pedidos/{id}/nfev4/{nfeId}.xml_nfe_proc`), never re-generated.
 *
 * PR1 ships the **simplificado** PDF + the **ZPL2** label. The A4 retrato /
 * paisagem layouts land in PR2 and the carta-de-correção PDF in PR3 — both
 * extend this same entry.
 */
import { parseProcNFe } from './model';
import { renderRetrato } from './pdf/retrato';
import { renderSimplificado } from './pdf/simplificado';
import { renderSimplificadoZpl, type ZplOptions } from './zpl2';

export { parseProcNFe } from './model';
export type {
  DanfeModel,
  DanfeIde,
  DanfeEmitente,
  DanfeDestinatario,
  DanfeEndereco,
  DanfeProtocolo,
} from './model';
export { renderSimplificado, type RenderSimplificadoOptions } from './pdf/simplificado';
export { renderRetrato, composeInfoComplementares, type RenderA4Options } from './pdf/retrato';
export { renderSimplificadoZpl, type ZplOptions } from './zpl2';
export { code128Png } from './barcode';
export * from './format';

/** PDF output formats. `paisagem` (A4 landscape) is a follow-up. */
export type DanfeFormat = 'simplificado' | 'retrato' | 'paisagem';

export interface RenderDanfeOptions {
  readonly format: DanfeFormat;
  /** Stamp the "CANCELADO" overlay (NF-e estado is cancelada). */
  readonly cancelada?: boolean;
}

/**
 * Render a DANFE PDF from a procNFe XML. PR1 implements `simplificado`; the A4
 * orientations throw until PR2 (the `GET /api/nfe/danfe` route only accepts the
 * implemented formats, so this is a defensive guard).
 */
export function renderDanfe(xml: string, opts: RenderDanfeOptions): Promise<Buffer> {
  const model = parseProcNFe(xml);
  switch (opts.format) {
    case 'simplificado':
      return renderSimplificado(model, { cancelada: opts.cancelada });
    case 'retrato':
      return renderRetrato(model, { cancelada: opts.cancelada });
    case 'paisagem':
      throw new Error(
        `DANFE format '${opts.format}' (A4 landscape) is not implemented yet — it lands in a follow-up.`,
      );
  }
}

/** Render the DANFE Simplificado as a ZPL2 label string (Zebra printers). */
export function renderDanfeZpl(xml: string, opts: ZplOptions = {}): string {
  return renderSimplificadoZpl(parseProcNFe(xml), opts);
}
