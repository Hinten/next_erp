import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO, type IntegracaoTipo } from '@delfrance/schemas';

import type { MotivoNaoSuportado } from '@/lib/marketplace/caps/suporteCanal';
import { PROVIDERS, enviarEstoqueParaIntegracao, resolveStockPushProvider } from './registry';
import { mercadoLivreStockProvider } from './providers/mercadoLivre';
import { shopeeStockProvider } from './providers/shopee';
import type { StockPushInput } from './types';

function input(over: Partial<StockPushInput> = {}): StockPushInput {
  return {
    integracao: { id: 'c1', nome: 'Loja', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true },
    produtoIds: ['p1'],
    nomePorProdutoId: new Map([['p1', 'Camiseta']]),
    reenviarComErro: false,
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
  // (#1529) and flipped at step 22 (#1530): it has a provider row, pinned below.
  // Each flips `implementado` at its own step 22
  // (`.master_plans/loja-integrada/loja-integrada-marketplace-integration.md:68`,
  // `.master_plans/amazon/amazon-marketplace-integration.md` step 22); whichever
  // channel flips LAST re-points this example. The arm itself is pinned
  // table-free in `suporteCanal.test.ts:16-25`.
  [INTEGRACAO_TIPO.lojaIntegrada, 'canal-nao-implementado'],
  [INTEGRACAO_TIPO.amazon, 'canal-nao-implementado'],
];

describe('resolveStockPushProvider', () => {
  it('routes Mercado Livre to its provider', () => {
    expect(resolveStockPushProvider(INTEGRACAO_TIPO.mercadoLivre)).toBe(mercadoLivreStockProvider);
  });

  it('routes Shopee to its provider', () => {
    expect(resolveStockPushProvider(INTEGRACAO_TIPO.shopee)).toBe(shopeeStockProvider);
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
      const provider = resolveStockPushProvider(tipo);
      // Claiming no tipos is what makes registering a real channel a one-line
      // change instead of also remembering to edit the placeholder.
      expect(provider.tipos).toEqual([]);
      const res = await provider.enviarEstoque(
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

describe('enviarEstoqueParaIntegracao — the shared gates', () => {
  it('short-circuits a deactivated integração WITHOUT calling the provider', async () => {
    // Legacy parity (enviarEstoqueDialog.dart:249-259, "Integração desativada").
    const spy = vi.spyOn(mercadoLivreStockProvider, 'enviarEstoque');
    const res = await enviarEstoqueParaIntegracao(
      input({
        integracao: { id: 'c1', nome: 'Loja', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: false },
      }),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(res.rows[0]).toMatchObject({ outcome: 'pulado', motivo: 'integracao-desativada' });
    spy.mockRestore();
  });

  it('an unsupported channel reports itself, and says WHICH reason applies', async () => {
    const res = await enviarEstoqueParaIntegracao(
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
    // ⚠️ The near-miss: Loja Integrada's survey says it CAN, so the sentence must
    // not claim it cannot — nor that nobody looked. Those were one sentence
    // before #1430. Loja Integrada flips `implementado` at ITS step 22
    // (`.master_plans/loja-integrada/loja-integrada-marketplace-integration.md:68`);
    // whichever channel flips second re-points this example. The arm itself is
    // pinned table-free in `suporteCanal.test.ts:16-25`.
    expect(res.rows[0]!.mensagem).toContain('ainda não foi implementado');
    expect(res.rows[0]!.mensagem).not.toContain('não oferece');
    expect(res.rows[0]!.mensagem).not.toContain('ainda não foi verificado');
  });

  it('an UNSURVEYED channel gets the other reason, not this one', async () => {
    const res = await enviarEstoqueParaIntegracao(
      input({
        integracao: { id: 'c8', nome: 'Magalu BR', tipo: INTEGRACAO_TIPO.magalu, ativo: true },
      }),
    );
    expect(res.rows[0]).toMatchObject({ outcome: 'pulado', motivo: 'canal-nao-pesquisado' });
    expect(res.rows[0]!.mensagem).toContain('ainda não foi verificado');
    expect(res.rows[0]!.mensagem).not.toContain('não oferece');
  });
});
