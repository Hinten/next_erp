import { describe, expect, it } from 'vitest';
import type { GrupoComId } from './variacoes';
import {
  cartesianVariations,
  compareSortKeys,
  normalizeVariacoesUid,
  parseFakePath,
  reconstructFromSkuSuffix,
  reconstructFromVariacoesUid,
  remakeFakePath,
  sameCombo,
  sortGrupoUids,
  varianteFakePath,
} from './variacoes';

/** Tamanhos (ordem 1): P/M/G — Cores (ordem 2): Azul/Verde. */
function fixtures(): GrupoComId[] {
  return [
    {
      id: 'CORES',
      data: {
        nome: 'Cores',
        ordem: 2,
        permiteFotos: true,
        variacoesIds: ['az', 'vd'],
        variacoes: [
          { id: 'az', nome: 'Azul', codigo: 'AZ' },
          { id: 'vd', nome: 'Verde', codigo: 'VD' },
        ],
      },
    },
    {
      id: 'TAM',
      data: {
        nome: 'Tamanhos',
        ordem: 1,
        permiteFotos: false,
        variacoesIds: ['p', 'm', 'g'],
        variacoes: [
          { id: 'p', nome: 'P', codigo: 'P' },
          { id: 'm', nome: 'M', codigo: 'M' },
          { id: 'g', nome: 'G', codigo: 'G' },
        ],
      },
    },
  ];
}

describe('fake paths', () => {
  it('builds the canonical Flutter form', () => {
    expect(varianteFakePath('TAM', 'p')).toBe('documents/grupoDeVariacoes/TAM/variacoes/p');
  });

  it('parses canonical, bare and leading-slash forms', () => {
    expect(parseFakePath('documents/grupoDeVariacoes/TAM/variacoes/p')).toEqual({
      grupoId: 'TAM',
      varianteId: 'p',
    });
    expect(parseFakePath('grupoDeVariacoes/TAM/variacoes/p')).toEqual({
      grupoId: 'TAM',
      varianteId: 'p',
    });
    expect(parseFakePath('/documents/grupoDeVariacoes/TAM/variacoes/p')).toEqual({
      grupoId: 'TAM',
      varianteId: 'p',
    });
    expect(parseFakePath('apenas-um-id')).toBeNull();
  });

  it('remakes any tolerated form into the canonical one', () => {
    expect(remakeFakePath('grupoDeVariacoes/TAM/variacoes/p')).toBe(
      'documents/grupoDeVariacoes/TAM/variacoes/p',
    );
  });
});

describe('sortGrupoUids', () => {
  it('bares, dedups and sorts by grupo.ordem', () => {
    expect(sortGrupoUids(['CORES', 'grupoDeVariacoes/TAM', 'CORES'], fixtures())).toEqual([
      'TAM',
      'CORES',
    ]);
  });

  it('keeps unknown ids at the end', () => {
    expect(sortGrupoUids(['ZZZ', 'CORES'], fixtures())).toEqual(['CORES', 'ZZZ']);
  });
});

describe('normalizeVariacoesUid', () => {
  it('remakes, dedups and sorts group-major by variant index', () => {
    const out = normalizeVariacoesUid(
      [
        'grupoDeVariacoes/CORES/variacoes/az', // legacy form, group 2
        varianteFakePath('TAM', 'm'),
        varianteFakePath('CORES', 'az'), // duplicate after remake
      ],
      fixtures(),
    );
    expect(out).toEqual([varianteFakePath('TAM', 'm'), varianteFakePath('CORES', 'az')]);
  });

  it('appends leftovers from unknown groups in original order', () => {
    const stray = 'documents/grupoDeVariacoes/ZZZ/variacoes/x';
    const out = normalizeVariacoesUid([stray, varianteFakePath('TAM', 'p')], fixtures());
    expect(out).toEqual([varianteFakePath('TAM', 'p'), stray]);
  });
});

