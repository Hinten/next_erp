import { freightErrorMessage } from '@/lib/freight/errorMessage';

import type { CheckoutEtiquetaProvider, EtiquetaOutcome, EtiquetaProviderInput } from '../types';

/**
 * Melhor Envio etiqueta provider — the only live carrier (port of the
 * `INTEGRACOES_FRETE.melhorEnvios` branch of `emitirOuImprimirFrete.dart`).
 *
 * Three states, in order of "cheapest to satisfy":
 *   - a label already bought (`printLabelId`) → fetch its print URL + open it;
 *   - a service selected but no label yet (`externalOptionId`) → drive the ME
 *     buy modal (the SERVER persists `printLabelId` + estado on success — the
 *     client writes nothing);
 *   - neither → send the operator to the editor to quote/select a service.
 *
 * ME can't produce ZPL2, so a ZPL2 request toasts and falls back to PDF —
 * exactly what the label URL already is (legacy showed the same snackbar).
 */
export const melhorEnviosProvider: CheckoutEtiquetaProvider = {
  tipos: ['melhorEnvios'],

  async emitirOuImprimir(input: EtiquetaProviderInput): Promise<EtiquetaOutcome> {
    const { pedidoId, frete, intFrete, formato, deps, ui } = input;

    // ME prints PDF only — warn and continue (the URL below is a PDF anyway).
    if (formato === 'zpl2') {
      ui.notify({
        title: 'Melhor Envios',
        message: 'Melhor Envios não suporta impressão de etiquetas ZPL2. Gerando PDF.',
        color: 'yellow',
      });
    }

    if (deps.freightClient === null) {
      return {
        status: 'error',
        message: 'Cliente de frete indisponível. Faça login novamente e tente de novo.',
      };
    }
    const freightClient = deps.freightClient;

    // 1. Label already bought → just fetch its URL and open it.
    if (frete.printLabelId != null) {
      try {
        const result = await freightClient.imprimir(intFrete.id, frete.printLabelId);
        ui.openUrl(result.url);
        return { status: 'opened' };
      } catch (err) {
        const msg = freightErrorMessage(err);
        if (msg === null) throw err;
        return { status: 'error', message: msg };
      }
    }

    // 2. A service was selected but no label yet → drive the buy modal.
    if (frete.externalOptionId != null) {
      const outcome = await ui.comprarEtiqueta({
        intFreteId: intFrete.id,
        pedidoId,
        frete,
        // The gates already risk-confirmed a posted reprint; the modal shows its
        // own ack only when it independently detects a posted frete.
        needsPostedConfirm: false,
      });
      if (outcome.status === 'bought' && outcome.printUrl != null) {
        ui.openUrl(outcome.printUrl);
        return { status: 'opened' };
      }
      // Cancelled, or bought without a print URL (server persisted it; the
      // operator reprints from the row later) → nothing more to do here.
      return { status: 'skipped' };
    }

    // 3. Nothing to print yet → the operator must quote/select a service first.
    return { status: 'needs-quote', editorHref: `/pedidos/${pedidoId}/editar` };
  },
};
