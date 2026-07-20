import { describe, expect, it } from 'vitest';
import type { MappedMlItem } from '@delfrance/integrations-mercado-livre';

import {
  DEFAULT_IMPORT_OPTIONS,
  type ImportAssembleArgs,
  MercadoLivreImportError,
  assembleImportPlan,
} from './importCore';

function mapped(over: Partial<MappedMlItem> = {}): MappedMlItem {
  return {
    mlItemId: 'MLB123',
    sku: 'SKU1',
    sellerCustomField: 'SKU1',
    nome: 'Camiseta',
    ehKit: false,
    ehUsado: false,
    pesoLiquidoKg: 0.5,
    pesoBrutoKg: 0.6,
    alturaCm: 5,
    larguraCm: 30,
    profundidadeCm: 20,
    precoNormal: 79.9,
    precoPromocional: 69.9,
    condicao: 1,
    availableQuantity: 12,
    categoryId: 'MLB1430',
    listingTypeId: 'gold_special',
    condition: 'new',
    estado: 'p',
    status: 'active',
    subStatus: null,
    freteGratis: true,
    isUserProductModel: false,
    videoId: null,
    attributes: [{ id: 'BRAND', value_name: 'Acme' }],
    ...over,
  };
}

function args(over: Partial<ImportAssembleArgs> = {}): ImportAssembleArgs {
  return {
    mapped: mapped(),
    options: { ...DEFAULT_IMPORT_OPTIONS },
    produtoId: 'prod1',
    isCreate: true,
    linkDocId: 'link1',
    integracaoId: 'conta-A',
    tabelaNormalId: 'tabNormal',
    tabelaPromoId: 'tabPromo',
    depositoOuterRef: 'documents/depositos/dep1',
    descricao: 'Uma camiseta',
    categoriaOuterRef: null,
    existingProduto: null,
    existingLinkRaw: null,
    existingExtra: null,
    existingEstoqueQty: null,
    existingEstoqueReservada: null,
    now: 1_700_000_000_000,
    ...over,
  };
}

describe('assembleImportPlan — create', () => {
  const plan = assembleImportPlan(args());

  it('writes a full produto with the mapped fields + precos', () => {
    expect(plan.produto?.full).toBe(true);
    expect(plan.produto?.data).toMatchObject({
      nome: 'Camiseta',
      sku: 'SKU1',
      paiId: null,
      publicado: true,
      pesoLiquidoKg: 0.5,
      precos: { tabNormal: { valor: 79.9 }, tabPromo: { valor: 69.9 } },
    });
  });

  it('writes extraData condicao + descricao', () => {
    expect(plan.extra).toMatchObject({ condicao: 1, descricao: 'Uma camiseta' });
  });

  it('creates stock at the depósito (est-<produto>-<deposito>)', () => {
    expect(plan.estoque?.docId).toBe('est-prod1-dep1');
    expect(plan.estoque?.data).toMatchObject({
      quantidade: 12,
      depositoOuterRef: 'documents/depositos/dep1',
    });
  });

  it('stamps the link doc (id/estado/status/condition/attributes)', () => {
    expect(plan.link).toMatchObject({
      id: 'MLB123',
      title: 'Camiseta',
      sku: 'SKU1',
      condition: 'new',
      category_id: 'MLB1430',
      listing_type_id: 'gold_special',
      estado: 'p',
      status: 'active',
      contaOuterRef: 'documents/integracao/conta-A',
      errors: [],
      isUserProductModel: false,
    });
    expect(plan.link.attributes).toEqual([{ id: 'BRAND', value_name: 'Acme' }]);
  });

  it('rejects an item with no title', () => {
    expect(() => assembleImportPlan(args({ mapped: mapped({ nome: '' }) }))).toThrow(
      MercadoLivreImportError,
    );
  });

  it('sets categoriaProdutoOuterRef from args (#442)', () => {
    const p = assembleImportPlan(args({ categoriaOuterRef: 'documents/categorias/MLB1430' }));
    expect(p.produto?.data.categoriaProdutoOuterRef).toBe('documents/categorias/MLB1430');
  });

  it('categoriaOuterRef null (category-API failure) stays null', () => {
    const p = assembleImportPlan(args({ categoriaOuterRef: null }));
    expect(p.produto?.data.categoriaProdutoOuterRef).toBeNull();
  });
});

