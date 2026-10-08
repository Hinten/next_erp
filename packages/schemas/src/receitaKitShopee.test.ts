import { describe, expect, it } from 'vitest';
import { TIPO_AVISO, chaveDeAviso } from './aviso';
import type { ComponentesKit } from './produto/collection/embedded/kit';
import {
  MOTIVO_RESOLUCAO_RECEITA_KIT,
  NOME_TIER_KIT_UNICO,
  OPCAO_TIER_KIT_UNICO,
  SHOPEE_KIT_MAX_MODELOS,
  avisoReceitaKitShopee,
  chaveAvisoReceitaKitShopee,
  chaveReceitaKitErp,
  componentesKitDaReceitaShopee,
  componentesShopeeDoKit,
  decidirAvisoDeReceitaKit,
  escolherPrincipalDoKit,
  linhaVariacaoDeKit,
  mesmaReceitaKitShopee,
  mesmoEnderecoDeComponente,
  modeloDoComponenteKit,
  principalDoKitShopee,
  problemasDeEstruturaDoKit,
  type EnderecoShopeeDoComponente,
  type LinhaComponenteKitShopee,
  type LinhaKitShopeeLida,
  type ResolucaoComponenteKit,
} from './receitaKitShopee';

// Fixture ids only (s19 rules, kit roles D1). Component A (2500139871) HAS
// variations: model 2000458821, and the generic fixture model 2000458802 stands
// for its OTHER model. Component B (2500139872) has NO variations; 2000458829 is
// the hidden default model id Shopee reads back for it (probe #1).
const ITEM_A = 2500139871;
const MODELO_A1 = 2000458821;
const MODELO_A2 = 2000458802;
const ITEM_B = 2500139872;
const MODELO_OCULTO_B = 2000458829;

const A1: EnderecoShopeeDoComponente = { itemId: ITEM_A, modelId: MODELO_A1 };
const A2: EnderecoShopeeDoComponente = { itemId: ITEM_A, modelId: MODELO_A2 };
const B: EnderecoShopeeDoComponente = { itemId: ITEM_B, modelId: null };

/** has_model as `get_item_base_info` answers it: A varies, B is plain. */
const TEM_MODELOS = new Map<number, boolean>([
  [ITEM_A, true],
  [ITEM_B, false],
]);
/** Neither item has a base-info row: has_model UNKNOWN for both. */
const DESCONHECIDO = new Map<number, boolean>();

function ok(endereco: EnderecoShopeeDoComponente): ResolucaoComponenteKit {
  return { ok: true, endereco };
}

function lida(
  itemId: number,
  modelId: number | null,
  quantity: number,
  main = false,
): LinhaKitShopeeLida {
  return {
    component_item_id: itemId,
    component_model_id: modelId,
    quantity,
    main_component: main,
  };
}

function totalDeMains(modelos: readonly (readonly LinhaComponenteKitShopee[])[]): number {
  return modelos.flat().filter((l) => l.main_component === true).length;
}

describe('the constants', () => {
  it('pin the Shopee kit shape and the single-model tier sentinel (L10(1))', () => {
    expect(SHOPEE_KIT_MAX_MODELOS).toBe(9);
    expect(NOME_TIER_KIT_UNICO).toBe('Kit');
    expect(OPCAO_TIER_KIT_UNICO).toBe('Padrão');
  });

  it('MOTIVO_RESOLUCAO_RECEITA_KIT spells exactly the five resolution motivos', () => {
    expect(MOTIVO_RESOLUCAO_RECEITA_KIT).toEqual({
      receitaIgualAShopee: 'receita-igual-a-shopee',
      kitRecriado: 'kit-recriado',
      republicadoIgual: 'republicado-igual',
      importado: 'importado',
      semKitAtivo: 'sem-kit-ativo',
    });
  });
});

describe('modeloDoComponenteKit — the default-model rule', () => {
  it('(M1) has_model false ⇒ null: the plain B hidden id is meaningless', () => {
    expect(modeloDoComponenteKit({ modelId: MODELO_OCULTO_B, itemTemModelos: false })).toBeNull();
  });

  it('(M2) has_model true ⇒ the model id is KEPT (A keeps 2000458821)', () => {
    expect(modeloDoComponenteKit({ modelId: MODELO_A1, itemTemModelos: true })).toBe(MODELO_A1);
  });

  it('(M3) has_model UNKNOWN ⇒ the model id VERBATIM, never a guess', () => {
    expect(modeloDoComponenteKit({ modelId: MODELO_OCULTO_B, itemTemModelos: null })).toBe(
      MODELO_OCULTO_B,
    );
    expect(modeloDoComponenteKit({ modelId: 0, itemTemModelos: null })).toBe(0);
    expect(modeloDoComponenteKit({ modelId: undefined, itemTemModelos: null })).toBeNull();
    expect(modeloDoComponenteKit({ modelId: null, itemTemModelos: null })).toBeNull();
  });

  it('(M4) has_model true + a non-usable id (0, negative, fractional, absent) ⇒ null', () => {
    expect(modeloDoComponenteKit({ modelId: 0, itemTemModelos: true })).toBeNull();
    expect(modeloDoComponenteKit({ modelId: -1, itemTemModelos: true })).toBeNull();
    expect(modeloDoComponenteKit({ modelId: 1.5, itemTemModelos: true })).toBeNull();
    expect(modeloDoComponenteKit({ modelId: undefined, itemTemModelos: true })).toBeNull();
    expect(modeloDoComponenteKit({ modelId: null, itemTemModelos: true })).toBeNull();
  });
});

