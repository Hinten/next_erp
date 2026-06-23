'use client';

import {
  FreightHttpError,
  FreightLabelTerminalError,
  FreightNetworkError,
  FreightReauthRequiredError,
  FreightValidationError,
} from '@delfrance/integrations-freight-br/http-client';

/**
 * Map a freight client error to a pt-BR message, or `null` when `err` is not a
 * recognized freight error — the caller rethrows so unexpected failures surface.
 * Shared by the Frete-tab etiqueta panel and the pedido-list row action.
 */
export function freightErrorMessage(err: unknown): string | null {
  if (err instanceof FreightReauthRequiredError) {
    return 'Conta Melhor Envio desconectada. Reconecte em Logística › Melhor Envio.';
  }
  if (err instanceof FreightLabelTerminalError) {
    return `Etiqueta em estado terminal${err.reason ? ` (${err.reason})` : ''}. Não é possível continuar a compra.`;
  }
  if (err instanceof FreightValidationError) {
    const msgs = Object.values(err.errors).flat();
    return msgs.length > 0 ? msgs.join('; ') : err.message;
  }
  if (err instanceof FreightHttpError) return err.message;
  if (err instanceof FreightNetworkError) return 'Falha de rede ao falar com o Melhor Envio.';
  return null;
}
