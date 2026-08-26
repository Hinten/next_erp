import { describe, expect, it } from 'vitest';
import type { MappedMlItem, MappedMlVariation } from '@delfrance/integrations-mercado-livre';
import type { TaxonomiaResolution } from './taxonomiaCore';

import {
  DEFAULT_IMPORT_OPTIONS,
  type ImportAssembleArgs,
  type FilhoMedidas,
  type VariationChildAssembleArgs,
  MercadoLivreImportError,
  assembleImportPlan,
  assembleVariationChildPlan,
  medidasEfetivas,
  resolveVariationCombo,
  rollupDimensoesDosFilhos,
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
    userProductId: null,
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
    depositoOuterRef: 'documents/depositos/dep1',
    descricao: 'Uma camiseta',
    categoriaOuterRef: null,
    hasVariations: false,
    parentGrupoUids: null,
    parentVariacoesUid: null,
    existingProduto: null,
    existingLinkRaw: null,
    existingExtra: null,
    existingEstoqueQty: null,
    existingEstoqueReservada: null,
    // #1087 — the default is "asked, ML reported none", which is what every
    // healthy listing gets. `null` ("never asked") is exercised explicitly.
    moderacoes: [],
    now: 1_700_000_000_000,
    ...over,
  };
}

/**
 * One parsed moderação, matching ML's `POOR_QUALITY_THUMBNAIL` sample — the case
 * that made `moderacoes` a field of its own: the listing stays `active` and
 * sendable while ML strips its exposure.
 */
const MODERACAO = {
  nome: 'POOR_QUALITY_THUMBNAIL',
  dataCriacao: '2021-04-14T10:47:05.270-0400',
  motivo: 'A foto principal não atende à qualidade exigida.',
  remedio: 'Suba uma foto com fundo branco e sem textos.',
  secoes: ['pictures'],
  evidencias: ['604505-MLB'],
};

describe('assembleImportPlan — create', () => {
  const plan = assembleImportPlan(args());

  it('writes a full produto with the mapped fields + the tabela NORMAL price only', () => {
    expect(plan.produto?.full).toBe(true);
    expect(plan.produto?.data).toMatchObject({
      nome: 'Camiseta',
      sku: 'SKU1',
      paiId: null,
      publicado: true,
      pesoLiquidoKg: 0.5,
    });
    // Asserted OUTSIDE the toMatchObject: that matcher recurses partially, so a
    // nested `precos: { tabNormal }` would pass with a stray tabPromo alongside
    // it — and the absence of a promo key is the whole point here (#803). The
    // mapped item does carry precoPromocional 69.9.
    expect(plan.produto?.data.precos).toEqual({ tabNormal: { valor: 79.9 } });
  });

  it('writes extraData condicao + descricao + marca', () => {
    expect(plan.extra).toMatchObject({ condicao: 1, descricao: 'Uma camiseta', marca: 'Acme' });
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

  it('stamps ultimaModificacao on create — enables update-monitor and modification-history triggers (#800)', () => {
    const plan = assembleImportPlan(args());
    expect(plan.produto?.data.ultimaModificacao).toBe(1_700_000_000_000);
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
    // sobrescreverPreco default true → precosOps sets the tabela NORMAL key,
    // and ONLY it: the promotional tabela is the ERP's (#803).
    expect(plan.precosOps?.set).toEqual({ tabNormal: { valor: 79.9 } });
  });

  it('NEVER writes the promotional tabela, even with a live ML promo (#803)', () => {
    // The mapped item carries precoPromocional 69.9 and the conta has a promo
    // tabela configured — the pre-#803 plan wrote `tabPromo: { valor: 69.9 }`.
    // The ERP owns that tabela now: an ML deal must not land in it.
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: {
          nome: 'X',
          precos: { tabNormal: { valor: 100 }, tabPromo: { valor: 80 } },
        },
        mapped: mapped({ precoNormal: 100, precoPromocional: 69.9 }),
      }),
    );
    expect(plan.precosOps?.set).toEqual({ tabNormal: { valor: 100 } });
    // The promo price still rides the LINK denorm ("the price live on ML") —
    // that is not a price table.
    expect(plan.link.precoPublicado).toBe(69.9);
  });

  it('an ENDED ML promo no longer deletes the stored promo price (#803)', () => {
    // This is the regression the issue was filed for: the pre-#803 plan emitted
    // `delete: ['tabPromo']` here, wiping a price the ERP may own outright.
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
    expect(plan.precosOps).not.toHaveProperty('delete');
  });

  it('on create, too: the full produto doc carries only the tabela normal (#803)', () => {
    const plan = assembleImportPlan(
      args({ isCreate: true, mapped: mapped({ precoNormal: 100, precoPromocional: 69.9 }) }),
    );
    expect(plan.produto?.data.precos).toEqual({ tabNormal: { valor: 100 } });
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

  it('writes ultimaModificacao timestamp even when atualizarProdutoPai=false and no price change (#800)', () => {
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
    // No fill-null field, no price change, but ultimaModificacao IS written for update monitors
    expect(plan.produto?.data).toEqual({ ultimaModificacao: 1_700_000_000_000 });
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
      ultimaModificacao: 1_700_000_000_000,
    });
  });

  it('stamps ultimaModificacao on update — enables update-monitor and modification-history triggers (#800)', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: { nome: 'X', sku: null },
      }),
    );
    expect(plan.produto?.data.ultimaModificacao).toBe(1_700_000_000_000);
  });

  it('updates ultimaModificacao even when no other fields change (timestamp-only write for update monitors)', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        options: {
          ...DEFAULT_IMPORT_OPTIONS,
          atualizarProdutoPai: false,
          sobrescreverPreco: false,
        },
        existingProduto: {
          nome: 'X',
          sku: 'KEEP',
          pesoLiquidoKg: 1.2,
          precos: { tabNormal: { valor: 10 } },
        },
        mapped: mapped({
          sku: 'NEW',
          pesoLiquidoKg: 0.5,
          precoNormal: null,
          precoPromocional: null,
        }),
      }),
    );
    // Even though all fields would be skipped (no fill-nulls, no price change), the ultimaModificacao patch ensures a write
    expect(plan.produto?.data).toEqual({ ultimaModificacao: 1_700_000_000_000 });
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

  it('⚠️ FLOORS a NEGATIVE stored reservation instead of shrinking the stock (#931)', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingEstoqueQty: 3,
        existingEstoqueReservada: -2,
        options: { ...DEFAULT_IMPORT_OPTIONS, sobrescreverEstoque: true },
      }),
    );
    // The mirror image of ADR 0014 §7: adding a raw −2 back would write
    // quantidade=10 for an ML available of 12, silently destroying two units on
    // EVERY re-import. `reservaEfetiva` floors it, so quantidade === available.
    expect(plan.estoque?.data.quantidade).toBe(12);
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

