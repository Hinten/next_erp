import type { PaymentGateway } from '@delfrance/core/plugins';

/**
 * Mercado Pago plugin scaffold (PaymentGateway).
 *
 * Concrete implementation will wrap the official `mercadopago` SDK
 * once Phase 5 lands. Until then, every method throws — apps register
 * the stub knowing the gateway is "configured but not implemented",
 * and the UI surfaces this via the empty PluginRegistry lookup
 * (Estornar button stays disabled, etc.).
 */
export interface MercadoPagoConfig {
  /** Long-lived access token (kept in Cloud Secret Manager). */
  accessTokenEnvVar: string;
  /** Notification webhook URL registered with MP. */
  webhookUrl: string;
  /** Webhook secret used to verify x-signature header. */
  webhookSecretEnvVar?: string;
}

export class MercadoPagoNotConfiguredError extends Error {
  constructor() {
    super(
      'Mercado Pago plugin not yet implemented. Wires up in Phase 5 atop the `mercadopago` npm SDK.',
    );
    this.name = 'MercadoPagoNotConfiguredError';
  }
}

export function createMercadoPagoGateway(
  _config: MercadoPagoConfig,
): PaymentGateway {
  return {
    id: 'mercado-pago',
    createCharge: async () => {
      throw new MercadoPagoNotConfiguredError();
    },
    refund: async () => {
      throw new MercadoPagoNotConfiguredError();
    },
    webhook: async () => {
      throw new MercadoPagoNotConfiguredError();
    },
  };
}
