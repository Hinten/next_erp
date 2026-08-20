import {
  buildEtiquetaGenericaModel,
  renderEtiquetaGenericaPdf,
  renderEtiquetaGenericaZpl,
} from '@/lib/etiqueta-generica';

import type { CheckoutEtiquetaProvider, EtiquetaOutcome, EtiquetaProviderInput } from '../types';

/**
 * Generic-label provider for the carrier-less freight tipos (retiradaNaLoja /
 * motoboy / fob / outros) — port of the `default:` branch of
 * `emitirOuImprimirFrete.dart`, which rendered `EtiquetaFreteGenericaPDF` and
 * printed it. There is no carrier API, so the app builds the 10×15cm label from
 * the pedido data and sends it to the print agent (which falls back to a
 * browser download when the agent is offline).
 *
 * Both formats are real here. `pdf` draws the label with jsPDF; `zpl2` emits
 * ZPL for a Zebra, which the print agent blasts to the label printer through
 * its RAW spooler channel — the same `text/plain` path the marketplace ZPL
 * already takes (`printJob.dart:_printPlainText`, `pDatatype = 'RAW'`). Legacy
 * only pretended to support ZPL2: it toasted "ainda não implementado" and
 * printed the PDF instead, on the format that was the operator's DEFAULT.
 */

/** The agent routes on contentType; raw ZPL goes down its plain-text channel. */
const ZPL_CONTENT_TYPE = 'text/plain;charset=utf-8';

export const genericLabelProvider: CheckoutEtiquetaProvider = {
  tipos: ['retiradaNaLoja', 'motoboy', 'fob', 'outros'],

  async emitirOuImprimir(input: EtiquetaProviderInput): Promise<EtiquetaOutcome> {
    const { db, pedido, pedidoId, frete, intFrete, formato, deps, ui } = input;

    try {
      const model = await buildEtiquetaGenericaModel(db, pedido, pedidoId, frete, intFrete);
      const base = `etiqueta-${pedido.numero ?? pedidoId}`;
      const artifact =
        formato === 'zpl2'
          ? {
              // A ZPL string, so the bytes are the label — no rasterisation, and
              // the Blob carries UTF-8 so `^CI28` finds the accents it expects.
              blob: new Blob([renderEtiquetaGenericaZpl(model)], { type: ZPL_CONTENT_TYPE }),
              fileName: `${base}.zpl2`,
              contentType: ZPL_CONTENT_TYPE,
            }
          : {
              blob: await renderEtiquetaGenericaPdf(model),
              fileName: `${base}.pdf`,
              contentType: 'application/pdf',
            };

      // A print (agent up) or a download (agent down) both DELIVER the label to
      // the operator, so either way the action succeeded — map both to 'printed'.
      await deps.printJob(artifact.blob, {
        fileName: artifact.fileName,
        contentType: artifact.contentType,
        tamanho: 'etq',
      });
      return { status: 'printed' };
    } catch (err) {
      // The Firestore derefs and the jsPDF render throw plain
      // Errors; keep the post-save contract best-effort — surface a toast and
      // return an `error` outcome instead of rejecting the caller (the checkout
      // is already committed). A genuinely non-Error still propagates.
      if (!(err instanceof Error)) throw err;
      ui.notify({
        title: 'Etiqueta genérica',
        message: `Falha ao gerar a etiqueta: ${err.message}`,
        color: 'red',
      });
      return { status: 'error', message: err.message };
    }
  },
};