describe('assembleImportPlan — parent taxonomy links (#520)', () => {
  it('hasVariations=true → NEVER writes parent estoque, even with sobrescreverEstoque + existing stock', () => {
    const plan = assembleImportPlan(
      args({
        hasVariations: true,
        isCreate: false,
        existingEstoqueQty: 3,
        existingEstoqueReservada: 4,
        options: {
          ...DEFAULT_IMPORT_OPTIONS,
          importarEstoque: true,
          sobrescreverEstoque: true,
        },
      }),
    );
    expect(plan.estoque).toBeNull();
  });

  it('hasVariations=true → no parent estoque write on create either', () => {
    const plan = assembleImportPlan(args({ hasVariations: true }));
    expect(plan.estoque).toBeNull();
  });

  /* ---- #706 multiorigem: userProductId on the PARENT link ---------------- */

  it('stamps link.userProductId when the listing IS the stock unit (no children)', () => {
    const plan = assembleImportPlan(
      args({ hasVariations: false, mapped: mapped({ userProductId: 'MLBU111' }) }),
    );
    expect(plan.link.userProductId).toBe('MLBU111');
  });

  it('⚠️ NEVER stamps link.userProductId when the stock lives on children — one member must not speak for the family (#1142)', () => {
    // `mapped` is ONE ML item. Under User Products it is one MEMBER of the
    // family, and under the legacy model the stock units are the variations —
    // either way an item-level UP id on the parent link would let a single
    // quantity be written for the whole family.
    const plan = assembleImportPlan(
      args({ hasVariations: true, mapped: mapped({ userProductId: 'MLBU-MEMBER-1' }) }),
    );
    expect(plan.link.userProductId).toBeNull();
  });

  it('a re-import of a family link CLEARS a userProductId a previous shape left behind', () => {
    // The stamp sits AFTER the spread, so this is not merely "not written" —
    // a stale member id on a family link is actively corrected.
    const plan = assembleImportPlan(
      args({
        hasVariations: true,
        mapped: mapped({ userProductId: 'MLBU-MEMBER-1' }),
        existingLinkRaw: { userProductId: 'MLBU-STALE' },
      }),
    );
    expect(plan.link.userProductId).toBeNull();
  });

  it('create: sets parentGrupoUids/parentVariacoesUid on the parent doc', () => {
    const plan = assembleImportPlan(
      args({
        hasVariations: true,
        parentGrupoUids: ['g-cor', 'g-tam'],
        parentVariacoesUid: [
          'documents/grupoDeVariacoes/g-cor/variacoes/v-azul',
          'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
        ],
      }),
    );
    expect(plan.produto?.data.grupoDeVariacoesUid).toEqual(['g-cor', 'g-tam']);
    expect(plan.produto?.data.variacoesUid).toEqual([
      'documents/grupoDeVariacoes/g-cor/variacoes/v-azul',
      'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
    ]);
  });

  it('create: no variations → both fields null (schema default)', () => {
    const plan = assembleImportPlan(args());
    expect(plan.produto?.data.grupoDeVariacoesUid).toBeNull();
    expect(plan.produto?.data.variacoesUid).toBeNull();
  });

  it('update: fills grupoDeVariacoesUid when currently ABSENT (null)', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        hasVariations: true,
        existingProduto: { nome: 'X' },
        parentGrupoUids: ['g-cor'],
        parentVariacoesUid: ['documents/grupoDeVariacoes/g-cor/variacoes/v-azul'],
      }),
    );
    expect(plan.produto?.data.grupoDeVariacoesUid).toEqual(['g-cor']);
    expect(plan.produto?.data.variacoesUid).toEqual([
      'documents/grupoDeVariacoes/g-cor/variacoes/v-azul',
    ]);
  });

  it('update: fills grupoDeVariacoesUid when currently an EMPTY array — D2 fill-or-empty', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        hasVariations: true,
        existingProduto: { nome: 'X', grupoDeVariacoesUid: [], variacoesUid: [] },
        parentGrupoUids: ['g-cor'],
        parentVariacoesUid: ['documents/grupoDeVariacoes/g-cor/variacoes/v-azul'],
      }),
    );
    expect(plan.produto?.data.grupoDeVariacoesUid).toEqual(['g-cor']);
    expect(plan.produto?.data.variacoesUid).toEqual([
      'documents/grupoDeVariacoes/g-cor/variacoes/v-azul',
    ]);
  });

  it('update: NEVER overwrites a non-empty existing taxonomy array', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        hasVariations: true,
        existingProduto: {
          nome: 'X',
          grupoDeVariacoesUid: ['manual-grupo'],
          variacoesUid: ['documents/grupoDeVariacoes/manual-grupo/variacoes/manual-v'],
        },
        parentGrupoUids: ['g-cor'],
        parentVariacoesUid: ['documents/grupoDeVariacoes/g-cor/variacoes/v-azul'],
      }),
    );
    expect(plan.produto?.data ?? {}).not.toHaveProperty('grupoDeVariacoesUid');
    expect(plan.produto?.data ?? {}).not.toHaveProperty('variacoesUid');
  });
});

/* -------------------------------------------------------------------------- */
/*                     assembleVariationChildPlan (#520)                      */
/* -------------------------------------------------------------------------- */

function mappedVariation(over: Partial<MappedMlVariation> = {}): MappedMlVariation {
  return {
    variationId: '999',
    sku: 'SKU1-AZ',
    nome: 'Camiseta Azul',
    availableQuantity: 5,
    combos: [{ id: 'COLOR', value_id: '123', value_name: 'Azul', name: 'Cor' }],
    sellerCustomField: null,
    ...over,
  };
}

