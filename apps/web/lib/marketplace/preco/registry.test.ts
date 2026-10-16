import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO, type IntegracaoTipo } from '@delfrance/schemas';

import { type MotivoNaoSuportado, capsPermitem } from '@/lib/marketplace/caps/suporteCanal';
import { PROVIDERS, enviarPrecoParaIntegracao, resolvePricePushProvider } from './registry';
import { mercadoLivrePriceProvider } from './providers/mercadoLivre';
import { shopeePriceProvider } from './providers/shopee';
import type { PricePushInput } from './types';

function input(over: Partial<PricePushInput> = {}): PricePushInput {
  return {
    integracao: { id: 'c1', nome: 'Loja', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true },
    produtoIds: ['p1'],
    nomePorProdutoId: new Map([['p1', 'Camiseta']]),
    baixarPreco: false,
    incluirNaoPublicados: true,
    deps: { mercadoLivre: null, shopee: null },
    ...over,
  };
}

/**
 * Every tipo with NO provider row, with the reason the caps table gives.
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
  [INTEGRACAO_TIPO.magalu, 'canal-nao-pesquisado'],
  // ⚠️ Loja Integrada and Amazon are the near-miss of the lines above, and the
  // only tipos on the other side of them: their Phase 0 surveys answered this
  // capability `'sim'`, so the honest reason is that WE have not built the
  // channel — not that nobody has looked. Shopee left this table in step 21
  // (#1529): it has a provider row, pinned below against the caps. Each flips
  // `implementado` at its own step 22
  // (`.master_plans/loja-integrada/loja-integrada-marketplace-integration.md:68`,
  // `.master_plans/amazon/amazon-marketplace-integration.md` step 22); whichever
  // channel flips LAST re-points this example. The arm itself is pinned
  // table-free in `suporteCanal.test.ts:16-25`.
  [INTEGRACAO_TIPO.lojaIntegrada, 'canal-nao-implementado'],
  [INTEGRACAO_TIPO.amazon, 'canal-nao-implementado'],
];

describe('resolvePricePushProvider', () => {
  it('routes Mercado Livre to its provider', () => {
    expect(resolvePricePushProvider(INTEGRACAO_TIPO.mercadoLivre)).toBe(mercadoLivrePriceProvider);
  });

  it('routes Shopee to its provider exactly when the caps clear it (#1529 → #1530)', () => {
    // True on BOTH sides of the step-22 flip: today the caps say "not built" and
    // the placeholder answers; after it, the real provider does. Red only if
    // `resolve` ever bypasses the caps.
    expect(resolvePricePushProvider(INTEGRACAO_TIPO.shopee) === shopeePriceProvider).toBe(
      capsPermitem('preco', INTEGRACAO_TIPO.shopee),
    );
  });

  it('the table above covers every tipo with no provider row', () => {
    expect(new Set(NAO_SUPORTADOS.map(([tipo]) => tipo))).toEqual(
      new Set(
        Object.values(INTEGRACAO_TIPO).filter(
          (t) => t !== INTEGRACAO_TIPO.mercadoLivre && t !== INTEGRACAO_TIPO.shopee,
        ),
      ),
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
    expect(Object.keys(PROVIDERS).sort()).toEqual(
      [String(INTEGRACAO_TIPO.mercadoLivre), String(INTEGRACAO_TIPO.shopee)].sort(),
    );
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
        integracao: {
          id: 'c9',
          nome: 'Loja Integrada BR',
          tipo: INTEGRACAO_TIPO.lojaIntegrada,
          ativo: true,
        },
      }),
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ outcome: 'pulado', motivo: 'canal-nao-implementado' });
    // It must name the channel — "not supported" alone is not actionable.
    expect(res.rows[0]!.mensagem).toContain('Loja Integrada BR');
    // ⚠️ The near-miss: "we have not built it" must not read as "the provider
    // cannot", and must not read as "nobody checked" either — Loja Integrada's
    // Phase 0 survey answered `enviarPreco` `'sim'`. Loja Integrada flips `implementado` at ITS step 22
    // (`.master_plans/loja-integrada/loja-integrada-marketplace-integration.md:68`);
    // whichever channel flips second re-points this example. The arm itself is
    // pinned table-free in `suporteCanal.test.ts:16-25`.
    expect(res.rows[0]!.mensagem).toContain('ainda não foi implementado');
    expect(res.rows[0]!.mensagem).not.toContain('não oferece');
    expect(res.rows[0]!.mensagem).not.toContain('ainda não foi verificado');
    // And it names the OPERATION, so the stock twin's sentence is distinguishable.
    expect(res.rows[0]!.mensagem).toContain('envio de preços');
  });
});
