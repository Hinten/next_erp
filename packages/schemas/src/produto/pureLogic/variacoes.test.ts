import { describe, expect, it } from 'vitest';
import type { GrupoComId, ReconcilableRow } from './variacoes';
import {
  cartesianVariations,
  compareSortKeys,
  findDuplicateSkus,
  grupoOuterRef,
  normalizeVariacoesUid,
  parseFakePath,
  reconcileStagedChildren,
  reconstructFromSkuSuffix,
  reconstructFromVariacoesUid,
  remakeFakePath,
  sameCombo,
  skuPaiPorSufixo,
  sortGrupoUids,
  splitFotoSections,
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

describe('skuPaiPorSufixo (#1400 — recover a parent sku from a child)', () => {
  const tamECor = ['P', 'AZ'];

  it('removes the códigos, exactly inverting cartesianVariations', () => {
    // Build a child the real way, then recover the parent from it — the pair
    // that must come out EQUAL.
    const combos = cartesianVariations({
      parentNome: 'Camiseta',
      parentSku: 'CAM',
      grupos: fixtures(),
      selectedUids: [varianteFakePath('TAM', 'p'), varianteFakePath('CORES', 'az')],
    });
    const filho = combos[0]!;
    expect(filho.sku).toBe('CAMPAZ');
    expect(skuPaiPorSufixo(filho.sku, tamECor)).toBe('CAM');
  });

  it('is ORDER-INDEPENDENT — the tie that made the ordem version inert', () => {
    // ⚠️ The regression this function was rewritten for. `planTaxonomia` stamps
    // `ordem: 1` on EVERY grupo it creates, so every multi-grupo taxonomy the ML
    // importer built ties on ordem. A peel that mirrored `sortGruposByOrdem`'s
    // ascending comparator kept the input order on a tie instead of reversing it
    // (both sorts are stable), and refused a perfectly good sku — silently
    // dropping the round-trip rung for exactly the population it serves.
    expect(skuPaiPorSufixo('CAM-AZ-P', ['-AZ', '-P'])).toBe('CAM');
    // Every permutation of the same códigos must give the SAME answer, because
    // order can only decide whether the tail decomposes — never into what.
    expect(skuPaiPorSufixo('CAM-AZ-P', ['-P', '-AZ'])).toBe('CAM');
    expect(skuPaiPorSufixo('CAMPAZ', [...tamECor].reverse())).toBe('CAM');
    // Three grupos, every ordering.
    for (const ordem of [
      ['A', 'B', 'C'],
      ['C', 'B', 'A'],
      ['B', 'C', 'A'],
    ]) {
      expect(skuPaiPorSufixo('CAMABC', ordem)).toBe('CAM');
    }
  });

  it('backtracks instead of matching greedily', () => {
    // A greedy longest-match takes 'PP' off the end of 'CAMPPP' and then cannot
    // place 'P' — but 'P' + 'PP' does decompose it.
    expect(skuPaiPorSufixo('CAMPPP', ['P', 'PP'])).toBe('CAM');
    // Two identical códigos are not ambiguous in the ANSWER, so they resolve.
    expect(skuPaiPorSufixo('CAMPP', ['P', 'P'])).toBe('CAM');
  });

  it('refuses when any variante has no código — the FRESH-IMPORT case', () => {
    // `planTaxonomia` creates variantes with `codigo: null`, so this is what a
    // first-ever ML import looks like. Returning the child's own sku here would
    // give the parent a sku that belongs to one of its children.
    expect(skuPaiPorSufixo('CAMPAZ', [null])).toBeNull();
    expect(skuPaiPorSufixo('CAMPAZ', [undefined])).toBeNull();
    expect(skuPaiPorSufixo('CAMPAZ', [''])).toBeNull();
    // Partially known is still unknown — never remove the half we can.
    expect(skuPaiPorSufixo('CAMPAZ', ['P', null])).toBeNull();
  });

  it('refuses when the tail is not a concatenation of the códigos', () => {
    // ⚠️ The check that stops this becoming "chop N characters off anything".
    // The arithmetic alone would answer 'CAM-A' here.
    expect(skuPaiPorSufixo('CAM-AZUL-P', ['-AZ', '-P'])).toBeNull();
    // Right códigos, but the tail holds something else too.
    expect(skuPaiPorSufixo('CAMPAZX', tamECor)).toBeNull();
    expect(skuPaiPorSufixo('CAMPXAZ', tamECor)).toBeNull();
  });

  it('refuses rather than returning an empty parent', () => {
    expect(skuPaiPorSufixo('PAZ', tamECor)).toBeNull();
    expect(skuPaiPorSufixo('', tamECor)).toBeNull();
    expect(skuPaiPorSufixo(null, tamECor)).toBeNull();
    // No grupos ⇒ nothing was proven, so it must NOT echo the sku back.
    expect(skuPaiPorSufixo('CAMPAZ', [])).toBeNull();
  });

  it('NEAR-MISSES stay distinct — the match does not widen', () => {
    // Byte-exact: case differs, so nothing matches.
    expect(skuPaiPorSufixo('CAMPaz', tamECor)).toBeNull();
    // A LONGER código that merely ends with the real one.
    expect(skuPaiPorSufixo('CAM-01', ['1'])).toBe('CAM-0');
    expect(skuPaiPorSufixo('CAM-1', ['1'])).toBe('CAM-');
    // …so two children one character apart yield two DIFFERENT parents, never one.
    expect(skuPaiPorSufixo('CAM-01', ['1'])).not.toBe(skuPaiPorSufixo('CAM-1', ['1']));
    // Whitespace inside the sku is significant; only the ends are trimmed.
    expect(skuPaiPorSufixo('  CAMPAZ  ', tamECor)).toBe('CAM');
    expect(skuPaiPorSufixo('CAM PAZ', tamECor)).toBe('CAM ');
  });

  it('refuses an absurd number of grupos rather than searching', () => {
    expect(skuPaiPorSufixo(`CAM${'x'.repeat(17)}`, Array<string>(17).fill('x'))).toBeNull();
    // …while the bound itself still works.
    expect(skuPaiPorSufixo(`CAM${'x'.repeat(16)}`, Array<string>(16).fill('x'))).toBe('CAM');
  });
});

describe('grupoOuterRef', () => {
  it('matches the Flutter pathWithDocuments wire shape', () => {
    expect(grupoOuterRef('CORES')).toBe('documents/grupoDeVariacoes/CORES');
  });
});

describe('splitFotoSections', () => {
  const az = varianteFakePath('CORES', 'az');
  const vd = varianteFakePath('CORES', 'vd');
  const p = varianteFakePath('TAM', 'p');

  it('creates one section per selected variant of a permiteFotos group, in variacoesUid order', () => {
    const out = splitFotoSections({
      fotos: [
        { variantePath: null }, // parent-level
        { variantePath: vd },
        { variantePath: az },
      ],
      parentUids: [p, az, vd], // TAM has permiteFotos=false → no section
      grupos: fixtures(),
    });
    expect(out.variants.map((s) => s.uid)).toEqual([az, vd]);
    expect(out.variants[0]).toMatchObject({
      grupoNome: 'Cores',
      varianteNome: 'Azul',
      fotoIndexes: [2],
    });
    expect(out.variants[1]!.fotoIndexes).toEqual([1]);
    expect(out.general).toEqual([0]);
  });

  it('falls orphaned tags back to the general section (unselected variant / unknown group / no permiteFotos)', () => {
    const out = splitFotoSections({
      fotos: [
        { variantePath: vd }, // variant not selected on the parent
        { variantePath: varianteFakePath('ZZZ', 'x') }, // unknown group
        { variantePath: p }, // group without permiteFotos
      ],
      parentUids: [az, p],
      grupos: fixtures(),
    });
    expect(out.variants.map((s) => s.uid)).toEqual([az]);
    expect(out.general).toEqual([0, 1, 2]);
  });

  it('matches legacy non-canonical variantePath forms and dedups repeated uids', () => {
    const out = splitFotoSections({
      fotos: [{ variantePath: 'grupoDeVariacoes/CORES/variacoes/az' }],
      parentUids: [az, 'grupoDeVariacoes/CORES/variacoes/az'],
      grupos: fixtures(),
    });
    expect(out.variants).toHaveLength(1);
    expect(out.variants[0]!.fotoIndexes).toEqual([0]);
    expect(out.general).toEqual([]);
  });
});

describe('findDuplicateSkus', () => {
  it('flags non-empty SKUs shared by two or more live rows', () => {
    const out = findDuplicateSkus([
      { key: 'a', sku: 'CAM-P', deleteMark: false },
      { key: 'b', sku: 'CAM-P', deleteMark: false },
      { key: 'c', sku: 'CAM-M', deleteMark: false },
    ]);
    expect([...out.entries()]).toEqual([['CAM-P', ['a', 'b']]]);
  });

  it('trims before comparing', () => {
    const out = findDuplicateSkus([
      { key: 'a', sku: ' CAM-P', deleteMark: false },
      { key: 'b', sku: 'CAM-P ', deleteMark: false },
    ]);
    expect(out.get('CAM-P')).toEqual(['a', 'b']);
  });

  it('ignores empty SKUs and delete-marked rows', () => {
    const out = findDuplicateSkus([
      { key: 'a', sku: '', deleteMark: false },
      { key: 'b', sku: '  ', deleteMark: false },
      { key: 'c', sku: 'X', deleteMark: true },
      { key: 'd', sku: 'X', deleteMark: false },
    ]);
    expect(out.size).toBe(0);
  });
});

describe('reconcileStagedChildren', () => {
  const az = varianteFakePath('CORES', 'az');
  const vd = varianteFakePath('CORES', 'vd');
  const p = varianteFakePath('TAM', 'p');

  function row(over: Partial<ReconcilableRow> & { key?: string }) {
    return {
      key: over.key ?? 'k',
      id: null,
      sku: '',
      variacoesUid: [],
      deleteMark: false,
      ...over,
    };
  }

  it('pairs a staged-create with a staged-delete by SKU, reusing the doc id', () => {
    const del = row({ key: 'old', id: 'DOC1', sku: 'CAM-P', variacoesUid: [p], deleteMark: true });
    const cre = row({ key: 'new', sku: 'CAM-P', variacoesUid: [p] });
    const out = reconcileStagedChildren([del, cre]);
    expect(out.reusedIds).toEqual(['DOC1']);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ key: 'new', id: 'DOC1', sku: 'CAM-P' });
  });

  it('prefers the same-combo delete when legacy duplicate SKUs match', () => {
    const delA = row({ key: 'dA', id: 'DOC-A', sku: 'X', variacoesUid: [az], deleteMark: true });
    const delB = row({ key: 'dB', id: 'DOC-B', sku: 'X', variacoesUid: [vd], deleteMark: true });
    const cre = row({ key: 'new', sku: 'X', variacoesUid: [vd] });
    const out = reconcileStagedChildren([delA, delB, cre]);
    expect(out.reusedIds).toEqual(['DOC-B']);
    // The non-matching duplicate stays staged for real deletion.
    expect(out.rows.map((r) => r.key)).toEqual(['dA', 'new']);
  });

  it('pairs empty-SKU rows by combo only when both combos are non-empty', () => {
    const del = row({ key: 'old', id: 'DOC1', variacoesUid: [az, p], deleteMark: true });
    const cre = row({ key: 'new', variacoesUid: [p, az] }); // unordered combo match
    const out = reconcileStagedChildren([del, cre]);
    expect(out.rows[0]).toMatchObject({ key: 'new', id: 'DOC1' });

    const blankDel = row({ key: 'bd', id: 'DOC2', deleteMark: true });
    const blankCre = row({ key: 'bc' });
    const blank = reconcileStagedChildren([blankDel, blankCre]);
    expect(blank.reusedIds).toEqual([]);
    expect(blank.rows).toHaveLength(2);
  });

  it('leaves unpaired deletes and creates untouched', () => {
    const del = row({ key: 'old', id: 'DOC1', sku: 'A', variacoesUid: [az], deleteMark: true });
    const cre = row({ key: 'new', sku: 'B', variacoesUid: [vd] });
    const out = reconcileStagedChildren([del, cre]);
    expect(out.reusedIds).toEqual([]);
    expect(out.rows).toEqual([del, cre]);
  });

  it('never pairs two creates or rows that already have ids', () => {
    const persisted = row({ key: 'p1', id: 'DOC1', sku: 'A' }); // live persisted row
    const cre = row({ key: 'new', sku: 'A' });
    const out = reconcileStagedChildren([persisted, cre]);
    expect(out.reusedIds).toEqual([]);
    expect(out.rows).toHaveLength(2);
  });
});

