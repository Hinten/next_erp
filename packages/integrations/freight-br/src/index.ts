import type { FreightProvider } from '@delfrance/core/plugins';

/**
 * Brazilian freight providers (Melhor Envio + Correios + others) plugin
 * scaffold. Phase 5 wraps the `melhor-envio` npm package (or HTTP
 * directly if the wrapper isn't maintained) and provides a unified
 * FreightProvider implementation.
 */
export interface FreightBrConfig {
  /** Which provider to instantiate. */
  provider: 'melhor-envio' | 'correios' | 'motoboy' | 'retirar-loja';
  apiKeyEnvVar?: string;
  /** Sandbox / production. */
  ambiente?: 'sandbox' | 'producao';
}

export class FreightBrNotConfiguredError extends Error {
  constructor() {
    super('freight-br plugin not yet implemented (Phase 5).');
    this.name = 'FreightBrNotConfiguredError';
  }
}

export function createFreightBrProvider(
  config: FreightBrConfig,
): FreightProvider {
  return {
    id: `freight-br-${config.provider}`,
    quote: async () => { throw new FreightBrNotConfiguredError(); },
    purchase: async () => { throw new FreightBrNotConfiguredError(); },
    track: async () => { throw new FreightBrNotConfiguredError(); },
  };
}
