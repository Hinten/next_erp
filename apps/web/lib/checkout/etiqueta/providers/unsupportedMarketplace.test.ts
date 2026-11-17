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
      lojaIntegradaClient: null,
      amazonClient: null,
      printJob: vi.fn(),
    },
    ui: {
      confirmRisk: vi.fn(),
      notify,
      openUrl: vi.fn(),
      comprarEtiqueta: vi.fn(),
      escolherEnvio: vi.fn(),
      confirmarCiente: vi.fn(),
    },
  };
}

describe('unsupportedMarketplaceProvider', () => {
  it('registers only the one not-yet-ported marketplace tipo, magalu (mercadoLivre, shopee and amz graduated, lojaIntegrada is routed)', () => {
    // W2: `shopee` or `amz` here as well as in its own provider would make the
    // registry throw at load (a tipo claimed twice); gone from both, the row
    // would fall back to this placeholder — see `registry.test.ts`. The same
    // holds for `lojaIntegrada` and the router provider.
    expect(unsupportedMarketplaceProvider.tipos).toEqual([INTEGRACAO_FRETE.magalu]);
    expect(unsupportedMarketplaceProvider.tipos).not.toContain(INTEGRACAO_FRETE.amazon);
    expect(unsupportedMarketplaceProvider.tipos).not.toContain(INTEGRACAO_FRETE.shopee);
    expect(unsupportedMarketplaceProvider.tipos).not.toContain(INTEGRACAO_FRETE.lojaIntegrada);
  });

  it('notifies and returns an unsupported outcome carrying the tipo', async () => {
    const notify = vi.fn();
    const out = await unsupportedMarketplaceProvider.emitirOuImprimir(makeInput(notify));
    expect(out).toMatchObject({ status: 'unsupported' });
    if (out.status === 'unsupported') expect(out.reason).toContain('magalu');
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