describe('componentesShopeeDoKit — the ERP → Shopee projection', () => {
  it('(M5) a plain item OMITS component_model_id — never 0, never undefined', () => {
    const p = componentesShopeeDoKit(
      { 'comp-a': { quantidade: 1 }, 'comp-b': { quantidade: 2 } },
      new Map([
        ['comp-a', ok(A1)],
        ['comp-b', ok(B)],
      ]),
    );
    expect(p.linhas).toEqual([
      { component_item_id: ITEM_A, component_model_id: MODELO_A1, quantity: 1 },
      { component_item_id: ITEM_B, quantity: 2 },
    ]);
    const linhaB = p.linhas.find((l) => l.component_item_id === ITEM_B);
    expect(linhaB).toBeDefined();
    expect('component_model_id' in (linhaB ?? {})).toBe(false);
    expect(p.falhas).toEqual([]);
  });

  it('(M6) EVERY miss is reported, sorted by produtoId — an absent key is componente-nao-publicado', () => {
    const p = componentesShopeeDoKit(
      {
        'z-sem-anuncio': { quantidade: 1 },
        'comp-a': { quantidade: 2 },
        'a-sem-anuncio': { quantidade: 1 },
        'm-sem-modelo': { quantidade: 1 },
      },
      new Map<string, ResolucaoComponenteKit>([
        ['comp-a', ok(A1)],
        ['m-sem-modelo', { ok: false, motivo: 'componente-sem-modelo' }],
      ]),
    );
    expect(p.falhas).toEqual([
      { produtoId: 'a-sem-anuncio', motivo: 'componente-nao-publicado' },
      { produtoId: 'm-sem-modelo', motivo: 'componente-sem-modelo' },
      { produtoId: 'z-sem-anuncio', motivo: 'componente-nao-publicado' },
    ]);
    // The resolved one still projects: the caller sees the rows AND every miss.
    expect(p.linhas).toEqual([
      { component_item_id: ITEM_A, component_model_id: MODELO_A1, quantity: 2 },
    ]);
  });

  it('(M7) two ERP keys on ONE Shopee address are SUMMED (wrapper W 2 + member M 3 ⇒ one row of 5)', () => {
    const p = componentesShopeeDoKit(
      { 'wrapper-w': { quantidade: 2 }, 'membro-m': { quantidade: 3 } },
      new Map([
        ['wrapper-w', ok(B)],
        ['membro-m', ok({ itemId: ITEM_B, modelId: null })],
      ]),
    );
    expect(p.linhas).toEqual([{ component_item_id: ITEM_B, quantity: 5 }]);
  });

  it('(M7 near-miss) two DIFFERENT models of one item stay two rows', () => {
    const p = componentesShopeeDoKit(
      { 'comp-a1': { quantidade: 2 }, 'comp-a2': { quantidade: 3 } },
      new Map([
        ['comp-a1', ok(A1)],
        ['comp-a2', ok(A2)],
      ]),
    );
    expect(p.linhas).toEqual([
      { component_item_id: ITEM_A, component_model_id: MODELO_A2, quantity: 3 },
      { component_item_id: ITEM_A, component_model_id: MODELO_A1, quantity: 2 },
    ]);
  });

  it('(M8) a limitarEstoque:false component is SENT and listed in naoLimitam (L3)', () => {
    const p = componentesShopeeDoKit(
      {
        'comp-b': { quantidade: 2, limitarEstoque: false },
        'comp-a': { quantidade: 1, limitarEstoque: true },
        'sem-anuncio': { quantidade: 1, limitarEstoque: false },
      },
      new Map([
        ['comp-a', ok(A1)],
        ['comp-b', ok(B)],
      ]),
    );
    expect(p.linhas).toContainEqual({ component_item_id: ITEM_B, quantity: 2 });
    // Only what is SENT: the unresolved one is a falha, not a non-limiting row.
    expect(p.naoLimitam).toEqual(['comp-b']);
    expect(p.falhas).toEqual([{ produtoId: 'sem-anuncio', motivo: 'componente-nao-publicado' }]);
  });

  it('sorts rows by (itemId, modelId ?? -1) — a plain address before a model of the same item', () => {
    const p = componentesShopeeDoKit(
      {
        x: { quantidade: 1 },
        y: { quantidade: 1 },
        z: { quantidade: 1 },
      },
      new Map([
        ['x', ok(B)],
        ['y', ok(A1)],
        ['z', ok({ itemId: ITEM_A, modelId: null })],
      ]),
    );
    expect(p.linhas.map((l) => [l.component_item_id, l.component_model_id ?? null])).toEqual([
      [ITEM_A, null],
      [ITEM_A, MODELO_A1],
      [ITEM_B, null],
    ]);
  });

  it('a null or empty componentesKit projects nothing', () => {
    expect(componentesShopeeDoKit(null, new Map())).toEqual({
      linhas: [],
      falhas: [],
      naoLimitam: [],
    });
    expect(componentesShopeeDoKit({}, new Map())).toEqual({
      linhas: [],
      falhas: [],
      naoLimitam: [],
    });
  });
});

