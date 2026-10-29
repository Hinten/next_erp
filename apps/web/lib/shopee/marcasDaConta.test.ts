import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import {
  linhaDeMarcaParaGravarShopee,
  marcasDaContaShopee,
  type MarcaDaContaShopee,
  type MarcaDto,
} from '@delfrance/schemas';
import type {
  TransactionDocumentGuard,
  TransactionWrite,
  TransactionWriteContext,
} from '@delfrance/ui';

/**
 * The Marcas section's pure half (#1911, P9): the staged delta and the guarded
 * writes a conta save makes from it — the latter also COMPOSED with the real
 * `saveRecord` over the shared OCC engine, because a guard is only worth what
 * `saveRecord` does with it: a concurrent change must abort the save with
 * NOTHING written (rule 7, tier 3).
 *
 * Fixture ids only: integração `int-1`; legacy auto ids are 20-character
 * strings; new rows sit at `String(brand_id)`.
 */

type Doc = Record<string, unknown>;

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  occ: null as unknown as import('@delfrance/data/testing').OccEngine,
}));

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.lastIndexOf('/') + 1),
    get: async () => ({
      exists: () => h.docs.has(path),
      data: () => structuredClone(h.docs.get(path)),
    }),
  };
}

vi.mock('@/lib/data/marcaShopeeCollection', () => ({
  marcaShopeeCollection: {
    docRef: (_db: unknown, ctx: { integracaoId: string }, id: string) =>
      docRef(`integracao/${ctx.integracaoId}/brandshopee/${id}`),
  },
}));

vi.mock('firebase/firestore', async (importActual) => ({
  ...(await importActual<typeof import('firebase/firestore')>()),
  runTransaction: (_db: unknown, fn: (tx: OccTransaction) => Promise<unknown>) =>
    h.occ.runTransaction(fn),
}));

const {
  CAMPO_MARCAS_SHOPEE,
  adicionarMarcasShopee,
  ajustesDasBaselinesMarcasShopee,
  alteracoesMarcasShopeeSchema,
  caminhoDoRegistroMarcaShopee,
  ocupantesDosRegistrosMarcasShopee,
  recusaDoCadastroMarcaShopee,
  desfazerAdicaoMarcaShopee,
  desfazerRemocaoMarcaShopee,
  escritasMarcasDaContaShopee,
  lerAlteracoesMarcasShopee,
  removerMarcaShopee,
} = await import('./marcasDaConta');
const { MissingTransactionBaselineError, RecordConflictError, saveRecord } =
  await import('@delfrance/ui/src/object/saveRecord');

const db = {} as never;
const INT = 'int-1';
const CONTA_PATH = `integracao/${INT}`;
const caminho = (docId: string) => `integracao/${INT}/brandshopee/${docId}`;

/** Two LEGACY auto-id docs naming brand 7 (one blank), plus their legacy stamps. */
const LEGADO_7A = 'AaaaaaaaaaaaaaaaaaA1';
const LEGADO_7B = 'AaaaaaaaaaaaaaaaaaA2';
const LEGADO_9 = 'BbbbbbbbbbbbbbbbbbB1';
const ROW_7A: Doc = {
  brand_id: 7,
  original_brand_name: 'Nike',
  display_brand_name: null,
  docId: LEGADO_7A,
  createTime: 1_700_000_000_000,
};
const ROW_7B: Doc = { brand_id: 7, original_brand_name: '', display_brand_name: null };
const ROW_9: Doc = { brand_id: 9, original_brand_name: 'Adidas', display_brand_name: null };

/** A `taxonomia/marcas` row to register. */
const NOVA: MarcaDto = {
  brandId: 3001,
  originalBrandName: 'Marca Exemplo',
  displayBrandName: null,
};
/** The row a registration of {@link NOVA} writes. */
const ROW_NOVA: Doc = {
  brand_id: 3001,
  original_brand_name: 'Marca Exemplo',
  display_brand_name: null,
};

/** The brands as THE reader lists them (never hand-built). */
function lidas(docs: Record<string, Doc>): MarcaDaContaShopee[] {
  return [...marcasDaContaShopee(Object.entries(docs).map(([id, data]) => ({ id, data }))).marcas];
}
const marca = (docs: Record<string, Doc>, brandId: number): MarcaDaContaShopee => {
  const m = lidas(docs).find((x) => x.brandId === brandId);
  if (m === undefined) throw new Error(`fixture: marca ${String(brandId)} não lida`);
  return m;
};