function taxonomiaResolution(over: Partial<TaxonomiaResolution> = {}): TaxonomiaResolution {
  return {
    attrKey: 'COLOR|123',
    grupoId: 'g-cor',
    varianteId: 'v-azul',
    grupoUid: 'g-cor',
    varianteFake: 'documents/grupoDeVariacoes/g-cor/variacoes/v-azul',
    ...over,
  };
}

function childArgs(over: Partial<VariationChildAssembleArgs> = {}): VariationChildAssembleArgs {
  return {
    mappedVariation: mappedVariation(),
    taxonomia: [taxonomiaResolution()],
    parent: {
      produtoId: 'parent1',
      precos: { tabNormal: { valor: 79.9 } },
      linkOuterRef: 'documents/produtos/parent1/produtoMercadoLivre/link1',
      mlItemId: 'MLB123',
      ehKit: false,
      ehUsado: false,
      categoriaOuterRef: 'documents/categorias/MLB1430',
      dims: {
        pesoLiquidoKg: 0.5,
        pesoBrutoKg: 0.6,
        alturaCm: 5,
        larguraCm: 30,
        profundidadeCm: 20,
      },
    },
    options: { ...DEFAULT_IMPORT_OPTIONS },
    produtoId: 'child1',
    isCreate: true,
    linkDocId: 'ml-child-link1',
    integracaoId: 'conta-A',
    depositoOuterRef: 'documents/depositos/dep1',
    existingProduto: null,
    existingLinkRaw: null,
    existingEstoqueQty: null,
    existingEstoqueReservada: null,
    now: 1_700_000_000_000,
    up: null,
    ...over,
  };
}

describe('resolveVariationCombo (#801)', () => {
  it('keeps only the entries whose attrKey this variation actually carries', () => {
    const combo = resolveVariationCombo(mappedVariation().combos, [
      taxonomiaResolution(), // COLOR|123 — this variation's own
      taxonomiaResolution({
        attrKey: 'SIZE|9',
        grupoId: 'g-tam',
        varianteId: 'v-m',
        grupoUid: 'g-tam',
        varianteFake: 'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
      }), // a SIBLING variation's combo — must not leak in
    ]);
    expect(combo).toEqual({
      grupoUids: ['g-cor'],
      varianteFakes: ['documents/grupoDeVariacoes/g-cor/variacoes/v-azul'],
    });
  });

  it('nothing matched → both null, which is what makes the dedup skip this variation', () => {
    expect(resolveVariationCombo(mappedVariation().combos, [])).toEqual({
      grupoUids: null,
      varianteFakes: null,
    });
    expect(resolveVariationCombo([], [taxonomiaResolution()])).toEqual({
      grupoUids: null,
      varianteFakes: null,
    });
  });

  it('de-dupes two combos that resolved onto the same grupo/variante', () => {
    const combos = [
      { id: 'COLOR', value_id: '123', value_name: 'Azul', name: 'Cor' },
      { id: 'COLOR', value_id: '123', value_name: 'Azul', name: 'Cor' },
    ];
    expect(resolveVariationCombo(combos, [taxonomiaResolution()])).toEqual({
      grupoUids: ['g-cor'],
      varianteFakes: ['documents/grupoDeVariacoes/g-cor/variacoes/v-azul'],
    });
  });

  it('is the SAME derivation assembleVariationChildPlan writes (the two must never diverge)', () => {
    const taxonomia = [
      taxonomiaResolution(),
      taxonomiaResolution({
        attrKey: 'SIZE|9',
        grupoId: 'g-tam',
        varianteId: 'v-m',
        grupoUid: 'g-tam',
        varianteFake: 'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
      }),
    ];
    const plan = assembleVariationChildPlan(childArgs({ taxonomia }));
    const combo = resolveVariationCombo(mappedVariation().combos, taxonomia);
    expect(plan.produto?.data.grupoDeVariacoesUid).toEqual(combo.grupoUids);
    expect(plan.produto?.data.variacoesUid).toEqual(combo.varianteFakes);
  });
});

describe('assembleVariationChildPlan — create', () => {
  it('writes a full child doc: paiId/nome/sku/publicado/kit flags mirror the parent', () => {
    const plan = assembleVariationChildPlan(childArgs());
    expect(plan.produto?.full).toBe(true);
    expect(plan.produto?.data).toMatchObject({
      nome: 'Camiseta Azul',
      sku: 'SKU1-AZ',
      paiId: 'parent1',
      publicado: true,
      ehKit: false,
      ehUsado: false,
      timestamp: 1_700_000_000_000,
    });
  });

  it('caps the composed child nome at the produtoSchema 100-char limit', () => {
    const longNome = `Camiseta ${'Estampada '.repeat(15)}Azul GG`; // > 100 chars
    const plan = assembleVariationChildPlan(
      childArgs({ mappedVariation: mappedVariation({ nome: longNome }) }),
    );
    expect((plan.produto?.data.nome as string).length).toBe(100);
    expect(plan.produto?.data.nome).toBe(longNome.slice(0, 100));
  });

  it('copies the parent WHOLE precos map under importarPreco', () => {
    const plan = assembleVariationChildPlan(childArgs());
    expect(plan.produto?.data.precos).toEqual({ tabNormal: { valor: 79.9 } });
  });

  it('importarPreco=false → precos stays null on create', () => {
    const plan = assembleVariationChildPlan(
      childArgs({ options: { ...DEFAULT_IMPORT_OPTIONS, importarPreco: false } }),
    );
    expect(plan.produto?.data.precos).toBeNull();
  });

  it('resolves grupoDeVariacoesUid/variacoesUid from the matching taxonomia entries only', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        taxonomia: [
          taxonomiaResolution(), // matches the variation's only combo (COLOR|123)
          taxonomiaResolution({
            attrKey: 'SIZE|9',
            grupoId: 'g-tam',
            varianteId: 'v-m',
            grupoUid: 'g-tam',
            varianteFake: 'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
          }), // a DIFFERENT variation's combo — must NOT leak onto this child
        ],
      }),
    );
    expect(plan.produto?.data.grupoDeVariacoesUid).toEqual(['g-cor']);
    expect(plan.produto?.data.variacoesUid).toEqual([
      'documents/grupoDeVariacoes/g-cor/variacoes/v-azul',
    ]);
  });

  it('no matching taxonomia entries → both uid fields null', () => {
    const plan = assembleVariationChildPlan(childArgs({ taxonomia: [] }));
    expect(plan.produto?.data.grupoDeVariacoesUid).toBeNull();
    expect(plan.produto?.data.variacoesUid).toBeNull();
  });

  it('atualizarProdutoPai=true → copies dims + categoria from the parent', () => {
    const plan = assembleVariationChildPlan(childArgs());
    expect(plan.produto?.data).toMatchObject({
      pesoLiquidoKg: 0.5,
      pesoBrutoKg: 0.6,
      alturaCm: 5,
      larguraCm: 30,
      profundidadeCm: 20,
      categoriaProdutoOuterRef: 'documents/categorias/MLB1430',
    });
  });

  it('atualizarProdutoPai=false → dims/categoria are NOT on the create doc', () => {
    const plan = assembleVariationChildPlan(
      childArgs({ options: { ...DEFAULT_IMPORT_OPTIONS, atualizarProdutoPai: false } }),
    );
    expect(plan.produto?.data ?? {}).not.toHaveProperty('pesoLiquidoKg');
    expect(plan.produto?.data ?? {}).not.toHaveProperty('categoriaProdutoOuterRef');
    // sku/publicado/taxonomy are NOT gated by atualizarProdutoPai — still present.
    expect(plan.produto?.data.sku).toBe('SKU1-AZ');
    expect(plan.produto?.data.publicado).toBe(true);
    expect(plan.produto?.data.grupoDeVariacoesUid).toEqual(['g-cor']);
  });
});