describe('escolherPrincipalDoKit — ONE main per KIT (P2-a)', () => {
  const modeloComAeB: LinhaComponenteKitShopee[] = [
    { component_item_id: ITEM_A, component_model_id: MODELO_A1, quantity: 1 },
    { component_item_id: ITEM_B, quantity: 1 },
  ];

  it('(M9) a 2-model kit that holds the principal in BOTH models flags exactly ONE row, on model 0', () => {
    const r = escolherPrincipalDoKit([modeloComAeB, modeloComAeB], A1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(totalDeMains(r.modelos)).toBe(1);
    expect(r.modelos[0]?.[0]).toEqual({
      component_item_id: ITEM_A,
      component_model_id: MODELO_A1,
      quantity: 1,
      main_component: true,
    });
    expect(r.modelos[1]?.some((l) => l.main_component === true)).toBe(false);
    expect(r.principal).toEqual(A1);
  });

  it('flags the FIRST model containing it, even when model 0 does not', () => {
    const soB: LinhaComponenteKitShopee[] = [{ component_item_id: ITEM_B, quantity: 2 }];
    const r = escolherPrincipalDoKit([soB, modeloComAeB, modeloComAeB], A1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(totalDeMains(r.modelos)).toBe(1);
    expect(r.modelos[1]?.[0]?.main_component).toBe(true);
  });

  it('(M10) no principal + 2 distinct Shopee items ⇒ principal-obrigatorio, never a silent default', () => {
    expect(escolherPrincipalDoKit([modeloComAeB], null)).toEqual({
      ok: false,
      motivo: 'principal-obrigatorio',
    });
    // Distinct ACROSS models counts too.
    expect(
      escolherPrincipalDoKit(
        [
          [{ component_item_id: ITEM_A, component_model_id: MODELO_A1, quantity: 2 }],
          [{ component_item_id: ITEM_B, quantity: 2 }],
        ],
        null,
      ),
    ).toEqual({ ok: false, motivo: 'principal-obrigatorio' });
  });

  it('no principal + ONE distinct item ⇒ the smallest (itemId, modelId ?? -1) address of model 0', () => {
    const r = escolherPrincipalDoKit(
      [
        [
          { component_item_id: ITEM_A, component_model_id: MODELO_A1, quantity: 1 },
          { component_item_id: ITEM_A, component_model_id: MODELO_A2, quantity: 1 },
        ],
        [{ component_item_id: ITEM_A, component_model_id: MODELO_A2, quantity: 2 }],
      ],
      null,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.principal).toEqual(A2);
    expect(totalDeMains(r.modelos)).toBe(1);
    expect(r.modelos[0]?.[1]?.main_component).toBe(true);
  });

  it('(M11) a principal absent from the recipe ⇒ principal-invalido (another model of the same item too)', () => {
    expect(escolherPrincipalDoKit([modeloComAeB], A2)).toEqual({
      ok: false,
      motivo: 'principal-invalido',
    });
    expect(escolherPrincipalDoKit([modeloComAeB], { itemId: ITEM_A, modelId: null })).toEqual({
      ok: false,
      motivo: 'principal-invalido',
    });
  });

  it('(M11 near-miss) a plain principal present in the recipe is accepted', () => {
    const r = escolherPrincipalDoKit([modeloComAeB], B);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.modelos[0]?.[1]).toEqual({
      component_item_id: ITEM_B,
      quantity: 1,
      main_component: true,
    });
  });

  it('drops any main flag already on the input, so the output carries exactly one', () => {
    const r = escolherPrincipalDoKit(
      [
        [
          {
            component_item_id: ITEM_A,
            component_model_id: MODELO_A1,
            quantity: 1,
            main_component: true,
          },
          { component_item_id: ITEM_B, quantity: 1, main_component: true },
        ],
      ],
      B,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(totalDeMains(r.modelos)).toBe(1);
    expect('main_component' in (r.modelos[0]?.[0] ?? {})).toBe(false);
  });

  it('an empty recipe has no candidate ⇒ principal-invalido', () => {
    expect(escolherPrincipalDoKit([], null)).toEqual({ ok: false, motivo: 'principal-invalido' });
    expect(escolherPrincipalDoKit([[], []], null)).toEqual({
      ok: false,
      motivo: 'principal-invalido',
    });
  });
});

describe('componentesKitDaReceitaShopee — the Shopee → ERP inverse', () => {
  it('(M27) limitarEstoque is FORCED true, whatever the input row carries', () => {
    const linhas = [
      { produtoId: 'comp-a', quantidade: 1, limitarEstoque: false },
      { produtoId: 'comp-b', quantidade: 2, limitarEstoque: false },
    ];
    const r = componentesKitDaReceitaShopee(linhas);
    expect(r.mapa).toEqual({
      'comp-a': { quantidade: 1, limitarEstoque: true },
      'comp-b': { quantidade: 2, limitarEstoque: true },
    });
  });

  it('SUMS two rows of one produto (2 + 3 ⇒ 5) and skips an unresolved row', () => {
    const r = componentesKitDaReceitaShopee([
      { produtoId: 'comp-b', quantidade: 2 },
      { produtoId: null, quantidade: 7 },
      { produtoId: 'comp-b', quantidade: 3 },
    ]);
    expect(r.mapa).toEqual({ 'comp-b': { quantidade: 5, limitarEstoque: true } });
    expect(r.chaves).toEqual(['comp-b']);
  });

  it('chaves follow the map key order, and a `__proto__` id stays an OWN key', () => {
    const r = componentesKitDaReceitaShopee([
      { produtoId: 'comp-b', quantidade: 1 },
      { produtoId: '__proto__', quantidade: 2 },
      { produtoId: 'comp-a', quantidade: 1 },
    ]);
    expect(r.chaves).toEqual(Object.keys(r.mapa));
    expect(r.chaves).toEqual(['comp-b', '__proto__', 'comp-a']);
    expect(Object.getPrototypeOf(r.mapa)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(r.mapa, '__proto__')).toBe(true);
  });
});

describe('mesmaReceitaKitShopee — THE recipe fold (EQUAL pairs and near-misses)', () => {
  const erpAeB: LinhaComponenteKitShopee[] = [
    { component_item_id: ITEM_A, component_model_id: MODELO_A1, quantity: 2 },
    { component_item_id: ITEM_B, quantity: 1 },
  ];

  it('(M12) EQUAL pair: the same quantity; NEAR-MISS: quantity 2 vs 3 is DISTINCT', () => {
    expect(
      mesmaReceitaKitShopee(
        erpAeB,
        [lida(ITEM_A, MODELO_A1, 2), lida(ITEM_B, MODELO_OCULTO_B, 1)],
        TEM_MODELOS,
      ),
    ).toBe(true);
    expect(
      mesmaReceitaKitShopee(
        erpAeB,
        [lida(ITEM_A, MODELO_A1, 3), lida(ITEM_B, MODELO_OCULTO_B, 1)],
        TEM_MODELOS,
      ),
    ).toBe(false);
  });

  it('(M13) EQUAL pair: rows in a different order', () => {
    expect(
      mesmaReceitaKitShopee(
        erpAeB,
        [lida(ITEM_B, MODELO_OCULTO_B, 1), lida(ITEM_A, MODELO_A1, 2)],
        TEM_MODELOS,
      ),
    ).toBe(true);
  });

  it('(M14) EQUAL pair: duplicate keys SUMMED on either side (2 + 3 ≡ 5); NEAR-MISS 2 + 3 vs 6', () => {
    const dobrado: LinhaComponenteKitShopee[] = [
      { component_item_id: ITEM_B, quantity: 2 },
      { component_item_id: ITEM_B, quantity: 3 },
    ];
    expect(mesmaReceitaKitShopee(dobrado, [lida(ITEM_B, MODELO_OCULTO_B, 5)], TEM_MODELOS)).toBe(
      true,
    );
    expect(
      mesmaReceitaKitShopee(
        [{ component_item_id: ITEM_B, quantity: 5 }],
        [lida(ITEM_B, MODELO_OCULTO_B, 2), lida(ITEM_B, MODELO_OCULTO_B, 3)],
        TEM_MODELOS,
      ),
    ).toBe(true);
    expect(mesmaReceitaKitShopee(dobrado, [lida(ITEM_B, MODELO_OCULTO_B, 6)], TEM_MODELOS)).toBe(
      false,
    );
    expect(mesmaReceitaKitShopee(dobrado, [lida(ITEM_B, MODELO_OCULTO_B, 3)], TEM_MODELOS)).toBe(
      false,
    );
  });

  it('(M15) EQUAL pair: a plain item — ERP absent model vs Shopee hidden id when has_model === false', () => {
    expect(
      mesmaReceitaKitShopee(
        [{ component_item_id: ITEM_B, quantity: 1 }],
        [lida(ITEM_B, MODELO_OCULTO_B, 1)],
        TEM_MODELOS,
      ),
    ).toBe(true);
  });

  it('(M15 near-miss) the same pair with has_model UNKNOWN compares the ids literally ⇒ DISTINCT', () => {
    expect(
      mesmaReceitaKitShopee(
        [{ component_item_id: ITEM_B, quantity: 1 }],
        [lida(ITEM_B, MODELO_OCULTO_B, 1)],
        DESCONHECIDO,
      ),
    ).toBe(false);
    // …and literal equality still holds under UNKNOWN.
    expect(
      mesmaReceitaKitShopee(
        [{ component_item_id: ITEM_B, component_model_id: MODELO_OCULTO_B, quantity: 1 }],
        [lida(ITEM_B, MODELO_OCULTO_B, 1)],
        DESCONHECIDO,
      ),
    ).toBe(true);
  });

  it('(M16) has_model === true: a null model vs a model is a resolution hole ⇒ DISTINCT', () => {
    expect(
      mesmaReceitaKitShopee(
        [{ component_item_id: ITEM_A, quantity: 2 }],
        [lida(ITEM_A, MODELO_A1, 2)],
        TEM_MODELOS,
      ),
    ).toBe(false);
  });

  it('NEAR-MISS: model A vs model B of an item that HAS variations ⇒ DISTINCT', () => {
    expect(
      mesmaReceitaKitShopee(
        [{ component_item_id: ITEM_A, component_model_id: MODELO_A1, quantity: 2 }],
        [lida(ITEM_A, MODELO_A2, 2)],
        TEM_MODELOS,
      ),
    ).toBe(false);
  });

  it('(M17) EQUAL pair: main_component moved — the per-model fold ignores the main (R-e)', () => {
    const erpComMainEmA: LinhaComponenteKitShopee[] = [
      {
        component_item_id: ITEM_A,
        component_model_id: MODELO_A1,
        quantity: 2,
        main_component: true,
      },
      { component_item_id: ITEM_B, quantity: 1 },
    ];
    expect(
      mesmaReceitaKitShopee(
        erpComMainEmA,
        [lida(ITEM_A, MODELO_A1, 2, false), lida(ITEM_B, MODELO_OCULTO_B, 1, true)],
        TEM_MODELOS,
      ),
    ).toBe(true);
  });

  it('NEAR-MISS: a component added or removed ⇒ DISTINCT, in both directions', () => {
    const shopee = [lida(ITEM_A, MODELO_A1, 2), lida(ITEM_B, MODELO_OCULTO_B, 1)];
    expect(mesmaReceitaKitShopee(erpAeB.slice(0, 1), shopee, TEM_MODELOS)).toBe(false);
    expect(mesmaReceitaKitShopee(erpAeB, shopee.slice(0, 1), TEM_MODELOS)).toBe(false);
    expect(mesmaReceitaKitShopee([], shopee, TEM_MODELOS)).toBe(false);
    expect(mesmaReceitaKitShopee([], [], TEM_MODELOS)).toBe(true);
  });
});

describe('principalDoKitShopee — the live main, folded', () => {
  it('none flagged ⇒ null', () => {
    expect(principalDoKitShopee([[lida(ITEM_A, MODELO_A1, 1)]], TEM_MODELOS)).toBeNull();
    expect(principalDoKitShopee([], TEM_MODELOS)).toBeNull();
  });

  it('a plain main folds its hidden id away (has_model false); a varied one keeps its model', () => {
    expect(principalDoKitShopee([[lida(ITEM_B, MODELO_OCULTO_B, 2, true)]], TEM_MODELOS)).toEqual(
      B,
    );
    expect(principalDoKitShopee([[lida(ITEM_A, MODELO_A1, 2, true)]], TEM_MODELOS)).toEqual(A1);
    // has_model UNKNOWN keeps the id verbatim, like the fold.
    expect(principalDoKitShopee([[lida(ITEM_B, MODELO_OCULTO_B, 2, true)]], DESCONHECIDO)).toEqual({
      itemId: ITEM_B,
      modelId: MODELO_OCULTO_B,
    });
  });

  it('EQUAL: the same main flagged on several models is ONE main', () => {
    expect(
      principalDoKitShopee(
        [[lida(ITEM_A, MODELO_A1, 1, true)], [lida(ITEM_A, MODELO_A1, 3, true)]],
        TEM_MODELOS,
      ),
    ).toEqual(A1);
  });

  it('NEAR-MISS: two DIFFERENT mains are unreadable ⇒ null, never a pick', () => {
    expect(
      principalDoKitShopee(
        [[lida(ITEM_A, MODELO_A1, 1, true)], [lida(ITEM_A, MODELO_A2, 1, true)]],
        TEM_MODELOS,
      ),
    ).toBeNull();
  });
});

describe('mesmoEnderecoDeComponente — literal, no fold', () => {
  it('EQUAL pair: the same (itemId, modelId); NEAR-MISSES: model, null-vs-model, item', () => {
    expect(mesmoEnderecoDeComponente(A1, { itemId: ITEM_A, modelId: MODELO_A1 })).toBe(true);
    expect(mesmoEnderecoDeComponente(B, { itemId: ITEM_B, modelId: null })).toBe(true);
    expect(mesmoEnderecoDeComponente(A1, A2)).toBe(false);
    expect(mesmoEnderecoDeComponente(B, { itemId: ITEM_B, modelId: MODELO_OCULTO_B })).toBe(false);
    expect(mesmoEnderecoDeComponente(A1, { itemId: ITEM_B, modelId: MODELO_A1 })).toBe(false);
  });
});

describe('chaveReceitaKitErp — the ERP-side fingerprint (L4)', () => {
  it('pins the exact shape: entries sorted by id, [produtoId, quantidade]', () => {
    expect(chaveReceitaKitErp({ 'comp-b': { quantidade: 3 }, 'comp-a': { quantidade: 2 } })).toBe(
      '[["comp-a",2],["comp-b",3]]',
    );
  });

  it('(M18) EQUAL pair: key order, limitarEstoque, timestamp and passthrough extras do not count', () => {
    // Typed as the produto's own `componentesKit`, which is what the trigger passes.
    const antes: ComponentesKit = {
      'comp-a': { quantidade: 2, limitarEstoque: true, timestamp: 1 },
      'comp-b': { quantidade: 3, limitarEstoque: true, timestamp: null },
    };
    const depois: ComponentesKit = {
      'comp-b': { quantidade: 3, limitarEstoque: false, timestamp: 999, extra: 'x' },
      'comp-a': { quantidade: 2, limitarEstoque: false, timestamp: 2 },
    };
    expect(chaveReceitaKitErp(antes)).toBe(chaveReceitaKitErp(depois));
  });

  it('(M19) NEAR-MISS: {p1: 12} vs {p11: 2} stay DISTINCT (no bare join)', () => {
    expect(chaveReceitaKitErp({ p1: { quantidade: 12 } })).not.toBe(
      chaveReceitaKitErp({ p11: { quantidade: 2 } }),
    );
  });

  it('NEAR-MISSES: a quantidade change, a key added, removed or renamed (#1450 repoint)', () => {
    const base = chaveReceitaKitErp({ 'comp-a': { quantidade: 2 }, 'comp-b': { quantidade: 3 } });
    expect(
      chaveReceitaKitErp({ 'comp-a': { quantidade: 2 }, 'comp-b': { quantidade: 4 } }),
    ).not.toBe(base);
    expect(
      chaveReceitaKitErp({
        'comp-a': { quantidade: 2 },
        'comp-b': { quantidade: 3 },
        'comp-c': { quantidade: 1 },
      }),
    ).not.toBe(base);
    expect(chaveReceitaKitErp({ 'comp-a': { quantidade: 2 } })).not.toBe(base);
    expect(
      chaveReceitaKitErp({ 'comp-a': { quantidade: 2 }, 'membro-b': { quantidade: 3 } }),
    ).not.toBe(base);
  });

  it('null, undefined and {} are all "[]"', () => {
    expect(chaveReceitaKitErp(null)).toBe('[]');
    expect(chaveReceitaKitErp(undefined)).toBe('[]');
    expect(chaveReceitaKitErp({})).toBe('[]');
  });

  it('a quantidade that is not a positive safe int reads null (the documented fold), never throws', () => {
    expect(
      chaveReceitaKitErp({
        a: { quantidade: 0 },
        b: { quantidade: 1.5 },
        c: { quantidade: '2' },
        d: {},
        e: null as unknown as { quantidade?: unknown },
      }),
    ).toBe('[["a",null],["b",null],["c",null],["d",null],["e",null]]');
    // …and so '2' (a string) is NOT the number 2.
    expect(chaveReceitaKitErp({ a: { quantidade: '2' } })).not.toBe(
      chaveReceitaKitErp({ a: { quantidade: 2 } }),
    );
  });

  it('sorts by UTF-16 code unit, never by locale ("B" before "a")', () => {
    expect(chaveReceitaKitErp({ a: { quantidade: 1 }, B: { quantidade: 1 } })).toBe(
      '[["B",1],["a",1]]',
    );
  });
});

describe('problemasDeEstruturaDoKit — the local structural bounds', () => {
  const linha = (itemId: number, quantity: number): LinhaComponenteKitShopee => ({
    component_item_id: itemId,
    quantity,
  });
  const modelo = (filhoId: string, ...linhas: LinhaComponenteKitShopee[]) => ({ filhoId, linhas });

  it('no model ⇒ kit-sem-unidade-vendavel', () => {
    expect(problemasDeEstruturaDoKit({ modelos: [], faixaDeComponentes: null })).toEqual([
      { motivo: 'kit-sem-unidade-vendavel', filhoId: null, detalhe: '0 variações' },
    ]);
  });

  it('(M22) 10 children ⇒ kit-variacoes-demais; NEAR-MISS: 9 children are accepted', () => {
    const dez = Array.from({ length: 10 }, (_, i) =>
      modelo(`filho-${String(i)}`, linha(ITEM_A, 1), linha(ITEM_B, 1)),
    );
    expect(problemasDeEstruturaDoKit({ modelos: dez, faixaDeComponentes: null })).toEqual([
      { motivo: 'kit-variacoes-demais', filhoId: null, detalhe: '10 variações; máximo 9' },
    ]);
    expect(
      problemasDeEstruturaDoKit({ modelos: dez.slice(0, 9), faixaDeComponentes: null }),
    ).toEqual([]);
  });

  it('a model with no row ⇒ kit-sem-componentes, and no band line for it', () => {
    expect(
      problemasDeEstruturaDoKit({
        modelos: [modelo('filho-1')],
        faixaDeComponentes: { min: 2, max: 10 },
      }),
    ).toEqual([{ motivo: 'kit-sem-componentes', filhoId: 'filho-1', detalhe: '0 componentes' }]);
  });

  it('(M23) one row of quantity 1 ⇒ kit-componente-unico-quantidade; NEAR-MISSES: qty 2, or two rows', () => {
    expect(
      problemasDeEstruturaDoKit({
        modelos: [modelo('filho-1', linha(ITEM_B, 1))],
        faixaDeComponentes: null,
      }),
    ).toEqual([
      {
        motivo: 'kit-componente-unico-quantidade',
        filhoId: 'filho-1',
        detalhe: '1 componente, quantidade 1',
      },
    ]);
    expect(
      problemasDeEstruturaDoKit({
        modelos: [modelo('filho-1', linha(ITEM_B, 2))],
        faixaDeComponentes: null,
      }),
    ).toEqual([]);
    expect(
      problemasDeEstruturaDoKit({
        modelos: [modelo('filho-1', linha(ITEM_A, 1), linha(ITEM_B, 1))],
        faixaDeComponentes: null,
      }),
    ).toEqual([]);
  });

  it('R-5 and the band read the SUMMED rows: two rows of ONE address 1 + 1 are one row of 2', () => {
    expect(
      problemasDeEstruturaDoKit({
        modelos: [modelo('filho-1', linha(ITEM_B, 1), linha(ITEM_B, 1))],
        faixaDeComponentes: null,
      }),
    ).toEqual([]);
    // Eleven rows of ONE address are ONE row of 11 — under max 10 by rows, so NOT refused.
    expect(
      problemasDeEstruturaDoKit({
        modelos: [modelo('filho-1', ...Array.from({ length: 11 }, () => linha(ITEM_B, 1)))],
        faixaDeComponentes: { min: 2, max: 10 },
      }),
    ).toEqual([]);
  });

  it('(M20) the band MIN is read on Σquantity: 1 row of qty 2 under min 2 is NOT refused', () => {
    expect(
      problemasDeEstruturaDoKit({
        modelos: [modelo('filho-1', linha(ITEM_B, 2))],
        faixaDeComponentes: { min: 2, max: 10 },
      }),
    ).toEqual([]);
  });

  it('(M21) the band MAX is read on rows: 3 rows of qty 4 under max 10 are NOT refused', () => {
    expect(
      problemasDeEstruturaDoKit({
        modelos: [
          modelo('filho-1', linha(ITEM_A, 4), linha(ITEM_B, 4), {
            component_item_id: ITEM_A,
            component_model_id: MODELO_A1,
            quantity: 4,
          }),
        ],
        faixaDeComponentes: { min: 2, max: 10 },
      }),
    ).toEqual([]);
  });

  it('the band refuses when BOTH readings agree: rows > max, or Σquantity < min', () => {
    // Eleven distinct addresses: models 1…11 of A (synthetic ids, never real ones).
    const onze = Array.from(
      { length: 11 },
      (_, i): LinhaComponenteKitShopee => ({
        component_item_id: ITEM_A,
        component_model_id: i + 1,
        quantity: 1,
      }),
    );
    expect(
      problemasDeEstruturaDoKit({
        modelos: [modelo('filho-1', ...onze)],
        faixaDeComponentes: { min: 2, max: 10 },
      }),
    ).toEqual([
      {
        motivo: 'componentes-fora-da-faixa',
        filhoId: 'filho-1',
        detalhe: '11 componentes, soma das quantidades 11; faixa 2–10',
      },
    ]);
    expect(
      problemasDeEstruturaDoKit({
        modelos: [modelo('filho-2', linha(ITEM_A, 1), linha(ITEM_B, 1))],
        faixaDeComponentes: { min: 3, max: 10 },
      }),
    ).toEqual([
      {
        motivo: 'componentes-fora-da-faixa',
        filhoId: 'filho-2',
        detalhe: '2 componentes, soma das quantidades 2; faixa 3–10',
      },
    ]);
    // No band served ⇒ no band refusal at all.
    expect(
      problemasDeEstruturaDoKit({
        modelos: [modelo('filho-1', ...onze)],
        faixaDeComponentes: null,
      }),
    ).toEqual([]);
  });

  it('lists EVERY violation in one pass — kit-level first, then per model in input order', () => {
    const dez = [
      modelo('filho-0', linha(ITEM_B, 1)),
      modelo('filho-1'),
      ...Array.from({ length: 8 }, (_, i) =>
        modelo(`filho-${String(i + 2)}`, linha(ITEM_A, 1), linha(ITEM_B, 1)),
      ),
    ];
    expect(
      problemasDeEstruturaDoKit({ modelos: dez, faixaDeComponentes: null }).map((p) => [
        p.motivo,
        p.filhoId,
      ]),
    ).toEqual([
      ['kit-variacoes-demais', null],
      ['kit-componente-unico-quantidade', 'filho-0'],
      ['kit-sem-componentes', 'filho-1'],
    ]);
  });
});

describe('the L4 aviso — key and plan', () => {
  it('(M26) one key per (conta, K): the conta and K both count; the children never do', () => {
    expect(chaveAvisoReceitaKitShopee('int-1', 'kit-k')).not.toBe(
      chaveAvisoReceitaKitShopee('int-2', 'kit-k'),
    );
    expect(chaveAvisoReceitaKitShopee('int-1', 'kit-k')).not.toBe(
      chaveAvisoReceitaKitShopee('int-1', 'kit-j'),
    );
    expect(chaveAvisoReceitaKitShopee('int-1', 'kit-k')).toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.shopeeKitReceitaDivergente,
        conta: 'int-1',
        entidade: 'kit-k',
      }),
    );
    // Two children of one K land on ONE aviso: the plan's identity ignores them.
    const chaveDoPlano = (variacoes: string[]) => {
      const p = avisoReceitaKitShopee({
        integracaoId: 'int-1',
        kitProdutoId: 'kit-k',
        itemId: 2500139870,
        linkDocId: 'link-k',
        variacoesDivergentes: variacoes,
      });
      return chaveDeAviso({ tipo: p.tipo, conta: p.conta, entidade: p.entidade, janela: p.janela });
    };
    expect(chaveDoPlano(['filho-1'])).toBe(chaveDoPlano(['filho-2']));
    expect(chaveDoPlano(['filho-1'])).toBe(chaveAvisoReceitaKitShopee('int-1', 'kit-k'));
  });

  it('builds the plan: ids only, children sorted + de-duplicated, the produto route', () => {
    expect(
      avisoReceitaKitShopee({
        integracaoId: 'int-1',
        kitProdutoId: 'kit-k',
        itemId: 2500139870,
        linkDocId: 'link-k',
        variacoesDivergentes: ['filho-2', 'filho-1', 'filho-2'],
      }),
    ).toEqual({
      tipo: 'shopeeKitReceitaDivergente',
      severidade: 'atencao',
      canal: 'shopee',
      conta: 'int-1',
      entidade: 'kit-k',
      janela: null,
      params: {
        kit: 'kit-k',
        anuncio: '2500139870',
        vinculo: 'link-k',
        variacoes: 'filho-1, filho-2',
      },
      urlInterna: { rota: '/produtos/kit-k', campo: 'componentesKit' },
    });
  });

  it("an unknown item id or link reads '—' (never 'null', never an empty --link)", () => {
    const p = avisoReceitaKitShopee({
      integracaoId: 'int-1',
      kitProdutoId: 'kit-k',
      itemId: null,
      linkDocId: null,
      variacoesDivergentes: [],
    });
    expect(p.params).toEqual({ kit: 'kit-k', anuncio: '—', vinculo: '—', variacoes: '' });
    expect(
      avisoReceitaKitShopee({
        integracaoId: 'int-1',
        kitProdutoId: 'kit-k',
        itemId: 0,
        linkDocId: '',
        variacoesDivergentes: [],
      }).params,
    ).toEqual({ kit: 'kit-k', anuncio: '—', vinculo: '—', variacoes: '' });
  });
});