/** A save baseline per path — what the section seeds from server truth. */
function contexto(baselines: Record<string, Doc | null>): TransactionWriteContext {
  return {
    getBaseline: (path) => (path in baselines ? baselines[path] : undefined),
  };
}

const valores = (delta: unknown) => ({ [CAMPO_MARCAS_SHOPEE]: delta });

const guardDe = (w: TransactionWrite): TransactionDocumentGuard => {
  if (w.guard === undefined) throw new Error('fixture: escrita sem guard');
  return w.guard;
};

/* -------------------------------------------------------------------------- */

describe('the staged delta — `null` is pristine, anything else is a VALID delta', () => {
  it('`null`, `undefined` and an EMPTY delta all read as nothing staged', () => {
    expect(lerAlteracoesMarcasShopee(null)).toBeNull();
    expect(lerAlteracoesMarcasShopee(undefined)).toBeNull();
    expect(lerAlteracoesMarcasShopee({ adicionar: [], remover: [] })).toBeNull();
  });

  it('a staged delta reads as itself', () => {
    const delta = { adicionar: [NOVA], remover: [{ brandId: 7, docIds: [LEGADO_7A] }] };
    expect(lerAlteracoesMarcasShopee(delta)).toEqual(delta);
  });

  it('NEAR-MISS: two brands with the SAME name at ids 1 and 2 are two adds — identity is the id', () => {
    const nike = (brandId: number): MarcaDto => ({
      brandId,
      originalBrandName: 'Nike',
      displayBrandName: null,
    });
    expect(lerAlteracoesMarcasShopee({ adicionar: [nike(1), nike(2)], remover: [] })).toEqual({
      adicionar: [nike(1), nike(2)],
      remover: [],
    });
  });

  it.each([
    ['a string', 'marcas'],
    ['an add of brand 0 («Sem marca»)', { adicionar: [{ ...NOVA, brandId: 0 }], remover: [] }],
    [
      'an add with a blank name',
      { adicionar: [{ ...NOVA, originalBrandName: '  ' }], remover: [] },
    ],
    [
      'one brand added twice',
      { adicionar: [NOVA, { ...NOVA, originalBrandName: 'X' }], remover: [] },
    ],
    [
      'one brand removed twice',
      {
        adicionar: [],
        remover: [
          { brandId: 7, docIds: [LEGADO_7A] },
          { brandId: 7, docIds: [LEGADO_7B] },
        ],
      },
    ],
    [
      'one doc in two removals',
      {
        adicionar: [],
        remover: [
          { brandId: 7, docIds: [LEGADO_7A] },
          { brandId: 9, docIds: [LEGADO_7A] },
        ],
      },
    ],
    [
      'one brand added AND removed',
      { adicionar: [{ ...NOVA, brandId: 7 }], remover: [{ brandId: 7, docIds: [LEGADO_7A] }] },
    ],
    ['a removal with no doc', { adicionar: [], remover: [{ brandId: 7, docIds: [] }] }],
    ['a removal of brand 0', { adicionar: [], remover: [{ brandId: 0, docIds: ['x'] }] }],
  ])('⭐ %s is REFUSED (ZodError) — never read as "nothing staged"', (_n, valor) => {
    expect(() => lerAlteracoesMarcasShopee(valor)).toThrow(ZodError);
  });
});