/**
 * Rule 3 — the sole member is absorbed by the first real variation (#1398).
 *
 * A produto born as a family of one owns a child that mirrors it: its stock,
 * its estoque history, the pedido lines and kit entries that name it. When real
 * variations arrive that child stops being a sole member, and leaving it beside
 * them is wrong twice — a phantom row in the tab, and a `filhoUnicoId` still
 * naming it while the family has several members.
 */
describe('reconcileStagedChildren — the sole member (rule 3)', () => {
  const linha = (over: Partial<ReconcilableRow> & { key?: string } = {}) => ({
    id: null as string | null,
    sku: '',
    variacoesUid: [] as string[],
    deleteMark: false,
    ...over,
  });

  it('gives the first staged create the sole member’s id', () => {
    const rows = [
      linha({ id: 'membro', sku: 'BAN-1' }),
      linha({ key: 'novo-P', sku: 'BAN-1P', variacoesUid: ['g/P'] }),
      linha({ key: 'novo-M', sku: 'BAN-1M', variacoesUid: ['g/M'] }),
    ];
    const { rows: out, reusedIds } = reconcileStagedChildren(rows, 'membro');

    // The member row is absorbed; the first create takes its doc id.
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'membro', sku: 'BAN-1P' });
    expect(out[1]).toMatchObject({ id: null, sku: 'BAN-1M' });
    expect(reusedIds).toEqual(['membro']);
  });

  // ⚠️ Rules 1-2 win. The operator who deleted a variation and recreated it
  // means THAT doc; the sole member is only the fallback anchor.
  it('lets an explicit delete/create SKU pair win over the sole member', () => {
    const rows = [
      linha({ id: 'membro', sku: 'BAN-1' }),
      linha({ id: 'antigo', sku: 'BAN-1P', variacoesUid: ['g/P'], deleteMark: true }),
      linha({ key: 'novo-P', sku: 'BAN-1P', variacoesUid: ['g/P'] }),
    ];
    const { rows: out } = reconcileStagedChildren(rows, 'membro');
    // The recreated P keeps the DELETED doc's id, not the member's.
    expect(out.find((r) => r.sku === 'BAN-1P')).toMatchObject({ id: 'antigo' });
    // Nothing claimed the member, so it survives as an ordinary row.
    expect(out.some((r) => r.id === 'membro')).toBe(true);
  });

  it('absorbs at most ONE create', () => {
    const rows = [
      linha({ id: 'membro', sku: 'BAN-1' }),
      linha({ key: 'a', sku: 'A', variacoesUid: ['g/A'] }),
      linha({ key: 'b', sku: 'B', variacoesUid: ['g/B'] }),
      linha({ key: 'c', sku: 'C', variacoesUid: ['g/C'] }),
    ];
    const { reusedIds } = reconcileStagedChildren(rows, 'membro');
    expect(reusedIds).toEqual(['membro']);
  });

  // ⚠️ A child that already carries a combo is a real variation whatever the
  // parent points at — rules 1-2 own it, and absorbing it would rewrite a
  // variation the operator did not touch.
  it('refuses a "sole member" that already has a variacoesUid', () => {
    const rows = [
      linha({ id: 'membro', sku: 'BAN-1', variacoesUid: ['g/X'] }),
      linha({ key: 'novo', sku: 'BAN-1P', variacoesUid: ['g/P'] }),
    ];
    const { rows: out, reusedIds } = reconcileStagedChildren(rows, 'membro');
    expect(reusedIds).toEqual([]);
    expect(out).toHaveLength(2);
  });

  it('does nothing when the operator marked the sole member for deletion', () => {
    const rows = [
      linha({ id: 'membro', sku: 'BAN-1', deleteMark: true }),
      linha({ key: 'novo', sku: 'BAN-1P', variacoesUid: ['g/P'] }),
    ];
    expect(reconcileStagedChildren(rows, 'membro').reusedIds).toEqual([]);
  });

  it('does nothing when there is no staged create', () => {
    const rows = [linha({ id: 'membro', sku: 'BAN-1' })];
    expect(reconcileStagedChildren(rows, 'membro').reusedIds).toEqual([]);
  });

  // ⚠️ Inert without the pointer, which is what makes this safe to ship ahead of
  // the produtos that have one: a produto with real variations passes null and
  // the function behaves exactly as it did before #1398.
  it('is inert when the parent has no sole member', () => {
    const rows = [
      linha({ id: 'c1', sku: 'BAN-1P', variacoesUid: ['g/P'] }),
      linha({ key: 'novo', sku: 'BAN-1M', variacoesUid: ['g/M'] }),
    ];
    expect(reconcileStagedChildren(rows, null).reusedIds).toEqual([]);
    expect(reconcileStagedChildren(rows).reusedIds).toEqual([]);
  });

  it('ignores a pointer naming a produto that is not in the rows', () => {
    const rows = [linha({ key: 'novo', sku: 'BAN-1P', variacoesUid: ['g/P'] })];
    expect(reconcileStagedChildren(rows, 'sumiu').reusedIds).toEqual([]);
  });
});