describe('decidirAvisoDeReceitaKit — THE open/resolve decision (R-4)', () => {
  const ATUAL = chaveReceitaKitErp({ 'comp-a': { quantidade: 2 } });
  const ANTIGA = chaveReceitaKitErp({ 'comp-a': { quantidade: 1 } });

  it('(M28) one stale row + one equal row ⇒ abrir, in BOTH orders', () => {
    expect(
      decidirAvisoDeReceitaKit([
        { produtoId: 'filho-1', chaveAtual: ATUAL, carimbos: [ANTIGA, ATUAL] },
      ]),
    ).toEqual({ acao: 'abrir', divergentes: ['filho-1'] });
    expect(
      decidirAvisoDeReceitaKit([
        { produtoId: 'filho-1', chaveAtual: ATUAL, carimbos: [ATUAL, ANTIGA] },
      ]),
    ).toEqual({ acao: 'abrir', divergentes: ['filho-1'] });
    // …and across children, in both orders.
    const igual = { produtoId: 'filho-1', chaveAtual: ATUAL, carimbos: [ATUAL] };
    const velho = { produtoId: 'filho-2', chaveAtual: ATUAL, carimbos: [ANTIGA] };
    expect(decidirAvisoDeReceitaKit([igual, velho])).toEqual({
      acao: 'abrir',
      divergentes: ['filho-2'],
    });
    expect(decidirAvisoDeReceitaKit([velho, igual])).toEqual({
      acao: 'abrir',
      divergentes: ['filho-2'],
    });
  });

  it('(M29) a null stamp is NEVER equal ⇒ abrir', () => {
    expect(
      decidirAvisoDeReceitaKit([{ produtoId: 'filho-1', chaveAtual: ATUAL, carimbos: [null] }]),
    ).toEqual({ acao: 'abrir', divergentes: ['filho-1'] });
  });

  it('every row equal ⇒ resolver; no row at all ⇒ nada', () => {
    expect(
      decidirAvisoDeReceitaKit([
        { produtoId: 'filho-1', chaveAtual: ATUAL, carimbos: [ATUAL, ATUAL] },
        { produtoId: 'filho-2', chaveAtual: ANTIGA, carimbos: [ANTIGA] },
      ]),
    ).toEqual({ acao: 'resolver' });
    expect(decidirAvisoDeReceitaKit([])).toEqual({ acao: 'nada' });
    expect(
      decidirAvisoDeReceitaKit([{ produtoId: 'filho-1', chaveAtual: ATUAL, carimbos: [] }]),
    ).toEqual({ acao: 'nada' });
  });

  it('names only the divergent children, sorted', () => {
    expect(
      decidirAvisoDeReceitaKit([
        { produtoId: 'filho-3', chaveAtual: ATUAL, carimbos: [null] },
        { produtoId: 'filho-2', chaveAtual: ATUAL, carimbos: [ATUAL] },
        { produtoId: 'filho-1', chaveAtual: ATUAL, carimbos: [ANTIGA, ANTIGA] },
      ]),
    ).toEqual({ acao: 'abrir', divergentes: ['filho-1', 'filho-3'] });
  });
});

