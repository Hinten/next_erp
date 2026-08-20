import { describe, expect, it } from 'vitest';
import type { MappedMlItem, MappedMlVariation } from '@delfrance/integrations-mercado-livre';
import type { TaxonomiaResolution } from './taxonomiaCore';

import {
  DEFAULT_IMPORT_OPTIONS,
  type ImportAssembleArgs,
  type VariationChildAssembleArgs,
  MercadoLivreImportError,
  assembleImportPlan,
  assembleVariationChildPlan,
  resolveVariationCombo,
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
    now: 1_700_000_000_000,
    ...over,
  };
}

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
        up: { itemId: '4455667788', status: null, subStatus: null },
      }),
    );
    expect(plan.link.itemId).toBe('4455667788');
    expect(plan.link.id).toBeNull();
  });

  it('preserves an existing numeric link id on re-import (never recomputed from the itemId)', () => {
    const plan = assembleVariationChildPlan(
      childArgs({
        mappedVariation: mappedVariation({ variationId: 'MLB4455667788' }),
        up: { itemId: 'MLB4455667788', status: null, subStatus: null },
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
        up: { itemId: 'MLB4455667788', status: null, subStatus: null },
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
        up: { itemId: 'MLB4455667788', status: null, subStatus: null },
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
