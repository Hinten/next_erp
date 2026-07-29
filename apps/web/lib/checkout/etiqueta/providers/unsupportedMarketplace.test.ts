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
    intFrete: { id: 'if1', tipo: INTEGRACAO_FRETE.mercadoLivre, data: {} as never },
    formato: 'pdf',
    deps: { freightClient: null, nfeClient: null, printJob: vi.fn() },
    ui: { confirmRisk: vi.fn(), notify, openUrl: vi.fn(), comprarEtiqueta: vi.fn() },
  };
}

describe('unsupportedMarketplaceProvider', () => {
  it('registers the five marketplace tipos', () => {
    expect(unsupportedMarketplaceProvider.tipos).toEqual([
      'mercadoLivre',
      'lojaIntegrada',
      'amz',
      'magalu',
      'shopee',
    ]);
  });

  it('notifies and returns an unsupported outcome carrying the tipo', async () => {
    const notify = vi.fn();
    const out = await unsupportedMarketplaceProvider.emitirOuImprimir(makeInput(notify));
    expect(out).toMatchObject({ status: 'unsupported' });
    if (out.status === 'unsupported') expect(out.reason).toContain('mercadoLivre');
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