describe('linhaVariacaoDeKit — the kit-model variashopee row', () => {
  it('builds exactly the six fields, copying tier_index', () => {
    const tier = [0];
    const linha = linhaVariacaoDeKit({
      contaRef: 'integracao/int-1',
      linkPath: 'produtos/kit-k/prodshopee/link-k',
      modelId: 2000458820,
      tierIndex: tier,
      modelStatus: 'MODEL_NORMAL',
      receitaKitConferida: '[["comp-a",2]]',
    });
    expect(linha).toEqual({
      contaVariacaoShopeeOuterRef: 'integracao/int-1',
      produtoShopeeOuterRef: 'produtos/kit-k/prodshopee/link-k',
      model_id: 2000458820,
      tier_index: [0],
      model_status: 'MODEL_NORMAL',
      receitaKitConferida: '[["comp-a",2]]',
    });
    tier.push(1);
    expect(linha.tier_index).toEqual([0]);
  });
});

describe('ROUND TRIP — projection → main → a read-back → fold, and back to the ERP map', () => {
  it('a 2-component recipe survives create → read-back → import modulo the documented folds', () => {
    const erp = {
      'comp-a': { quantidade: 2, limitarEstoque: true, timestamp: 1 },
      'comp-b': { quantidade: 3, limitarEstoque: false, timestamp: null },
    };
    const resolucao = new Map([
      ['comp-a', ok(A1)],
      ['comp-b', ok(B)],
    ]);
    const projecao = componentesShopeeDoKit(erp, resolucao);
    const principal = escolherPrincipalDoKit([projecao.linhas], A1);
    expect(principal.ok).toBe(true);
    if (!principal.ok) return;

    // Shopee's read-back: B carries its HIDDEN model id, A the main flag.
    const lidas = [lida(ITEM_B, MODELO_OCULTO_B, 3), lida(ITEM_A, MODELO_A1, 2, true)];
    expect(mesmaReceitaKitShopee(principal.modelos[0] ?? [], lidas, TEM_MODELOS)).toBe(true);
    const principalLido = principalDoKitShopee([lidas], TEM_MODELOS);
    expect(principalLido).not.toBeNull();
    if (principalLido === null) return;
    expect(mesmoEnderecoDeComponente(principalLido, principal.principal)).toBe(true);

    // The import: each read row → its ERP produto (the hidden id folded by has_model).
    const produtoPorEndereco = (l: LinhaKitShopeeLida): string | null => {
      const modelId = modeloDoComponenteKit({
        modelId: l.component_model_id,
        itemTemModelos: TEM_MODELOS.get(l.component_item_id) ?? null,
      });
      const endereco = { itemId: l.component_item_id, modelId };
      if (mesmoEnderecoDeComponente(endereco, A1)) return 'comp-a';
      if (mesmoEnderecoDeComponente(endereco, B)) return 'comp-b';
      return null;
    };
    const volta = componentesKitDaReceitaShopee(
      lidas.map((l) => ({ produtoId: produtoPorEndereco(l), quantidade: l.quantity })),
    );
    // limitarEstoque is forced true and timestamps are dropped — outside the fingerprint.
    expect(chaveReceitaKitErp(volta.mapa)).toBe(chaveReceitaKitErp(erp));
    expect(volta.mapa['comp-b']).toEqual({ quantidade: 3, limitarEstoque: true });
  });
});