describe('assembleVariationChildPlan — update (existing child)', () => {
  it('fill-null: keeps existing nome untouched (never in the patch), fills a null sku', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        existingProduto: { nome: 'Nome Editado', sku: null },
      }),
    );
    expect(plan.produto?.full).toBe(false);
    expect(plan.produto?.data).not.toHaveProperty('nome');
    expect(plan.produto?.data.sku).toBe('SKU1-AZ');
  });

  it('never re-exposes a hidden child (publicado=false preserved)', () => {
    const plan = assembleVariationChildPlan(
      childArgs({ isCreate: false, existingProduto: { nome: 'X', publicado: false } }),
    );
    expect(plan.produto?.data ?? {}).not.toHaveProperty('publicado');
  });

  it('fills taxonomy uids when currently null/empty, never when already populated', () => {
    const filled = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        existingProduto: { nome: 'X', grupoDeVariacoesUid: [], variacoesUid: null },
      }),
    );
    expect(filled.produto?.data.grupoDeVariacoesUid).toEqual(['g-cor']);
    expect(filled.produto?.data.variacoesUid).toEqual([
      'documents/grupoDeVariacoes/g-cor/variacoes/v-azul',
    ]);

    const preserved = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        existingProduto: {
          nome: 'X',
          grupoDeVariacoesUid: ['manual-grupo'],
          variacoesUid: ['documents/grupoDeVariacoes/manual-grupo/variacoes/manual-v'],
        },
      }),
    );
    expect(preserved.produto?.data ?? {}).not.toHaveProperty('grupoDeVariacoesUid');
    expect(preserved.produto?.data ?? {}).not.toHaveProperty('variacoesUid');
  });

  it('atualizarProdutoPai gates dims/categoria fill on update too', () => {
    const on = assembleVariationChildPlan(
      childArgs({ isCreate: false, existingProduto: { nome: 'X', pesoLiquidoKg: null } }),
    );
    expect(on.produto?.data.pesoLiquidoKg).toBe(0.5);
    expect(on.produto?.data.categoriaProdutoOuterRef).toBe('documents/categorias/MLB1430');

    const off = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        options: {
          ...DEFAULT_IMPORT_OPTIONS,
          atualizarProdutoPai: false,
          sobrescreverPreco: false,
        },
        existingProduto: { nome: 'X', sku: 'KEEP', pesoLiquidoKg: null },
      }),
    );
    expect(off.produto?.data ?? {}).not.toHaveProperty('pesoLiquidoKg');
    expect(off.produto?.data ?? {}).not.toHaveProperty('categoriaProdutoOuterRef');
  });

  it('does NOT fill an already-non-null dims/categoria field', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        existingProduto: {
          nome: 'X',
          pesoLiquidoKg: 9.9,
          categoriaProdutoOuterRef: 'documents/categorias/MANUAL',
        },
      }),
    );
    expect(plan.produto?.data ?? {}).not.toHaveProperty('pesoLiquidoKg');
    expect(plan.produto?.data ?? {}).not.toHaveProperty('categoriaProdutoOuterRef');
  });

  it('sobrescreverPreco=true SETS the WHOLE parent precos map, even over a different existing map', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        existingProduto: { nome: 'X', precos: { tabOld: { valor: 1 } } },
        options: { ...DEFAULT_IMPORT_OPTIONS, sobrescreverPreco: true },
      }),
    );
    expect(plan.produto?.data.precos).toEqual({ tabNormal: { valor: 79.9 } });
  });

  it('sobrescreverPreco=false → precos absent from the patch', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        existingProduto: { nome: 'X' },
        options: { ...DEFAULT_IMPORT_OPTIONS, sobrescreverPreco: false },
      }),
    );
    expect(plan.produto?.data ?? {}).not.toHaveProperty('precos');
  });

  it('writes ultimaModificacao even when no other field changes (update monitor)', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        options: {
          ...DEFAULT_IMPORT_OPTIONS,
          atualizarProdutoPai: false,
          sobrescreverPreco: false,
        },
        existingProduto: {
          nome: 'X',
          sku: 'KEEP',
          publicado: true,
          grupoDeVariacoesUid: ['manual'],
          variacoesUid: ['documents/grupoDeVariacoes/manual/variacoes/v'],
        },
      }),
    );
    expect(plan.produto?.data).toEqual({ ultimaModificacao: 1_700_000_000_000 });
  });
});

