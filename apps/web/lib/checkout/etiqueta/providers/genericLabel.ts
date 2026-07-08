import {
  buildEtiquetaGenericaModel,
  renderAndExportEtiquetaGenericaPdf,
} from '@/lib/etiqueta-generica';

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

    const model = await buildEtiquetaGenericaModel(db, pedido, pedidoId, frete, intFrete);
    const blob = await renderAndExportEtiquetaGenericaPdf(model);
    const fileName = `etiqueta-${pedido.numero ?? pedidoId}.pdf`;

    // A print (agent up) or a download (agent down) both DELIVER the label to
    // the operator, so either way the action succeeded — map both to 'printed'.
    await deps.printJob(blob, { fileName, contentType: 'application/pdf', tamanho: 'etq' });
    return { status: 'printed' };
  },
};