describe('the staging grammar — every helper leaves a VALID delta (or `null`)', () => {
  it('stages registrable rows, skipping brand 0, a blank name and one already staged', () => {
    const r = adicionarMarcasShopee(null, [
      NOVA,
      { brandId: 0, originalBrandName: 'No Brand', displayBrandName: null },
      { brandId: 4, originalBrandName: '', displayBrandName: null },
      { ...NOVA, originalBrandName: 'Outro nome' },
    ]);
    expect(r).toEqual({ adicionar: [NOVA], remover: [] });
    expect(alteracoesMarcasShopeeSchema.safeParse(r).success).toBe(true);
  });

  it('nothing registrable to stage ⇒ still `null`', () => {
    expect(
      adicionarMarcasShopee(null, [
        { brandId: 0, originalBrandName: 'No Brand', displayBrandName: null },
      ]),
    ).toBeNull();
  });

  it('adding a brand staged for REMOVAL undoes the removal (it is registered already)', () => {
    const docs = { [LEGADO_7A]: ROW_7A };
    const removida = removerMarcaShopee(null, marca(docs, 7));
    expect(
      adicionarMarcasShopee(removida, [{ ...NOVA, brandId: 7, originalBrandName: 'Nike' }]),
    ).toBeNull();
  });

  it('a removal stages EVERY doc of the brand, the reader’s canonical first', () => {
    const docs = { [LEGADO_7A]: ROW_7A, [LEGADO_7B]: ROW_7B, [LEGADO_9]: ROW_9 };
    expect(removerMarcaShopee(null, marca(docs, 7))).toEqual({
      adicionar: [],
      remover: [{ brandId: 7, docIds: [LEGADO_7A, LEGADO_7B] }],
    });
  });

  it('re-staging a removal REPLACES its entry; a staged add of the same brand is dropped', () => {
    const antes = { adicionar: [{ ...NOVA, brandId: 7 }], remover: [] };
    const docs = { [LEGADO_7A]: ROW_7A, [LEGADO_7B]: ROW_7B };
    const r = removerMarcaShopee(
      removerMarcaShopee(antes, marca({ [LEGADO_7A]: ROW_7A }, 7)),
      marca(docs, 7),
    );
    expect(r).toEqual({ adicionar: [], remover: [{ brandId: 7, docIds: [LEGADO_7A, LEGADO_7B] }] });
  });

  it('undo drops exactly ONE entry, and undoing the last gives `null` back (pristine)', () => {
    const outra: MarcaDto = { brandId: 3002, originalBrandName: 'Outra', displayBrandName: null };
    const delta = {
      adicionar: [NOVA, outra],
      remover: [{ brandId: 7, docIds: [LEGADO_7A] }],
    };
    expect(desfazerAdicaoMarcaShopee(delta, 3001)).toEqual({
      adicionar: [outra],
      remover: delta.remover,
    });
    expect(desfazerRemocaoMarcaShopee(delta, 7)).toEqual({
      adicionar: [NOVA, outra],
      remover: [],
    });
    expect(
      desfazerRemocaoMarcaShopee(
        desfazerAdicaoMarcaShopee(desfazerAdicaoMarcaShopee(delta, 3001), 3002),
        7,
      ),
    ).toBeNull();
  });

  it('NEAR-MISS: undoing a brand that is not staged leaves the delta as it was', () => {
    const delta = { adicionar: [NOVA], remover: [] };
    expect(desfazerAdicaoMarcaShopee(delta, 3002)).toEqual(delta);
    expect(desfazerRemocaoMarcaShopee(delta, 7)).toEqual(delta);
    expect(desfazerAdicaoMarcaShopee(null, 3001)).toBeNull();
  });
});

