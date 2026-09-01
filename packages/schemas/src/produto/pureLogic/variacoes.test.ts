import { describe, expect, it } from 'vitest';
import type { GrupoComId, ReconcilableRow } from './variacoes';
import {
  cartesianVariations,
  compareSortKeys,
  findDuplicateSkus,
  grupoOuterRef,
  normalizeVariacoesUid,
  parseFakePath,
  planejarMembroSobrevivente,
  reconcileStagedChildren,
  reconstructFromSkuSuffix,
  reconstructFromVariacoesUid,
  remakeFakePath,
  sameCombo,
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

/**
 * A family never loses its last child (#1398, PR 8).
 *
 * ⚠️ The interesting half is WHICH outcome, not that there is one: `renomear`
 * keeps the doc id — and with it the estoque rows, their ledger, kit entries,
 * marketplace links and pedido lines — while `criar` starts empty. Getting that
 * backwards is a silent stock loss on the most ordinary edit there is.
 */
describe('planejarMembroSobrevivente', () => {
  const linha = (over: Partial<ReconcilableRow> = {}): ReconcilableRow => ({
    id: 'c1',
    sku: 'SKU-1',
    variacoesUid: [],
    deleteMark: false,
    ...over,
  });

  it('does nothing while a child survives', () => {
    expect(planejarMembroSobrevivente([linha(), linha({ id: 'c2', deleteMark: true })])).toEqual({
      tipo: 'nada',
    });
  });

  // The common case after PR 7: every produto has exactly one member row, and
  // deleting it means "no variations", never "throw away this produto's stock".
  it('renames in place when the ONE child being deleted is the only one', () => {
    expect(planejarMembroSobrevivente([linha({ deleteMark: true })])).toEqual({
      tipo: 'renomear',
      id: 'c1',
    });
  });

  // ⚠️ Two children's stock cannot merge into one, and choosing which survives
  // would be arbitrary. Their estoque subtrees are already swept by
  // `onProdutoDeleted` today, so nothing extra is lost.
  it('creates a fresh member when several children are deleted at once', () => {
    expect(
      planejarMembroSobrevivente([
        linha({ deleteMark: true }),
        linha({ id: 'c2', sku: 'SKU-2', deleteMark: true }),
      ]),
    ).toEqual({ tipo: 'criar' });
  });

  // A staged create IS a live child — replacing the whole variation set in one
  // save must not trigger the invariant at all.
  it('does nothing when a staged create replaces every deleted child', () => {
    expect(
      planejarMembroSobrevivente([linha({ deleteMark: true }), linha({ id: null, sku: 'novo' })]),
    ).toEqual({ tipo: 'nada' });
  });

  // ⛔ The hazard this guard exists for. A legacy produto from before #1398 has
  // no children AND holds its own stock; read-tolerance resolves it to itself.
  // Minting an empty member without MOVING the units — a migration's job, with
  // reserved remainders and non-canonical estoque doc ids to handle — would point
  // every stock reader at an empty document and the produto would read 0.
  it('mints NOTHING for a produto that never had a child', () => {
    expect(planejarMembroSobrevivente([])).toEqual({ tipo: 'nada' });
  });

  // ⚠️ A delete row with no doc id was never persisted, so this flush took no
  // child away — and there is no anchor for `renomear` either.
  it('does nothing when the only deleted row was never persisted', () => {
    expect(planejarMembroSobrevivente([linha({ id: null, deleteMark: true })])).toEqual({
      tipo: 'nada',
    });
  });

  // ⚠️ The order dependency, stated as a test: a pair `reconcileStagedChildren`
  // absorbed is no longer a delete, so it must not push the flush into `criar`.
  it('runs on the RECONCILED rows, where an absorbed pair is already gone', () => {
    const bruto = [
      linha({ deleteMark: true }),
      linha({ id: null, sku: 'SKU-1' }), // same SKU: rule 1 absorbs the delete
    ];
    const { rows } = reconcileStagedChildren(bruto);
    expect(planejarMembroSobrevivente(rows)).toEqual({ tipo: 'nada' });
    // ...and the survivor kept the original doc id, which is the whole point.
    expect(rows.map((r) => r.id)).toEqual(['c1']);
  });
});