describe('assembleVariationChildPlan — estoque', () => {
  it('creates child stock at the depósito from availableQuantity', () => {
    const plan = assembleVariationChildPlan(childArgs());
    expect(plan.estoque?.docId).toBe('est-child1-dep1');
    expect(plan.estoque?.data).toMatchObject({
      quantidade: 5,
      parentId: 'child1',
      depositoOuterRef: 'documents/depositos/dep1',
    });
  });

  it('sobrescreverEstoque=false (default) + existing stock → no write', () => {
    const plan = assembleVariationChildPlan(childArgs({ isCreate: false, existingEstoqueQty: 2 }));
    expect(plan.estoque).toBeNull();
  });

  it('sobrescreverEstoque=true adds back reserved so disponivel matches ML', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        existingEstoqueQty: 2,
        existingEstoqueReservada: 3,
        options: { ...DEFAULT_IMPORT_OPTIONS, sobrescreverEstoque: true },
      }),
    );
    // availableQuantity=5, 3 reserved → quantidade=8 so disponivel(8-3)=5
    expect(plan.estoque?.data.quantidade).toBe(8);
  });

  it('⚠️ FLOORS a NEGATIVE stored reservation — the child arm is not a lesser copy (#931)', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        existingEstoqueQty: 2,
        existingEstoqueReservada: -2,
        options: { ...DEFAULT_IMPORT_OPTIONS, sobrescreverEstoque: true },
      }),
    );
    // Same defect as the parent arm, and the one #931 did not name: a raw −2
    // would write quantidade=3 for an ML available of 5.
    expect(plan.estoque?.data.quantidade).toBe(5);
  });

  it('importarEstoque=false → no stock write on create', () => {
    const plan = assembleVariationChildPlan(
      childArgs({ options: { ...DEFAULT_IMPORT_OPTIONS, importarEstoque: false } }),
    );
    expect(plan.estoque).toBeNull();
  });
});

describe('assembleVariationChildPlan — variacaoMercadoLivre link', () => {
  it('legacy variations[]: userProductId is preserved-or-null, never invented (#706)', () => {
    // An ML `variations[]` entry carries no `user_product_id` — only a UP member
    // (which is its own item) does. Same rule as `itemId` beside it.
    expect(assembleVariationChildPlan(childArgs()).link.userProductId).toBeNull();
    expect(
      assembleVariationChildPlan(childArgs({ existingLinkRaw: { userProductId: 'MLBU-KEEP' } }))
        .link.userProductId,
    ).toBe('MLBU-KEEP');
  });

  it('stamps the exact legacy wire on a fresh link (numeric id, itemId null, outer-refs)', () => {
    const plan = assembleVariationChildPlan(childArgs());
    expect(plan.link).toMatchObject({
      id: 999,
      itemId: null,
      produtoVariacaoOuterRef: 'documents/produtos/child1',
      produtoMercadoLivreOuterRef: 'documents/produtos/parent1/produtoMercadoLivre/link1',
      sku: 'SKU1-AZ',
    });
    // Null-valued keys are OMITTED (legacy `includeIfNull: false` parity) — the
    // entry carries only the fields the combo actually had.
    expect(plan.link.attributes).toEqual([
      {
        id: 'COLOR',
        name: 'Cor',
        value_id: '123',
        value_name: 'Azul',
      },
    ]);
  });

  it('non-numeric variation id → id: null', () => {
    const plan = assembleVariationChildPlan(
      childArgs({ mappedVariation: mappedVariation({ variationId: 'abc' }) }),
    );
    expect(plan.link.id).toBeNull();
  });

  it('spreads an existing link, preserves unknown keys, and preserves a stamped itemId', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        existingLinkRaw: { legacyOnlyKey: 'kept', itemId: 'MLB999-user-product' },
      }),
    );
    expect(plan.link.legacyOnlyKey).toBe('kept');
    expect(plan.link.itemId).toBe('MLB999-user-product');
  });

  it('filters attribute_combinations entries without an id', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        mappedVariation: mappedVariation({
          combos: [
            { id: 'COLOR', value_id: '123', value_name: 'Azul', name: 'Cor' },
            { value_name: 'sem id' },
          ],
        }),
      }),
    );
    expect(plan.link.attributes).toHaveLength(1);
    expect((plan.link.attributes as Array<{ id: string }>)[0]!.id).toBe('COLOR');
  });
});

describe('assembleVariationChildPlan — denorm', () => {
  it('denorm carries the variation id + the parent ML item id', () => {
    const plan = assembleVariationChildPlan(childArgs());
    expect(plan.denorm).toEqual({ externalId: '999', externalParentId: 'MLB123' });
  });
});

/* -------------------------------------------------------------------------- */
/*               User-Products (family_name) mode — #521                     */
/* -------------------------------------------------------------------------- */

