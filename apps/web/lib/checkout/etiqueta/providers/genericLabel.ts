import { buildEtiquetaGenericaModel, renderEtiquetaGenericaPdf } from '@/lib/etiqueta-generica';

import type { CheckoutEtiquetaProvider, EtiquetaOutcome, EtiquetaProviderInput } from '../types';

/**
 * Generic-label provider for the carrier-less freight tipos (retiradaNaLoja /
 * motoboy / fob / outros) — port of the `default:` branch of
 * `emitirOuImprimirFrete.dart`, which rendered `EtiquetaFreteGenericaPDF` and
 * printed it. There is no carrier API, so the app builds a 10×15cm PDF from
 * the pedido data and sends it to the print agent (which falls back to a
 * browser download when the agent is offline).
 *
 * ZPL2 is not implemented for the generic label (legacy `//todo`); a ZPL2
 * request toasts and builds the PDF anyway (legacy parity — it did the same).
 */
export const genericLabelProvider: CheckoutEtiquetaProvider = {
  tipos: ['retiradaNaLoja', 'motoboy', 'fob', 'outros'],

  async emitirOuImprimir(input: EtiquetaProviderInput): Promise<EtiquetaOutcome> {
    const { db, pedido, pedidoId, frete, intFrete, formato, deps, ui } = input;

    if (formato === 'zpl2') {
      ui.notify({
        title: 'Etiqueta genérica',
        message: 'Impressão de etiqueta genérica ZPL2 ainda não implementada. Gerando PDF.',
        color: 'yellow',
      });
    }

    try {
      const model = await buildEtiquetaGenericaModel(db, pedido, pedidoId, frete, intFrete);
      const blob = await renderEtiquetaGenericaPdf(model);
      const fileName = `etiqueta-${pedido.numero ?? pedidoId}.pdf`;

      // A print (agent up) or a download (agent down) both DELIVER the label, so
      // either way the action succeeded — both map to 'printed'.
      const delivery = await deps.printJob(blob, {
        fileName,
        contentType: 'application/pdf',
        tamanho: 'etq',
      });
      // …but they are not the same thing to the operator, and the row action is
      // deliberately silent on a successful print. Without this, an agent that
      // is down looks EXACTLY like a successful print: the click appears to do
      // nothing and the label is sitting in Downloads.
      if (delivery === 'downloaded') {
        ui.notify({
          title: 'Etiqueta genérica',
          message: `Agente de impressão indisponível. A etiqueta foi baixada como "${fileName}" e precisa ser impressa manualmente.`,
          color: 'yellow',
        });
      }
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
