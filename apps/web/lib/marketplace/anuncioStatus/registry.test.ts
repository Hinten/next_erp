import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

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

describe('resolveAnuncioStatusProvider', () => {
  it('claims Mercado Livre', () => {
    expect(resolveAnuncioStatusProvider(INTEGRACAO_TIPO.mercadoLivre).tipos).toContain(
      INTEGRACAO_TIPO.mercadoLivre,
    );
  });

  it('falls back for every other tipo, and the fallback claims NOTHING', () => {
    const shopee = resolveAnuncioStatusProvider(INTEGRACAO_TIPO.shopee);
    // Claiming no tipos is what makes registering a real channel a one-line
    // change instead of also remembering to edit the placeholder.
    expect(shopee.tipos).toEqual([]);
  });

  it('explains itself per produto rather than failing silently', async () => {
    const res = await resolveAnuncioStatusProvider(INTEGRACAO_TIPO.shopee).definirStatus(
      input({
        integracao: { id: 'c2', nome: 'Shopee', tipo: INTEGRACAO_TIPO.shopee, ativo: true },
      }),
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ outcome: 'pulado', motivo: 'canal-nao-suportado' });
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