describe('cartesianVariations', () => {
  it('generates the full Cartesian product in group-major order', () => {
    const combos = cartesianVariations({
      parentNome: 'Camiseta',
      parentSku: 'CAM',
      grupos: fixtures(),
      selectedUids: [
        varianteFakePath('TAM', 'p'),
        varianteFakePath('TAM', 'm'),
        varianteFakePath('CORES', 'az'),
        varianteFakePath('CORES', 'vd'),
      ],
    });
    expect(combos.map((c) => c.sku)).toEqual(['CAMPAZ', 'CAMPVD', 'CAMMAZ', 'CAMMVD']);
    expect(combos[0]).toMatchObject({
      nome: 'Camiseta P Azul',
      variacoesUid: [varianteFakePath('TAM', 'p'), varianteFakePath('CORES', 'az')],
      sortKey: [0, 0],
    });
  });

  it('skips a selected group with no selected variants (old app collapsed to zero)', () => {
    const combos = cartesianVariations({
      parentNome: 'Camiseta',
      parentSku: 'CAM',
      grupos: fixtures(),
      selectedUids: [varianteFakePath('TAM', 'g')],
    });
    expect(combos.map((c) => c.nome)).toEqual(['Camiseta G']);
  });

  it('keeps the sku empty when the parent has none and returns [] with no selection', () => {
    const semSku = cartesianVariations({
      parentNome: 'Camiseta',
      parentSku: null,
      grupos: fixtures(),
      selectedUids: [varianteFakePath('TAM', 'p')],
    });
    expect(semSku[0]!.sku).toBe('');
    expect(
      cartesianVariations({
        parentNome: 'Camiseta',
        parentSku: 'CAM',
        grupos: fixtures(),
        selectedUids: [],
      }),
    ).toEqual([]);
  });
});

describe('sameCombo', () => {
  it('compares unordered and across legacy forms', () => {
    expect(
      sameCombo(
        [varianteFakePath('CORES', 'az'), varianteFakePath('TAM', 'p')],
        ['grupoDeVariacoes/TAM/variacoes/p', varianteFakePath('CORES', 'az')],
      ),
    ).toBe(true);
    expect(sameCombo([varianteFakePath('TAM', 'p')], [varianteFakePath('TAM', 'm')])).toBe(false);
  });
});

describe('reconstructFromVariacoesUid (mode A)', () => {
  it('recomputes nome/sku/sortKey in group order', () => {
    const out = reconstructFromVariacoesUid({
      childUids: [varianteFakePath('CORES', 'vd'), varianteFakePath('TAM', 'g')],
      parentNome: 'Camiseta',
      parentSku: 'CAM',
      grupos: fixtures(),
    });
    expect(out).toEqual({
      ok: true,
      nome: 'Camiseta G Verde',
      sku: 'CAMGVD',
      variacoesUid: [varianteFakePath('TAM', 'g'), varianteFakePath('CORES', 'vd')],
      sortKey: [2, 1],
    });
  });

  it('errors on an unknown variant or empty uids', () => {
    expect(
      reconstructFromVariacoesUid({
        childUids: [varianteFakePath('TAM', 'zzz')],
        parentNome: 'Camiseta',
        parentSku: 'CAM',
        grupos: fixtures(),
      }).ok,
    ).toBe(false);
    expect(
      reconstructFromVariacoesUid({
        childUids: [],
        parentNome: 'Camiseta',
        parentSku: 'CAM',
        grupos: fixtures(),
      }).ok,
    ).toBe(false);
  });
});

describe('reconstructFromSkuSuffix (mode B — legacy children)', () => {
  it('peels variant códigos off the sku suffix in reverse group order', () => {
    const out = reconstructFromSkuSuffix({
      childSku: 'CAMMVD',
      parentNome: 'Camiseta',
      parentSku: 'CAM',
      grupos: fixtures(),
    });
    expect(out).toEqual({
      ok: true,
      nome: 'Camiseta M Verde',
      sku: 'CAMMVD',
      variacoesUid: [varianteFakePath('TAM', 'm'), varianteFakePath('CORES', 'vd')],
      sortKey: [1, 1],
    });
  });

  it('errors when a group has no matching código or the sku does not extend the parent', () => {
    expect(
      reconstructFromSkuSuffix({
        childSku: 'CAMXX',
        parentNome: 'Camiseta',
        parentSku: 'CAM',
        grupos: fixtures(),
      }).ok,
    ).toBe(false);
    expect(
      reconstructFromSkuSuffix({
        childSku: 'OUTROPVD',
        parentNome: 'Camiseta',
        parentSku: 'CAM',
        grupos: fixtures(),
      }).ok,
    ).toBe(false);
  });

  it('orders recovered children lexicographically by sortKey (the padRight bug fix)', () => {
    const a = reconstructFromSkuSuffix({
      childSku: 'CAMPVD',
      parentNome: 'C',
      parentSku: 'CAM',
      grupos: fixtures(),
    });
    const b = reconstructFromSkuSuffix({
      childSku: 'CAMMAZ',
      parentNome: 'C',
      parentSku: 'CAM',
      grupos: fixtures(),
    });
    if (!a.ok || !b.ok) throw new Error('expected ok');
    // P+Verde [0,1] sorts before M+Azul [1,0].
    expect(compareSortKeys(a.sortKey, b.sortKey)).toBeLessThan(0);
  });
});
