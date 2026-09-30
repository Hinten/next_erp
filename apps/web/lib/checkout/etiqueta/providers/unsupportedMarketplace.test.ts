import { describe, expect, it, vi } from 'vitest';

import { INTEGRACAO_FRETE } from '@delfrance/schemas';

import { unsupportedMarketplaceProvider } from './unsupportedMarketplace';
import type { EtiquetaProviderInput } from '../types';

function makeInput(notify: EtiquetaProviderInput['ui']['notify']): EtiquetaProviderInput {
  return {
    db: {} as never,
    pedido: {} as never,
    pedidoId: 'p1',
    frete: {} as never,
    intFrete: { fonte: 'doc', id: 'if1', tipo: INTEGRACAO_FRETE.magalu, data: {} as never },
    formato: 'pdf',
    deps: {
      freightClient: null,
      nfeClient: null,
      mercadoLivreClient: null,
      shopeeClient: null,
      printJob: vi.fn(),
    },
    ui: {
      confirmRisk: vi.fn(),
      notify,
      openUrl: vi.fn(),
      comprarEtiqueta: vi.fn(),
      escolherEnvio: vi.fn(),
    },
  };
}

describe('unsupportedMarketplaceProvider', () => {
  it('registers the three not-yet-ported marketplace tipos (mercadoLivre and shopee graduated)', () => {
    // W2: `shopee` here as well as in `providers/shopee.ts` would make the
    // registry throw at load (a tipo claimed twice); gone from both, the Shopee
    // row would fall back to this placeholder — see `registry.test.ts`.
    expect(unsupportedMarketplaceProvider.tipos).toEqual(['lojaIntegrada', 'amz', 'magalu']);
    expect(unsupportedMarketplaceProvider.tipos).not.toContain(INTEGRACAO_FRETE.shopee);
  });

  it('notifies and returns an unsupported outcome carrying the tipo', async () => {
    const notify = vi.fn();
    const out = await unsupportedMarketplaceProvider.emitirOuImprimir(makeInput(notify));
    expect(out).toMatchObject({ status: 'unsupported' });
    if (out.status === 'unsupported') expect(out.reason).toContain('magalu');
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