describe('assembleVariationChildPlan — User-Products mode (args.up)', () => {
  it('stamps link.itemId from up.itemId; numeric id stays null even when the id string looks numeric', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        mappedVariation: mappedVariation({ variationId: '4455667788' }),
        up: {
          itemId: '4455667788',
          status: null,
          subStatus: null,
          userProductId: null,
          moderacoes: [],
        },
      }),
    );
    expect(plan.link.itemId).toBe('4455667788');
    expect(plan.link.id).toBeNull();
  });

  it('stamps the member own userProductId on the child link (#706)', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        mappedVariation: mappedVariation({ variationId: 'MLB4455667788' }),
        up: {
          itemId: 'MLB4455667788',
          status: null,
          subStatus: null,
          moderacoes: [],
          userProductId: 'MLBU-MEMBER-9',
        },
      }),
    );
    expect(plan.link.userProductId).toBe('MLBU-MEMBER-9');
  });

  it('preserves an existing numeric link id on re-import (never recomputed from the itemId)', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        mappedVariation: mappedVariation({ variationId: 'MLB4455667788' }),
        up: {
          itemId: 'MLB4455667788',
          status: null,
          subStatus: null,
          userProductId: null,
          moderacoes: [],
        },
        existingLinkRaw: { id: 42, itemId: 'MLB4455667788' },
      }),
    );
    expect(plan.link.id).toBe(42);
    expect(plan.link.itemId).toBe('MLB4455667788');
  });

  it('denorm carries the exact isUserProductModel relevantData marker (byte-match Flutter ProdMarketplace.relevantData)', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        mappedVariation: mappedVariation({ variationId: 'MLB4455667788' }),
        up: {
          itemId: 'MLB4455667788',
          status: null,
          subStatus: null,
          userProductId: null,
          moderacoes: [],
        },
      }),
    );
    expect(plan.denorm).toEqual({
      externalId: 'MLB4455667788',
      externalParentId: 'MLB123',
      relevantData: { isUserProductModel: true },
    });
  });

  it('child sku is always the member own SELLER_SKU (D-C) — never a family/parent sku fallback', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        mappedVariation: mappedVariation({ variationId: 'MLB4455667788', sku: 'MEMBER-SKU' }),
        up: {
          itemId: 'MLB4455667788',
          status: null,
          subStatus: null,
          userProductId: null,
          moderacoes: [],
        },
      }),
    );
    expect(plan.produto?.data.sku).toBe('MEMBER-SKU');
    expect(plan.link.sku).toBe('MEMBER-SKU');
  });

  it('up: null (#520 variations[] mode) regression — numeric id, itemId preserved-or-null, no relevantData key', () => {
    const plan = assembleVariationChildPlan(childArgs());
    expect(plan.link.id).toBe(999);
    expect(plan.link.itemId).toBeNull();
    expect(plan.denorm).toEqual({ externalId: '999', externalParentId: 'MLB123' });
    expect(plan.denorm).not.toHaveProperty('relevantData');
  });
});

/**
 * ML MODERATIONS on the import path (#1087).
 *
 * The invariant these pin, verbatim from `produtoMercadoLivreLinkSchema`:
 * `moderacoes` is written in the SAME patch as the `status`/`sub_status` it
 * explains, on every status write, either to a value or to `[]` — so a reason
 * cannot outlive the state it explains.
 *
 * The import writes `status` (see the create describe above) but used to write
 * no `moderacoes` at all, which broke that invariant in both directions: a
 * moderated listing imported with no reason, and a re-import carried a LIFTED
 * moderation forward on the `...existingLink` spread.
 */
describe('assembleImportPlan — ML moderations (#1087)', () => {
  it('writes the moderação in the SAME link patch as the status it explains', () => {
    const plan = assembleImportPlan(
      args({
        mapped: mapped({ estado: 'pa', status: 'paused', subStatus: ['moderation_penalty'] }),
        moderacoes: [MODERACAO],
      }),
    );
    expect(plan.link).toMatchObject({
      estado: 'pa',
      status: 'paused',
      sub_status: ['moderation_penalty'],
      moderacoes: [MODERACAO],
    });
  });

  it('⚠️ a re-import of a listing whose moderação ML LIFTED overwrites the stored reason', () => {
    // THE regression. The link write is `{ ...existingLink, … }` and
    // `clearFalha()` deliberately carries no `moderacoes`, so before this the old
    // reason survived onto a listing ML now calls `active` — and a stale reason
    // is indistinguishable from a real one, which makes it worse than none.
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: { nome: 'Camiseta' },
        existingLinkRaw: { status: 'paused', moderacoes: [MODERACAO] },
        mapped: mapped({ estado: 'p', status: 'active', subStatus: [] }),
        moderacoes: [],
      }),
    );
    expect(plan.link.moderacoes).toEqual([]);
    expect(plan.link.status).toBe('active');
  });

  it('survives clearFalha() — our failed write and ML’s verdict are not the same statement', () => {
    // `errors`/`causas` record OUR rejected write, so an import invalidates them.
    // A moderação is ML's policy verdict and nothing we do lifts it, which is why
    // it rides its own rule and must land in the same object as the cleared pair.
    const plan = assembleImportPlan(args({ moderacoes: [MODERACAO] }));
    expect(plan.link).toMatchObject({
      errors: [],
      causas: [],
      moderacoes: [MODERACAO],
    });
  });

  it('an ASKED-and-none is [], never the never-asked null', () => {
    // The two are byte-distinct on disk and the whole degrade story rests on it.
    const plan = assembleImportPlan(args({ moderacoes: [] }));
    expect(plan.link.moderacoes).toEqual([]);
    expect(plan.link.moderacoes).not.toBeNull();
  });

  it('⚠️ null ("never asked") OMITS the key — it must not write [] over a real reason', () => {
    // The mass import and a failed `/moderations` read both land here. Writing
    // `[]` would record "not moderated" about a listing nobody asked about;
    // omitting lets the spread preserve what was stored (and the schema default
    // supply `null` on create).
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: { nome: 'Camiseta' },
        existingLinkRaw: { status: 'paused', moderacoes: [MODERACAO] },
        mapped: mapped({ estado: 'pa', status: 'paused', subStatus: ['moderation_penalty'] }),
        moderacoes: null,
      }),
    );
    // Carried by the spread, untouched — not re-stated by the plan.
    expect(plan.link.moderacoes).toEqual([MODERACAO]);

    const fresh = assembleImportPlan(args({ moderacoes: null }));
    expect(fresh.link).not.toHaveProperty('moderacoes');
  });
});