describe('escritasMarcasDaContaShopee — what a save would write', () => {
  it('nothing staged ⇒ ZERO writes', () => {
    expect(escritasMarcasDaContaShopee(db, INT, valores(null), contexto({}))).toEqual([]);
    expect(escritasMarcasDaContaShopee(db, INT, {}, contexto({}))).toEqual([]);
  });

  it('⭐ a registration is ONE `set` at String(brand_id), the 3-key row, baseline `null`', () => {
    const [w, ...resto] = escritasMarcasDaContaShopee(
      db,
      INT,
      valores({ adicionar: [NOVA], remover: [] }),
      contexto({}),
    );
    expect(resto).toEqual([]);
    expect(w?.type).toBe('set');
    expect(w?.ref.path).toBe(caminho('3001'));
    expect(w?.type === 'set' ? w.data : null).toStrictEqual(ROW_NOVA);
    expect(guardDe(w!).baseline).toBeNull();
    expect(guardDe(w!).formField).toBe(CAMPO_MARCAS_SHOPEE);
    expect(guardDe(w!).label).toBe('Marca «Marca Exemplo» (id 3001)');
  });

  it('NEAR-MISS: `Nike` at ids 1 and 2 are two sets, at two paths', () => {
    const nike = (brandId: number): MarcaDto => ({
      brandId,
      originalBrandName: 'Nike',
      displayBrandName: null,
    });
    const ws = escritasMarcasDaContaShopee(
      db,
      INT,
      valores({ adicionar: [nike(1), nike(2)], remover: [] }),
      contexto({}),
    );
    expect(ws.map((w) => [w.type, w.ref.path])).toEqual([
      ['set', caminho('1')],
      ['set', caminho('2')],
    ]);
  });

  it('⭐ a brand with N docs is N deletes, each guarded by ITS seeded baseline', () => {
    const docs = { [LEGADO_7A]: ROW_7A, [LEGADO_7B]: ROW_7B };
    const ws = escritasMarcasDaContaShopee(
      db,
      INT,
      valores(removerMarcaShopee(null, marca(docs, 7))),
      contexto({ [caminho(LEGADO_7A)]: ROW_7A, [caminho(LEGADO_7B)]: ROW_7B }),
    );
    expect(ws.map((w) => [w.type, w.ref.path, guardDe(w).baseline])).toEqual([
      ['delete', caminho(LEGADO_7A), ROW_7A],
      ['delete', caminho(LEGADO_7B), ROW_7B],
    ]);
    expect(guardDe(ws[1]!).label).toBe(`Marca 7 (registro ${LEGADO_7B})`);
  });

  it('a removal of a doc with no seeded baseline carries `undefined` — the save then refuses', () => {
    const ws = escritasMarcasDaContaShopee(
      db,
      INT,
      valores({ adicionar: [], remover: [{ brandId: 7, docIds: [LEGADO_7A] }] }),
      contexto({}),
    );
    expect(guardDe(ws[0]!).baseline).toBeUndefined();
  });

  it('⭐ a registration over a session baseline of the SAME brand is guarded by it (the override)', () => {
    const outro: Doc = {
      brand_id: 3001,
      original_brand_name: 'Marca Exemplo',
      display_brand_name: 'X',
    };
    const ws = escritasMarcasDaContaShopee(
      db,
      INT,
      valores({ adicionar: [NOVA], remover: [] }),
      contexto({ [caminho('3001')]: outro }),
    );
    expect(guardDe(ws[0]!).baseline).toEqual(outro);
  });

  it.each([
    ['an unreadable doc (a STRING brand_id)', { brand_id: '3001', original_brand_name: 'X' }],
    [
      'another brand’s row',
      { brand_id: 42, original_brand_name: 'Outra', display_brand_name: null },
    ],
    [
      'a «Sem marca» row',
      { brand_id: 0, original_brand_name: 'No Brand', display_brand_name: null },
    ],
    ['a confirmed absence', null],
  ])(
    'NEAR-MISS: a session baseline of %s at that path keeps the registration’s baseline `null`',
    (_n, guardada) => {
      const ws = escritasMarcasDaContaShopee(
        db,
        INT,
        valores({ adicionar: [NOVA], remover: [] }),
        contexto({ [caminho('3001')]: guardada as Doc | null }),
      );
      expect(guardDe(ws[0]!).baseline).toBeNull();
    },
  );

  it('a value that is not a delta THROWS ZodError — the save shows it and writes nothing', () => {
    expect(() =>
      escritasMarcasDaContaShopee(
        db,
        INT,
        valores({ adicionar: [{ ...NOVA, brandId: 0 }], remover: [] }),
        contexto({}),
      ),
    ).toThrow(ZodError);
  });

  it('each guard projects onto the delta by dropping ITS entry — all of them give `null` back', () => {
    const docs = { [LEGADO_7A]: ROW_7A, [LEGADO_7B]: ROW_7B };
    const delta = adicionarMarcasShopee(removerMarcaShopee(null, marca(docs, 7)), [NOVA]);
    const ws = escritasMarcasDaContaShopee(db, INT, valores(delta), contexto({}));
    const [d7a, , set] = ws;

    expect(guardDe(set!).toFormValue(ROW_NOVA, delta)).toEqual({
      adicionar: [],
      remover: [{ brandId: 7, docIds: [LEGADO_7A, LEGADO_7B] }],
    });
    expect(guardDe(d7a!).toFormValue(null, delta)).toEqual({ adicionar: [NOVA], remover: [] });
    const final = ws.reduce<unknown>((v, w) => guardDe(w).toFormValue(null, v), delta);
    expect(final).toBeNull();
  });

  it('NEAR-MISS: one brand’s projection leaves ANOTHER brand’s staged change alone', () => {
    const docs = { [LEGADO_7A]: ROW_7A, [LEGADO_9]: ROW_9 };
    const outra: MarcaDto = { brandId: 3002, originalBrandName: 'Outra', displayBrandName: null };
    const delta = adicionarMarcasShopee(
      removerMarcaShopee(removerMarcaShopee(null, marca(docs, 7)), marca(docs, 9)),
      [NOVA, outra],
    );
    const ws = escritasMarcasDaContaShopee(db, INT, valores(delta), contexto({}));
    const por = (path: string) => guardDe(ws.find((w) => w.ref.path === path)!);

    expect(por(caminho(LEGADO_7A)).toFormValue(null, delta)).toEqual({
      adicionar: [NOVA, outra],
      remover: [{ brandId: 9, docIds: [LEGADO_9] }],
    });
    expect(por(caminho('3001')).toFormValue(ROW_NOVA, delta)).toEqual({
      adicionar: [outra],
      remover: [
        { brandId: 7, docIds: [LEGADO_7A] },
        { brandId: 9, docIds: [LEGADO_9] },
      ],
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('escritasMarcasDaContaShopee × saveRecord — what reaches the store', () => {
  const CONTA: Doc = { tipo: 'shopee', nome: 'Conta 1', ultimaModificacao: 1 };
  const contaCollection = {
    docRef: () => docRef(CONTA_PATH),
    resolvePath: () => 'integracao',
    converter: {},
  } as never;
  const commits = () => h.occ.txLog.filter((e) => e.phase === 'commit').length;

  beforeEach(() => {
    h.docs.clear();
    h.docs.set(CONTA_PATH, structuredClone(CONTA));
    h.docs.set(caminho(LEGADO_7A), structuredClone(ROW_7A));
    h.docs.set(caminho(LEGADO_7B), structuredClone(ROW_7B));
    h.docs.set(caminho(LEGADO_9), structuredClone(ROW_9));
    h.occ = new OccEngine({
      applyWrite: (kind, path, data) => {
        const prev = h.docs.get(path) ?? {};
        h.docs.set(path, kind === 'update' ? { ...prev, ...structuredClone(data) } : data);
      },
      applyDelete: (path) => {
        h.docs.delete(path);
      },
    });
  });

  /** Every doc the section seeded — as it would from the listener's server-truth emission. */
  const semeado = () =>
    contexto({
      [caminho(LEGADO_7A)]: ROW_7A,
      [caminho(LEGADO_7B)]: ROW_7B,
      [caminho(LEGADO_9)]: ROW_9,
    });

  function salvar(delta: unknown, ctx: TransactionWriteContext = semeado()) {
    return saveRecord({
      db,
      collection: contaCollection,
      pathContext: {},
      recordId: INT,
      values: { ...CONTA },
      dirtyFields: {},
      currentUserUid: 'u1',
      baseline: CONTA,
      stampUnit: 'ms',
      createdAtField: false,
      modifiedAtField: 'ultimaModificacao',
      siblingWrites: () => escritasMarcasDaContaShopee(db, INT, valores(delta), ctx),
    });
  }

  const docsIniciais = { [LEGADO_7A]: ROW_7A, [LEGADO_7B]: ROW_7B, [LEGADO_9]: ROW_9 };

  it('⭐ add one + remove the duplicated one: the new doc at String(brand_id), BOTH duplicates gone, the rest untouched', async () => {
    const delta = adicionarMarcasShopee(removerMarcaShopee(null, marca(docsIniciais, 7)), [NOVA]);
    const r = await salvar(delta);

    expect(h.docs.get(caminho('3001'))).toStrictEqual(ROW_NOVA);
    expect(h.docs.has(caminho(LEGADO_7A))).toBe(false);
    expect(h.docs.has(caminho(LEGADO_7B))).toBe(false);
    expect(h.docs.get(caminho(LEGADO_9))).toStrictEqual(ROW_9);
    // A sibling-only save: the conta doc, its stamp included, is not written.
    expect(h.docs.get(CONTA_PATH)).toStrictEqual(CONTA);
    expect(commits()).toBe(1);

    // What ObjectView does with the commit: every committed doc projects onto
    // the delta — and the form is pristine again.
    const depois = r.documents.reduce<unknown>(
      (v, doc) => doc.guard.toFormValue(doc.data, v),
      delta,
    );
    expect(depois).toBeNull();
  });

  it('⭐ (rule 7) another operator registered the SAME brand meanwhile ⇒ conflict, NOTHING written', async () => {
    const deles: Doc = { ...ROW_NOVA, display_brand_name: 'Deles' };
    h.docs.set(caminho('3001'), deles);
    const delta = adicionarMarcasShopee(removerMarcaShopee(null, marca(docsIniciais, 7)), [NOVA]);

    const err = await salvar(delta).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecordConflictError);
    const conflito = (err as InstanceType<typeof RecordConflictError>).documents;
    expect(conflito.map((d) => [d.path, d.fields])).toEqual([[caminho('3001'), ['@exists']]]);
    expect(h.docs.get(caminho('3001'))).toStrictEqual(deles);
    // All or nothing: the removal riding the same save did not happen either.
    expect(h.docs.has(caminho(LEGADO_7A))).toBe(true);
    expect(h.docs.has(caminho(LEGADO_7B))).toBe(true);
    expect(commits()).toBe(0);
  });

  it('…and «Salvar mesmo assim» (the session now holds THEIR row) commits — no loop', async () => {
    const deles: Doc = { ...ROW_NOVA, display_brand_name: 'Deles' };
    h.docs.set(caminho('3001'), deles);
    const delta = adicionarMarcasShopee(null, [NOVA]);
    const aceito = contexto({ [caminho('3001')]: deles });

    await salvar(delta, aceito);

    expect(h.docs.get(caminho('3001'))).toStrictEqual(ROW_NOVA);
  });

  it('⭐ NEAR-MISS: an UNREADABLE doc at that path is never overwritten — not even after «Salvar mesmo assim»', async () => {
    const estranho: Doc = { brand_id: '3001', original_brand_name: 'Quoted' };
    h.docs.set(caminho('3001'), estranho);
    const delta = adicionarMarcasShopee(null, [NOVA]);

    for (const ctx of [semeado(), contexto({ [caminho('3001')]: estranho })]) {
      const err = await salvar(delta, ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RecordConflictError);
    }
    expect(h.docs.get(caminho('3001'))).toStrictEqual(estranho);
    expect(commits()).toBe(0);
  });

  it('⭐ (rule 7) a doc being removed CHANGED meanwhile ⇒ conflict, NOTHING written', async () => {
    const mudado: Doc = { ...ROW_7B, original_brand_name: 'Nike Brasil' };
    h.docs.set(caminho(LEGADO_7B), mudado);
    const delta = removerMarcaShopee(null, marca(docsIniciais, 7));

    const err = await salvar(delta).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecordConflictError);
    const conflito = (err as InstanceType<typeof RecordConflictError>).documents;
    expect(conflito.map((d) => [d.path, d.fields])).toEqual([
      [caminho(LEGADO_7B), ['original_brand_name']],
    ]);
    expect(h.docs.get(caminho(LEGADO_7A))).toStrictEqual(ROW_7A);
    expect(h.docs.get(caminho(LEGADO_7B))).toStrictEqual(mudado);
    // "Recarregar do servidor" projects the conflicted doc: the whole removal
    // of brand 7 leaves the delta, for the operator to decide again.
    expect(conflito[0]?.guard.toFormValue(mudado, delta)).toBeNull();
  });

  it('a doc being removed DELETED meanwhile ⇒ conflict on its existence', async () => {
    h.docs.delete(caminho(LEGADO_7B));
    const err = await salvar(removerMarcaShopee(null, marca(docsIniciais, 7))).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(RecordConflictError);
    expect(
      (err as InstanceType<typeof RecordConflictError>).documents.map((d) => d.fields),
    ).toEqual([['@exists']]);
    expect(h.docs.get(caminho(LEGADO_7A))).toStrictEqual(ROW_7A);
  });

  it('⭐ the safe direction: a RE-ADD of the brand at another id meanwhile survives the removal', async () => {
    const delta = removerMarcaShopee(null, marca(docsIniciais, 7));
    h.docs.set(caminho('7'), {
      brand_id: 7,
      original_brand_name: 'Nike',
      display_brand_name: null,
    });

    await salvar(delta);

    expect(h.docs.has(caminho(LEGADO_7A))).toBe(false);
    expect(h.docs.has(caminho(LEGADO_7B))).toBe(false);
    expect(
      lidas(Object.fromEntries([['7', h.docs.get(caminho('7'))!]])).map((m) => m.brandId),
    ).toEqual([7]);
  });

  it('a removal whose doc was never seeded REFUSES the save — never an unguarded delete', async () => {
    const delta = removerMarcaShopee(null, marca(docsIniciais, 7));
    const err = await salvar(delta, contexto({ [caminho(LEGADO_7A)]: ROW_7A })).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MissingTransactionBaselineError);
    expect(h.docs.has(caminho(LEGADO_7A))).toBe(true);
    expect(h.docs.has(caminho(LEGADO_7B))).toBe(true);
    expect(h.occ.txLog).toEqual([]);
  });
});

describe('ajustesDasBaselinesMarcasShopee — a server snapshot moves a path’s EXISTENCE, never a held row', () => {
  const A = caminho('a0000000000000000001');
  const B = caminho('3003');
  const linhaA: Doc = { brand_id: 1001, original_brand_name: 'Nike', display_brand_name: null };
  const linhaB: Doc = { brand_id: 3003, original_brand_name: 'Puma', display_brand_name: null };

  function ajustes(o: {
    listados?: Record<string, Doc>;
    guardadas?: Record<string, Doc | null>;
    conhecidos?: string[];
    adicionados?: string[];
    removidos?: string[];
  }) {
    const guardadas = o.guardadas ?? {};
    return ajustesDasBaselinesMarcasShopee({
      listados: Object.entries(o.listados ?? {}).map(([path, data]) => ({ path, data })),
      conhecidos: o.conhecidos ?? Object.keys(guardadas),
      guardada: (path) => (path in guardadas ? guardadas[path] : undefined),
      caminhosAdicionados: new Set(o.adicionados ?? []),
      caminhosRemovidos: new Set(o.removidos ?? []),
    });
  }

  it('listed with no baseline ⇒ seeded ⟷ at the path of a STAGED registration ⇒ left unseeded', () => {
    expect(ajustes({ listados: { [A]: linhaA } })).toEqual([
      { path: A, tipo: 'semear', data: linhaA },
    ]);
    expect(ajustes({ listados: { [B]: linhaB }, adicionados: [B] })).toEqual([]);
  });

  it('⭐ listed while held ABSENT ⇒ its row again ⟷ not at the path of a STAGED registration', () => {
    expect(ajustes({ listados: { [A]: linhaA }, guardadas: { [A]: null } })).toEqual([
      { path: A, tipo: 'rebase', data: linhaA },
    ]);
    expect(
      ajustes({ listados: { [B]: linhaB }, guardadas: { [B]: null }, adicionados: [B] }),
    ).toEqual([]);
  });

  it('NEAR-MISS: listed while held as a row moves NOTHING — even when the listed row changed', () => {
    const mudada = { ...linhaA, display_brand_name: 'Nike BR' };
    expect(ajustes({ listados: { [A]: mudada }, guardadas: { [A]: linhaA } })).toEqual([]);
  });

  it('⭐ held as a row and NO LONGER listed ⇒ absent — a staged registration there included (null fails closed)', () => {
    expect(ajustes({ guardadas: { [A]: linhaA } })).toEqual([
      { path: A, tipo: 'rebase', data: null },
    ]);
    expect(ajustes({ guardadas: { [B]: linhaB }, adicionados: [B] })).toEqual([
      { path: B, tipo: 'rebase', data: null },
    ]);
  });

  it('⭐ NEAR-MISS: …but a path a STAGED REMOVAL names keeps its row — its disappearance is that removal’s conflict', () => {
    expect(ajustes({ guardadas: { [A]: linhaA }, removidos: [A] })).toEqual([]);
  });

  it('held absent, or never held, and not listed ⇒ nothing; an unknown path is never touched', () => {
    expect(ajustes({ guardadas: { [A]: null } })).toEqual([]);
    expect(ajustes({ conhecidos: [A] })).toEqual([]);
    expect(ajustes({ guardadas: { [A]: linhaA }, conhecidos: [] })).toEqual([]);
  });

  it('a path known twice is moved once', () => {
    expect(ajustes({ guardadas: { [A]: linhaA }, conhecidos: [A, A] })).toEqual([
      { path: A, tipo: 'rebase', data: null },
    ]);
  });

  it('the seeded row is a COPY — mutating it never reaches the snapshot', () => {
    const listado = { ...linhaA };
    const [ajuste] = ajustes({ listados: { [A]: listado } });
    ajuste!.data!.original_brand_name = 'mexido';
    expect(listado.original_brand_name).toBe('Nike');
  });

  it('the path a baseline is keyed by is the handle’s own ref path — the one the writes guard', () => {
    expect(caminhoDoRegistroMarcaShopee(db, INT, '3003')).toBe(caminho('3003'));
    const [w] = escritasMarcasDaContaShopee(
      db,
      INT,
      valores({ adicionar: [NOVA], remover: [] }),
      contexto({}),
    );
    expect(w!.ref.path).toBe(caminhoDoRegistroMarcaShopee(db, INT, '3001'));
  });
});

describe('recusaDoCadastroMarcaShopee — the shared rule’s verdict, worded, never re-derived', () => {
  const dto = (brandId: number, originalBrandName: string): MarcaDto => ({
    brandId,
    originalBrandName,
    displayBrandName: null,
  });

  it('a bad id ⇒ «id inválido» — before the name: an id refused under ANY name is the id’s fault', () => {
    expect(recusaDoCadastroMarcaShopee(dto(-3, 'Quebrada'))).toBe(
      'id inválido — não pode ser cadastrada',
    );
    expect(recusaDoCadastroMarcaShopee(dto(-3, '   '))).toBe(
      'id inválido — não pode ser cadastrada',
    );
    expect(recusaDoCadastroMarcaShopee(dto(0, ''))).toBe('id inválido — não pode ser cadastrada');
    expect(recusaDoCadastroMarcaShopee(dto(1.5, 'Meia'))).toBe(
      'id inválido — não pode ser cadastrada',
    );
  });

  it('a blank name ⇒ «sem nome» ⟷ NEAR-MISS: an edge-spaced name is registrable (null)', () => {
    expect(recusaDoCadastroMarcaShopee(dto(5, '  '))).toBe(
      'sem nome na Shopee — não pode ser cadastrada',
    );
    expect(recusaDoCadastroMarcaShopee(dto(5, ' Nike '))).toBeNull();
  });

  it('it refuses EXACTLY when linhaDeMarcaParaGravarShopee does', () => {
    const casos = [
      dto(-3, 'X'),
      dto(0, 'No Brand'),
      dto(5, ''),
      dto(5, ' '),
      dto(5, ' Nike '),
      dto(Number.MAX_SAFE_INTEGER, 'Grande'),
      dto(Number.MAX_SAFE_INTEGER + 2, 'Grande demais'),
      dto(7, 'Nike'),
    ];
    for (const c of casos)
      expect(recusaDoCadastroMarcaShopee(c) === null).toBe(
        linhaDeMarcaParaGravarShopee(c) !== null,
      );
  });

  it('the delta refuses such an add with the SAME words, naming the brand', () => {
    const r = alteracoesMarcasShopeeSchema.safeParse({ adicionar: [dto(-3, 'X')], remover: [] });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toEqual([
      'Marca id -3: id inválido — não pode ser cadastrada.',
    ]);
  });
});

describe('ocupantesDosRegistrosMarcasShopee — EVERY doc id, with what holds it', () => {
  it('a brand’s every doc names the brand by the label given; «Sem marca» and unreadable rows by kind', () => {
    const leitura = marcasDaContaShopee([
      { id: LEGADO_7A, data: ROW_7A },
      { id: LEGADO_7B, data: ROW_7B },
      { id: '9', data: ROW_9 },
      { id: 'semMarca00000000000001', data: { brand_id: 0, original_brand_name: 'No Brand' } },
      { id: 'ilegivel0000000000001', data: { brand_id: '9', original_brand_name: 'Texto' } },
    ]);
    const ocupantes = ocupantesDosRegistrosMarcasShopee(leitura, (m) => `R${String(m.brandId)}`);
    expect(Object.fromEntries(ocupantes)).toEqual({
      [LEGADO_7A]: { tipo: 'marca', brandId: 7, rotulo: 'R7' },
      [LEGADO_7B]: { tipo: 'marca', brandId: 7, rotulo: 'R7' },
      '9': { tipo: 'marca', brandId: 9, rotulo: 'R9' },
      semMarca00000000000001: { tipo: 'sem-marca' },
      ilegivel0000000000001: { tipo: 'ilegivel' },
    });
  });
});