describe('assembleImportPlan — update (existing produto)', () => {
  it('fill-nulls: keeps existing nome; fills a null sku; prices go to precosOps (not the doc)', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: { nome: 'Nome Editado', sku: null, precos: { tabNormal: { valor: 10 } } },
      }),
    );
    // nome never overwritten; sku was null → filled
    expect(plan.produto?.full).toBe(false);
    expect(plan.produto?.data).not.toHaveProperty('nome');
    expect(plan.produto?.data.sku).toBe('SKU1');
    // prices are NEVER in the produto patch (no whole-map re-validation)
    expect(plan.produto?.data).not.toHaveProperty('precos');
    // sobrescreverPreco default true → precosOps sets both tabela keys
    expect(plan.precosOps?.set).toMatchObject({
      tabNormal: { valor: 79.9 },
      tabPromo: { valor: 69.9 },
    });
    expect(plan.precosOps?.delete).toEqual([]);
  });

  it('CLEARS a promo that ended on ML (sobrescreverPreco) — #1 phantom-promo fix', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: {
          nome: 'X',
          precos: { tabNormal: { valor: 100 }, tabPromo: { valor: 80 } },
        },
        mapped: mapped({ precoNormal: 100, precoPromocional: null }),
      }),
    );
    expect(plan.precosOps?.set).toEqual({ tabNormal: { valor: 100 } });
    expect(plan.precosOps?.delete).toEqual(['tabPromo']);
  });

  it('does NOT overwrite an existing non-null field', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: { nome: 'X', sku: 'KEEP', pesoLiquidoKg: 1.2, precos: null },
        mapped: mapped({
          sku: 'NEW',
          pesoLiquidoKg: 0.5,
          precoNormal: null,
          precoPromocional: null,
        }),
      }),
    );
    expect(plan.produto?.data ?? {}).not.toHaveProperty('sku');
    expect(plan.produto?.data ?? {}).not.toHaveProperty('pesoLiquidoKg');
  });

  it('never re-exposes a produto the user hid (publicado=false preserved) — #6/#8 fix', () => {
    const plan = assembleImportPlan(
      args({ isCreate: false, existingProduto: { nome: 'X', publicado: false } }),
    );
    expect(plan.produto?.data ?? {}).not.toHaveProperty('publicado');
  });

  it('skips produto write entirely when atualizarProdutoPai=false and no price change', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        options: {
          ...DEFAULT_IMPORT_OPTIONS,
          atualizarProdutoPai: false,
          sobrescreverPreco: false,
        },
        existingProduto: { nome: 'X', sku: 'S', precos: { tabNormal: { valor: 10 } } },
      }),
    );
    expect(plan.produto).toBeNull();
    expect(plan.precosOps).toBeNull();
  });

  it('fills categoriaProdutoOuterRef when currently null/absent (#442)', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: { nome: 'X', categoriaProdutoOuterRef: null },
        categoriaOuterRef: 'documents/categorias/MLB1430',
      }),
    );
    expect(plan.produto?.data.categoriaProdutoOuterRef).toBe('documents/categorias/MLB1430');
  });

  it('NEVER overwrites an existing non-null categoriaProdutoOuterRef, even with a new ref supplied', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: { nome: 'X', categoriaProdutoOuterRef: 'documents/categorias/MANUAL' },
        categoriaOuterRef: 'documents/categorias/MLB1430',
      }),
    );
    expect(plan.produto?.data ?? {}).not.toHaveProperty('categoriaProdutoOuterRef');
  });

  it('fills categoriaProdutoOuterRef even when atualizarProdutoPai is false (gated upstream by importarCategorias, not this option)', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        options: {
          ...DEFAULT_IMPORT_OPTIONS,
          atualizarProdutoPai: false,
          sobrescreverPreco: false,
        },
        existingProduto: { nome: 'X', precos: { tabNormal: { valor: 10 } } },
        categoriaOuterRef: 'documents/categorias/MLB1430',
      }),
    );
    expect(plan.produto?.full).toBe(false);
    expect(plan.produto?.data).toEqual({
      categoriaProdutoOuterRef: 'documents/categorias/MLB1430',
    });
  });
});

describe('assembleImportPlan — stock options', () => {
  it('sobrescreverEstoque=false (default) + existing stock → NO stock write', () => {
    const plan = assembleImportPlan(args({ isCreate: false, existingEstoqueQty: 3 }));
    expect(plan.estoque).toBeNull();
  });

  it('sobrescreverEstoque=true adds back reserved so disponivel matches ML (#7 fix)', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingEstoqueQty: 3,
        existingEstoqueReservada: 4,
        options: { ...DEFAULT_IMPORT_OPTIONS, sobrescreverEstoque: true },
      }),
    );
    // ML available=12, 4 reserved → quantidade=16 so disponivel(16-4)=12
    expect(plan.estoque?.data.quantidade).toBe(16);
  });

  it('importarEstoque=false → no stock write on create', () => {
    const plan = assembleImportPlan(
      args({ options: { ...DEFAULT_IMPORT_OPTIONS, importarEstoque: false } }),
    );
    expect(plan.estoque).toBeNull();
  });

  it('no depósito configured → no stock write', () => {
    const plan = assembleImportPlan(args({ depositoOuterRef: null }));
    expect(plan.estoque).toBeNull();
  });
});
