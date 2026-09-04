import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO, type IntegracaoTipo } from '@delfrance/schemas';

import type { MotivoNaoSuportado } from '@/lib/marketplace/caps/suporteCanal';
import { PROVIDERS, enviarPrecoParaIntegracao, resolvePricePushProvider } from './registry';
import { mercadoLivrePriceProvider } from './providers/mercadoLivre';
import type { PricePushInput } from './types';

function input(over: Partial<PricePushInput> = {}): PricePushInput {
  return {
    integracao: { id: 'c1', nome: 'Loja', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true },
    produtoIds: ['p1'],
    nomePorProdutoId: new Map([['p1', 'Camiseta']]),
    baixarPreco: false,
    incluirNaoPublicados: true,
    deps: { mercadoLivre: null },
    ...over,
  };
}

/**
 * Every tipo that is NOT Mercado Livre, with the reason the caps table gives.
 *
 * Written out rather than derived: a test that loops the constant it validates
 * passes for any content. The coverage assertion below is what keeps it
 * exhaustive, so a newly added `IntegracaoTipo` still cannot slip past — and
 * THIS is the pair of assertions a second-channel PR edits.
 */
const NAO_SUPORTADOS: ReadonlyArray<readonly [IntegracaoTipo, MotivoNaoSuportado]> = [
  [INTEGRACAO_TIPO.nenhuma, 'nao-marketplace'],
  [INTEGRACAO_TIPO.whatsapp, 'nao-marketplace'],
  [INTEGRACAO_TIPO.balcao, 'nao-marketplace'],
  // ⚠️ `'canal-nao-pesquisado'`, never `'canal-nao-suportado'`: nobody has read
  // these providers' documentation, and a `'nao'` here would be the unverified
  // claim #815 undid.
  [INTEGRACAO_TIPO.facebook, 'canal-nao-pesquisado'],
  [INTEGRACAO_TIPO.lojaIntegrada, 'canal-nao-pesquisado'],
  [INTEGRACAO_TIPO.magalu, 'canal-nao-pesquisado'],
  [INTEGRACAO_TIPO.amazon, 'canal-nao-pesquisado'],
  // ⚠️ Shopee is the near-miss of the line above, and the ONLY tipo on the
  // other side of it: its Phase 0 survey answered this capability `'sim'`, so
  // the honest reason is that WE have not built the channel — not that nobody
  // has looked. It flips to supported when `implementado` does.
  [INTEGRACAO_TIPO.shopee, 'canal-nao-implementado'],
];

describe('resolvePricePushProvider', () => {
  it('routes Mercado Livre to its provider', () => {
    expect(resolvePricePushProvider(INTEGRACAO_TIPO.mercadoLivre)).toBe(mercadoLivrePriceProvider);
  });

  it('the table above covers every tipo that is not Mercado Livre', () => {
    expect(new Set(NAO_SUPORTADOS.map(([tipo]) => tipo))).toEqual(
      new Set(Object.values(INTEGRACAO_TIPO).filter((t) => t !== INTEGRACAO_TIPO.mercadoLivre)),
    );
  });

  it.each(NAO_SUPORTADOS)(
    'tipo %s falls back to the placeholder, saying %s',
    async (tipo, motivo) => {
      const provider = resolvePricePushProvider(tipo);
      expect(provider.tipos).toEqual([]);
      const res = await provider.enviarPreco(
        input({ integracao: { id: 'c9', nome: 'Conta', tipo, ativo: true } }),
      );
      expect(res.rows[0]).toMatchObject({ outcome: 'pulado', motivo });
    },
  );

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

  it('an unsupported channel reports itself, and says WHICH reason applies', async () => {
    const res = await enviarPrecoParaIntegracao(
      input({
        integracao: { id: 'c9', nome: 'Shopee BR', tipo: INTEGRACAO_TIPO.shopee, ativo: true },
      }),
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ outcome: 'pulado', motivo: 'canal-nao-implementado' });
    // It must name the channel — "not supported" alone is not actionable.
    expect(res.rows[0]!.mensagem).toContain('Shopee BR');
    // ⚠️ The near-miss: "we have not built it" must not read as "the provider
    // cannot", and must not read as "nobody checked" either — Shopee's Phase 0
    // survey answered `enviarPreco` `'sim'`.
    expect(res.rows[0]!.mensagem).toContain('ainda não foi implementado');
    expect(res.rows[0]!.mensagem).not.toContain('não oferece');
    expect(res.rows[0]!.mensagem).not.toContain('ainda não foi verificado');
    // And it names the OPERATION, so the stock twin's sentence is distinguishable.
    expect(res.rows[0]!.mensagem).toContain('envio de preços');
  });
});
