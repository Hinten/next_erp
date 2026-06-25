import { describe, expect, it } from 'vitest';
import type { GrupoDeVariacoes, ItemDoPedido, Produto } from '@delfrance/schemas';

import {
  arquivoIdFromRef,
  countTotalItens,
  isDispatchOverdue,
  itemsSubtotal,
  kitComponentQuantidade,
  pickCoverFotoRef,
  resolveVariacoesText,
  stockText,
} from './model';

function item(partial: Partial<ItemDoPedido>): ItemDoPedido {
  return {
    produtoUid: null,
    ordem: 1,
    ensureUniqueId: null,
    mktplaceId: null,
    sku: null,
    gtin: null,
    nomeDeVenda: null,
    precoDeVenda: 1,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: null,
    imposto: null,
    ...partial,
  } as ItemDoPedido;
}

function grupo(
  id: string,
  nome: string,
  ordem: number,
  variacoes: { id: string; nome: string }[],
): GrupoDeVariacoes {
  return {
    nome,
    ordem,
    permiteFotos: false,
    variacoesIds: variacoes.map((v) => v.id),
    variacoes: variacoes.map((v) => ({ id: v.id, nome: v.nome })),
  } as GrupoDeVariacoes;
}

/** Build a canonical variante fake path the same way the schema does. */
function fp(grupoId: string, varianteId: string): string {
  return `documents/grupoDeVariacoes/${grupoId}/variacoes/${varianteId}`;
}

describe('stockText', () => {
  it('shows "-" for a kit parent regardless of stock', () => {
    expect(stockText(50, true)).toBe('-');
  });
  it('shows "-" when there is no stock data', () => {
    expect(stockText(null, false)).toBe('-');
  });
  it('clamps negative stock to "0"', () => {
    expect(stockText(-5, false)).toBe('0');
  });
  it('caps stock over 99 to "99+"', () => {
    expect(stockText(150, false)).toBe('99+');
  });
  it('shows the decimal quantity in range', () => {
    expect(stockText(0, false)).toBe('0');
    expect(stockText(7, false)).toBe('7');
  });
});

describe('arquivoIdFromRef', () => {
  it('strips the arquivos/ prefix', () => {
    expect(arquivoIdFromRef('arquivos/abc123')).toBe('abc123');
  });
  it('takes the last segment of a documents/ path', () => {
    expect(arquivoIdFromRef('documents/arquivos/abc123')).toBe('abc123');
  });
  it('returns null for empty/absent', () => {
    expect(arquivoIdFromRef(null)).toBeNull();
    expect(arquivoIdFromRef('')).toBeNull();
  });
});

describe('pickCoverFotoRef', () => {
  it('prefers the 200px derivative', () => {
    const produto = {
      fotos: [
        {
          arquivoOuterRef: 'arquivos/orig',
          arquivo200pxOuterRef: 'arquivos/p200',
          arquivo400pxOuterRef: 'arquivos/p400',
        },
      ],
    } as unknown as Produto;
    expect(pickCoverFotoRef(produto)).toBe('arquivos/p200');
  });
  it('falls back to 400px then the original', () => {
    const only400 = {
      fotos: [{ arquivoOuterRef: 'arquivos/orig', arquivo400pxOuterRef: 'arquivos/p400' }],
    } as unknown as Produto;
    expect(pickCoverFotoRef(only400)).toBe('arquivos/p400');

    const onlyOrig = {
      fotos: [{ arquivoOuterRef: 'arquivos/orig' }],
    } as unknown as Produto;
    expect(pickCoverFotoRef(onlyOrig)).toBe('arquivos/orig');
  });
  it('returns null when there is no photo', () => {
    expect(pickCoverFotoRef({ fotos: null })).toBeNull();
    expect(pickCoverFotoRef(null)).toBeNull();
  });
});

describe('resolveVariacoesText', () => {
  const gruposById = new Map<string, GrupoDeVariacoes>([
    ['gT', grupo('gT', 'Tamanho', 1, [{ id: 'M', nome: 'M' }])],
    ['gC', grupo('gC', 'Cor', 2, [{ id: 'AZ', nome: 'Azul' }])],
  ]);

  it('builds Grupo:Valor joined and sorted by ordem', () => {
    // Pass cor before tamanho; output must reorder to Tamanho (ordem 1) first.
    expect(resolveVariacoesText([fp('gC', 'AZ'), fp('gT', 'M')], gruposById)).toBe(
      'Tamanho:M/Cor:Azul',
    );
  });
  it('degrades unknown group to ???:??? and unknown variant to Grupo:???', () => {
    expect(resolveVariacoesText([fp('gX', 'Z')], gruposById)).toBe('???:???');
    expect(resolveVariacoesText([fp('gT', 'Z')], gruposById)).toBe('Tamanho:???');
  });
  it('returns null when empty', () => {
    expect(resolveVariacoesText(null, gruposById)).toBeNull();
    expect(resolveVariacoesText([], gruposById)).toBeNull();
  });
});

describe('kitComponentQuantidade', () => {
  it('multiplies item qty by component qty', () => {
    expect(kitComponentQuantidade(3, 10)).toBe(30);
  });
});

describe('countTotalItens', () => {
  it('counts a regular line by its own quantity', () => {
    const items = [item({ produtoUid: 'p1', quantidade: 4 })];
    const produtos = new Map<string, Pick<Produto, 'ehKit' | 'componentesKit'>>([
      ['p1', { ehKit: false, componentesKit: null }],
    ]);
    expect(countTotalItens(items, produtos)).toBe(4);
  });
  it('counts a kit line by Σ(component qty × line qty)', () => {
    const items = [item({ produtoUid: 'kit', quantidade: 2 })];
    const produtos = new Map<string, Pick<Produto, 'ehKit' | 'componentesKit'>>([
      [
        'kit',
        {
          ehKit: true,
          componentesKit: {
            cA: { quantidade: 3, limitarEstoque: true, timestamp: null },
            cB: { quantidade: 1, limitarEstoque: true, timestamp: null },
          },
        },
      ],
    ]);
    // (3 + 1) components × 2 lines = 8
    expect(countTotalItens(items, produtos)).toBe(8);
  });
});

describe('itemsSubtotal', () => {
  it('sums (preco - desconto) * qty across items', () => {
    const items = [
      item({ precoDeVenda: 10, descontoUnitario: 1, quantidade: 2 }), // 18
      item({ precoDeVenda: 5, descontoUnitario: 0, quantidade: 3 }), // 15
    ];
    expect(itemsSubtotal(items)).toBe(33);
  });
});

describe('isDispatchOverdue', () => {
  const now = new Date(2026, 5, 25, 10, 0); // 2026-06-25 10:00 local
  it('is true when the deadline day is before today', () => {
    expect(isDispatchOverdue(Date.UTC(2026, 5, 24) * 1000, now)).toBe(true);
  });
  it('is false on the deadline day itself', () => {
    expect(isDispatchOverdue(new Date(2026, 5, 25, 23, 0).getTime() * 1000, now)).toBe(false);
  });
  it('is false for a future deadline', () => {
    expect(isDispatchOverdue(Date.UTC(2026, 5, 28) * 1000, now)).toBe(false);
  });
  it('is false when there is no deadline', () => {
    expect(isDispatchOverdue(null, now)).toBe(false);
  });
});
