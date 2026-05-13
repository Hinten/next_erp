'use client';

import {
  PluginNotRegisteredError,
  PluginRegistry,
  type PaymentGateway,
} from '@delfrance/core/plugins';

/**
 * Singleton plugin registry for the web app. Phase 5 wires concrete
 * gateways (Mercado Pago, etc.) by importing from
 * `@delfrance/integrations/<channel>` and calling
 * `registry.registerPayment(impl)` at app boot.
 *
 * For now the registry is intentionally empty — this module exists so
 * that the UI can call `getGateway(id)` consistently and degrade
 * gracefully (returns `null`) until Phase 5 lands the implementations.
 */
const registry = new PluginRegistry();

export function getGateway(id: string): PaymentGateway | null {
  try {
    return registry.payment(id);
  } catch (err) {
    if (err instanceof PluginNotRegisteredError) {
      return null;
    }
    throw err;
  }
}

export { registry };

/**
 * Map a Flutter `TIPO_INTEGRACAO_PGTO` integer to the plugin id we use
 * to look the gateway up. New gateways register their plugin under the
 * name returned here.
 */
export function gatewayIdFromTipo(tipo: number): string | null {
  switch (tipo) {
    case 1:
      return 'mercado-pago';
    default:
      return null;
  }
}
