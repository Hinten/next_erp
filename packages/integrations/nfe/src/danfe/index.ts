/**
 * DANFE renderers — **server-only** entry, exposed via the
 * `@delfrance/integrations-nfe/danfe` subpath (NOT the package root barrel) so
 * pdfkit/bwip-js never leak into the `apps/web` browser bundle. `apps/web` only
 * ever calls the `GET /api/nfe/danfe` route; `apps/nfe` imports this subpath.
 *
 * A DANFE is rendered from an authorized **procNFe** XML
 * (`pedidos/{id}/nfev4/{nfeId}.xml_nfe_proc`), never re-generated.
 *
 * The **simplificado** PDF + **ZPL2** label, the A4 **retrato** and **paisagem**
 * layouts all render here; the carta-de-correção PDF extends this same entry.
 */
import { parseProcNFe } from './model';
import { renderPaisagem } from './pdf/paisagem';
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
export { renderPaisagem } from './pdf/paisagem';
export { renderSimplificadoZpl, type ZplOptions } from './zpl2';
export { code128Png } from './barcode';
export * from './format';

/** PDF output formats. */
export type DanfeFormat = 'simplificado' | 'retrato' | 'paisagem';

export interface RenderDanfeOptions {
  readonly format: DanfeFormat;
  /** Stamp the "CANCELADO" overlay (NF-e estado is cancelada). */
  readonly cancelada?: boolean;
}

/** Render a DANFE PDF from a procNFe XML, in the requested layout. */
export function renderDanfe(xml: string, opts: RenderDanfeOptions): Promise<Buffer> {
  const model = parseProcNFe(xml);
  switch (opts.format) {
    case 'simplificado':
      return renderSimplificado(model, { cancelada: opts.cancelada });
    case 'retrato':
      return renderRetrato(model, { cancelada: opts.cancelada });
    case 'paisagem':
      return renderPaisagem(model, { cancelada: opts.cancelada });
  }
}

/** Render the DANFE Simplificado as a ZPL2 label string (Zebra printers). */
export function renderDanfeZpl(xml: string, opts: ZplOptions = {}): string {
  return renderSimplificadoZpl(parseProcNFe(xml), opts);
}