describe('assembleVariationChildPlan — ML moderations (#1087)', () => {
  const upBase = {
    itemId: 'MLB4455667788',
    status: 'under_review',
    subStatus: ['held'],
    userProductId: 'MLBU-MEMBER-9',
  };

  it('a UP member stamps its OWN moderação beside its own status', () => {
    // Moderation is per ML item, and under User Products a member IS its own
    // listing — so the member link carries the member's verdict, never the
    // family's.
    const plan = assembleVariationChildPlan(
      childArgs({
        mappedVariation: mappedVariation({ variationId: 'MLB4455667788' }),
        up: { ...upBase, moderacoes: [MODERACAO] },
      }),
    );
    expect(plan.link).toMatchObject({
      status: 'under_review',
      sub_status: ['held'],
      moderacoes: [MODERACAO],
    });
  });

  it('a UP member whose moderação was lifted clears over the spread', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        mappedVariation: mappedVariation({ variationId: 'MLB4455667788' }),
        existingLinkRaw: { moderacoes: [MODERACAO] },
        up: { ...upBase, status: 'active', subStatus: [], moderacoes: [] },
      }),
    );
    expect(plan.link.moderacoes).toEqual([]);
  });

  it('a UP member with null ("never asked") keeps whatever the spread carried', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        mappedVariation: mappedVariation({ variationId: 'MLB4455667788' }),
        existingLinkRaw: { moderacoes: [MODERACAO] },
        up: { ...upBase, moderacoes: null },
      }),
    );
    expect(plan.link.moderacoes).toEqual([MODERACAO]);
  });

  it('⚠️ a legacy variations[] member is NEVER written — symmetric with status', () => {
    // A `variations[]` entry is not a listing of its own and has no status to
    // explain, so it has no moderation either. That symmetry is what keeps
    // #707's phantom prune — which writes only legacy member links — free of
    // stale reasons it never read.
    const fresh = assembleVariationChildPlan(childArgs({ up: null }));
    expect(fresh.link.moderacoes).toBeNull();

    const existing = assembleVariationChildPlan(
      childArgs({
        isCreate: false,
        up: null,
        existingLinkRaw: { id: 999, moderacoes: [MODERACAO] },
      }),
    );
    expect(existing.link.moderacoes).toEqual([MODERACAO]);
  });
});

/* --------------------------- marca (#1087 / #1293) ------------------------- */

/** The plan's extraData patch for one set of overrides. */
const extraDe = (over: Partial<ImportAssembleArgs> = {}) => assembleImportPlan(args(over)).extra;

/** An update onto an existing produto, which is where the overwrite rule bites. */
const updateArgs = (over: Partial<ImportAssembleArgs> = {}): Partial<ImportAssembleArgs> => ({
  isCreate: false,
  existingProduto: { nome: 'Camiseta' },
  ...over,
});

describe('assembleImportPlan — extraData.marca', () => {
  it('fills the produto Marca from the listing BRAND on create', () => {
    expect(extraDe()).toMatchObject({ marca: 'Acme' });
  });

  it('fills a BLANK Marca on re-import', () => {
    expect(extraDe(updateArgs({ existingExtra: { marca: null } }))).toMatchObject({
      marca: 'Acme',
    });
  });

  it('treats a whitespace-only stored Marca as blank', () => {
    expect(extraDe(updateArgs({ existingExtra: { marca: '   ' } }))).toMatchObject({
      marca: 'Acme',
    });
  });

  // The whole point of the default: a re-import must not replace typed work.
  // ⚠️ The two values are deliberately DIFFERENT strings — with the fixture's
  // 'Acme' on both sides this assertion would pass against a clobbering writer.
  it('does NOT overwrite a Marca the operator already typed', () => {
    expect(extraDe(updateArgs({ existingExtra: { marca: 'Hering' } }))?.marca).toBeUndefined();
  });

  it('overwrites it under sobrescreverDadosProduto', () => {
    expect(
      extraDe(
        updateArgs({
          existingExtra: { marca: 'Hering' },
          options: { ...DEFAULT_IMPORT_OPTIONS, sobrescreverDadosProduto: true },
        }),
      ),
    ).toMatchObject({ marca: 'Acme' });
  });

  // An import that simply lost the attribute must not erase the value the whole
  // publish path now derives from — absence is never persisted.
  it('writes nothing when the listing carries no BRAND', () => {
    const extra = extraDe(
      updateArgs({
        mapped: mapped({ attributes: [{ id: 'MODEL', value_name: 'X' }] }),
        existingExtra: { marca: 'Hering' },
      }),
    );
    expect(extra?.marca).toBeUndefined();
  });

  // ML's "does not apply" marker is an ANSWER, not a brand — and its value_name
  // is the literal string 'N/A', which is what a hand-rolled reader would store.
  it('does not store the ML N/A sentinel as a brand named N/A', () => {
    const extra = extraDe({
      mapped: mapped({ attributes: [{ id: 'BRAND', value_id: '-1', value_name: 'N/A' }] }),
    });
    expect(extra?.marca).toBeUndefined();
  });

  it('trims and caps at the schema limit (255)', () => {
    const longa = 'M'.repeat(300);
    const extra = extraDe({
      mapped: mapped({ attributes: [{ id: 'BRAND', value_name: '  ' + longa + '  ' }] }),
    });
    expect(extra?.marca).toBe('M'.repeat(255));
  });

  it('leaves a whitespace-only BRAND alone rather than blanking the produto', () => {
    const extra = extraDe({
      mapped: mapped({ attributes: [{ id: 'BRAND', value_name: '   ' }] }),
    });
    expect(extra?.marca).toBeUndefined();
  });
});

/* ------------------- sobrescreverDadosProduto — produto fields ------------- */

