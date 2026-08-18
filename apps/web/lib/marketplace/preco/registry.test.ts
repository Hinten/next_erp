import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO, type IntegracaoTipo } from '@delfrance/schemas';

import { PROVIDERS, enviarPrecoParaIntegracao, resolvePricePushProvider } from './registry';
import { mercadoLivrePriceProvider } from './providers/mercadoLivre';
import { unsupportedChannelPriceProvider } from './providers/unsupportedChannel';
import type { PricePushInput } from './types';

function input(over: Partial<PricePushInput> = {}): PricePushInput {
  return {
    integracao: { id: 'c1', nome: 'Loja', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true },
    produtoIds: ['p1'],
    nomePorProdutoId: new Map([['p1', 'Camiseta']]),
    baixarPreco: false,
    deps: { mercadoLivre: null },
    ...over,
  };
}

describe('resolvePricePushProvider', () => {
  it('routes Mercado Livre to its provider', () => {
    expect(resolvePricePushProvider(INTEGRACAO_TIPO.mercadoLivre)).toBe(mercadoLivrePriceProvider);
  });

  /**
   * Exhaustive on purpose: a newly added `IntegracaoTipo` cannot silently miss
   * the table, and THIS is the assertion a second-channel PR edits.
   */
  it.each(
    Object.values(INTEGRACAO_TIPO).filter(
      (t) => t !== INTEGRACAO_TIPO.mercadoLivre,
    ) as IntegracaoTipo[],
  )('falls back to the unsupported-channel placeholder for tipo %s', (tipo) => {
    expect(resolvePricePushProvider(tipo)).toBe(unsupportedChannelPriceProvider);
  });

  it('registers exactly the tipos its providers claim', () => {
    expect(Object.keys(PROVIDERS)).toEqual([String(INTEGRACAO_TIPO.mercadoLivre)]);
  });
});

describe('enviarPrecoParaIntegracao — the shared gates', () => {
  it('short-circuits a deactivated integração WITHOUT calling the provider', async () => {
    const spy = vi.spyOn(mercadoLivrePriceProvider, 'enviarPreco');
    const res = await enviarPrecoParaIntegracao(
      input({
        integracao: { id: 'c1', nome: 'Loja', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: false },
      }),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(res.rows[0]).toMatchObject({ outcome: 'pulado', motivo: 'integracao-desativada' });
    spy.mockRestore();
  });

  it('an unsupported channel reports itself instead of failing silently', async () => {
    const res = await enviarPrecoParaIntegracao(
      input({
        integracao: { id: 'c9', nome: 'Shopee BR', tipo: INTEGRACAO_TIPO.shopee, ativo: true },
      }),
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ outcome: 'pulado', motivo: 'canal-nao-suportado' });
    // It must name the channel — "not supported" alone is not actionable while
    // the legacy app is still the sender for it.
    expect(res.rows[0]!.mensagem).toContain('Shopee BR');
  });
});
