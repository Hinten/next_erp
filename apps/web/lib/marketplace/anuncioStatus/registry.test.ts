import { describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO, type IntegracaoTipo } from '@delfrance/schemas';

import type { MotivoNaoSuportado } from '@/lib/marketplace/caps/suporteCanal';
import { definirStatusParaIntegracao, resolveAnuncioStatusProvider } from './registry';
import type { AnuncioStatusInput } from './types';

const input = (over: Partial<AnuncioStatusInput> = {}): AnuncioStatusInput => ({
  integracao: { id: 'c1', nome: 'Loja', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true },
  produtoIds: ['p1', 'p2'],
  nomePorProdutoId: new Map([['p1', 'Camiseta']]),
  acao: 'pausar',
  deps: { mercadoLivre: null },
  ...over,
});

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

describe('resolveAnuncioStatusProvider', () => {
  it('claims Mercado Livre', () => {
    expect(resolveAnuncioStatusProvider(INTEGRACAO_TIPO.mercadoLivre).tipos).toContain(
      INTEGRACAO_TIPO.mercadoLivre,
    );
  });

  it('the table above covers every tipo that is not Mercado Livre', () => {
    expect(new Set(NAO_SUPORTADOS.map(([tipo]) => tipo))).toEqual(
      new Set(Object.values(INTEGRACAO_TIPO).filter((t) => t !== INTEGRACAO_TIPO.mercadoLivre)),
    );
  });

  it.each(NAO_SUPORTADOS)(
    'tipo %s falls back to the placeholder, saying %s',
    async (tipo, motivo) => {
      const provider = resolveAnuncioStatusProvider(tipo);
      // Claiming no tipos is what makes registering a real channel a one-line
      // change instead of also remembering to edit the placeholder.
      expect(provider.tipos).toEqual([]);
      const res = await provider.definirStatus(
        input({ integracao: { id: 'c2', nome: 'Conta', tipo, ativo: true } }),
      );
      expect(res.rows).toHaveLength(2);
      expect(res.rows[0]).toMatchObject({ outcome: 'pulado', motivo });
    },
  );

  it('explains itself per produto, naming the conta and the reason', async () => {
    const res = await resolveAnuncioStatusProvider(INTEGRACAO_TIPO.shopee).definirStatus(
      input({
        integracao: { id: 'c2', nome: 'Shopee', tipo: INTEGRACAO_TIPO.shopee, ativo: true },
      }),
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]!.mensagem).toContain('Shopee');
    expect(res.rows[0]!.mensagem).toContain('pausa de anúncios');
    // ⚠️ Unbuilt, NOT "the provider cannot" — Shopee's survey answered
    // `pausarAnuncio` `'sim'` (unlist_item), and reading an unbuilt channel as a
    // refusal is the claim the tri-state exists to prevent.
    expect(res.rows[0]!.motivo).toBe('canal-nao-implementado');
  });

  it('an UNSURVEYED channel still says "nobody checked", not "we have not built it"', async () => {
    const res = await resolveAnuncioStatusProvider(INTEGRACAO_TIPO.magalu).definirStatus(
      input({
        integracao: { id: 'c3', nome: 'Magalu', tipo: INTEGRACAO_TIPO.magalu, ativo: true },
      }),
    );
    expect(res.rows[0]!.motivo).toBe('canal-nao-pesquisado');
    expect(res.rows[0]!.mensagem).toContain('Magalu');
  });
});

describe('definirStatusParaIntegracao', () => {
  it('refuses a DEACTIVATED conta before reaching any provider', async () => {
    const res = await definirStatusParaIntegracao(
      input({
        integracao: { id: 'c1', nome: 'Loja', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: false },
      }),
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows.every((r) => r.motivo === 'integracao-desativada')).toBe(true);
    // A row per produto, so nothing in the selection goes unaccounted for.
    expect(res.rows.map((r) => r.produtoId)).toEqual(['p1', 'p2']);
  });

  it('dispatches an ACTIVE ML conta to the real provider', async () => {
    // No client, so the provider answers `sem-cliente` — which is exactly the
    // evidence that dispatch happened rather than the ativo gate firing.
    const res = await definirStatusParaIntegracao(input());
    expect(res.rows[0]).toMatchObject({ motivo: 'sem-cliente' });
  });
});