describe('assembleImportPlan — sobrescreverDadosProduto', () => {
  // Stored values differ from the mapped ones on every field, so a no-op
  // implementation cannot pass either direction of this pair.
  const stored = {
    nome: 'Camiseta',
    sku: 'ANTIGO',
    // Present so the unrelated `publicado` fill-null does not fire and muddy the
    // exact-equality assertions below.
    publicado: true,
    pesoLiquidoKg: 9,
    pesoBrutoKg: 9,
    alturaCm: 99,
    larguraCm: 99,
    profundidadeCm: 99,
  };

  it('leaves filled produto fields alone by default', () => {
    const plan = assembleImportPlan(args({ isCreate: false, existingProduto: stored }));
    expect(plan.produto?.data).toEqual({ ultimaModificacao: 1_700_000_000_000 });
  });

  it('replaces them when the operator asks', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: stored,
        options: { ...DEFAULT_IMPORT_OPTIONS, sobrescreverDadosProduto: true },
      }),
    );
    expect(plan.produto?.data).toMatchObject({
      sku: 'SKU1',
      pesoLiquidoKg: 0.5,
      pesoBrutoKg: 0.6,
      alturaCm: 5,
      larguraCm: 30,
      profundidadeCm: 20,
    });
  });

  // The carve-outs are the reason the flag is narrow rather than "overwrite".
  it('never touches descricao, publicado or the categoria', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: { ...stored, publicado: false, categoriaProdutoOuterRef: 'documents/c/1' },
        existingExtra: { descricao: 'texto do operador' },
        categoriaOuterRef: 'documents/c/2',
        options: { ...DEFAULT_IMPORT_OPTIONS, sobrescreverDadosProduto: true },
      }),
    );
    expect(plan.produto?.data.publicado).toBeUndefined();
    expect(plan.produto?.data.categoriaProdutoOuterRef).toBeUndefined();
    expect(plan.extra?.descricao).toBeUndefined();
  });

  it('is inert while atualizarProdutoPai is off', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: stored,
        options: {
          ...DEFAULT_IMPORT_OPTIONS,
          atualizarProdutoPai: false,
          sobrescreverDadosProduto: true,
        },
      }),
    );
    expect(plan.produto?.data).toEqual({ ultimaModificacao: 1_700_000_000_000 });
  });

  // Absence is not an instruction to erase: ML omitting a field must never null
  // out the ERP's copy, whatever the flag says.
  it('never writes a null over a stored value', () => {
    const plan = assembleImportPlan(
      args({
        isCreate: false,
        existingProduto: stored,
        mapped: mapped({ alturaCm: null, pesoBrutoKg: null }),
        options: { ...DEFAULT_IMPORT_OPTIONS, sobrescreverDadosProduto: true },
      }),
    );
    expect(plan.produto?.data.alturaCm).toBeUndefined();
    expect(plan.produto?.data.pesoBrutoKg).toBeUndefined();
  });
});

/* ------------------------ dimension rollup (#1087) ------------------------- */

const medidas = (over: Partial<FilhoMedidas> = {}): FilhoMedidas => ({
  produtoId: 'filho1',
  pesoLiquidoKg: 0.5,
  pesoBrutoKg: 0.6,
  alturaCm: 5,
  larguraCm: 30,
  profundidadeCm: 20,
  ...over,
});

const PAI_VAZIO = {
  pesoLiquidoKg: null,
  pesoBrutoKg: null,
  alturaCm: null,
  larguraCm: null,
  profundidadeCm: null,
};

describe('rollupDimensoesDosFilhos', () => {
  it('fills a blank parent from its only child', () => {
    expect(rollupDimensoesDosFilhos(PAI_VAZIO, [medidas()])).toEqual({
      pesoLiquidoKg: 0.5,
      pesoBrutoKg: 0.6,
      alturaCm: 5,
      larguraCm: 30,
      profundidadeCm: 20,
    });
  });

  it('does nothing when the parent already has everything', () => {
    expect(rollupDimensoesDosFilhos(medidas(), [medidas({ alturaCm: 77 })])).toBeNull();
  });

  // Fill-BLANK-only: a measurement the operator typed on the parent stands, even
  // beside a child that disagrees.
  it('fills only the blanks and never replaces a parent value', () => {
    const patch = rollupDimensoesDosFilhos({ ...PAI_VAZIO, alturaCm: 77 }, [
      medidas({ alturaCm: 5 }),
    ]);
    expect(patch).toEqual({
      pesoLiquidoKg: 0.5,
      pesoBrutoKg: 0.6,
      larguraCm: 30,
      profundidadeCm: 20,
    });
  });

  it('ignores a child with an incomplete or zero set', () => {
    expect(rollupDimensoesDosFilhos(PAI_VAZIO, [medidas({ larguraCm: null })])).toBeNull();
    expect(rollupDimensoesDosFilhos(PAI_VAZIO, [medidas({ profundidadeCm: 0 })])).toBeNull();
    expect(rollupDimensoesDosFilhos(PAI_VAZIO, [])).toBeNull();
  });

  // A child carrying only a NET weight is exactly what `dimensoesDoPacote` falls
  // back on, so requiring pesoBrutoKg would reject the children this exists for.
  it('accepts a donor with no gross weight', () => {
    expect(rollupDimensoesDosFilhos(PAI_VAZIO, [medidas({ pesoBrutoKg: null })])).toEqual({
      pesoLiquidoKg: 0.5,
      alturaCm: 5,
      larguraCm: 30,
      profundidadeCm: 20,
    });
  });

  // ⚠️ Every axis from ONE child. Mixing them would invent a box no variation
  // has, and ML rejects a partial/unrealistic package outright.
  it('takes every axis from the FIRST usable child, never mixing donors', () => {
    const patch = rollupDimensoesDosFilhos(PAI_VAZIO, [
      medidas({ produtoId: 'incompleto', alturaCm: null, larguraCm: 111 }),
      medidas({ produtoId: 'a', alturaCm: 5, larguraCm: 30, profundidadeCm: 20 }),
      medidas({ produtoId: 'b', alturaCm: 8, larguraCm: 88, profundidadeCm: 88 }),
    ]);
    expect(patch).toEqual({
      pesoLiquidoKg: 0.5,
      pesoBrutoKg: 0.6,
      alturaCm: 5,
      larguraCm: 30,
      profundidadeCm: 20,
    });
  });
});

describe('medidasEfetivas', () => {
  it('lays the plan patch over the stored doc', () => {
    expect(medidasEfetivas({ alturaCm: 1, larguraCm: 2 }, { alturaCm: 9 })).toEqual({
      pesoLiquidoKg: null,
      pesoBrutoKg: null,
      alturaCm: 9,
      larguraCm: 2,
      profundidadeCm: null,
    });
  });

  // ⚠️ A `??` fold here would report the STALE stored value for a field the plan
  // just wrote null to — which is exactly what the parent create path writes
  // when ML reported no package.
  it('honours an explicit null in the patch instead of falling back', () => {
    expect(medidasEfetivas({ alturaCm: 1 }, { alturaCm: null }).alturaCm).toBeNull();
  });

  it('ignores non-numeric junk on either side', () => {
    expect(medidasEfetivas({ alturaCm: '5' }, null).alturaCm).toBeNull();
    expect(medidasEfetivas(null, null)).toEqual(PAI_VAZIO);
  });
});
