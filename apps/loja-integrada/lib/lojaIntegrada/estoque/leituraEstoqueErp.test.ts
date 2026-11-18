/**
 * `leituraEstoqueErp.ts` (master plan step 12, PR 12-e): every ERP read of a stock send run,
 * against `testing/fakeDb.ts` — which query shape each read sends (checked against
 * `firestore.indexes.json`, Enterprise full-scans an undeclared one), when a hint is trusted, and
 * that both stored ref forms are found.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import {
  CAMPOS_INDICE_COMPONENTES_LI,
  CAMPOS_INDICE_ESTOQUE_PROPRIO_LI,
  CAMPOS_INDICE_VINCULO_LI,
  CAMPOS_PRODUTO_ESTOQUE_LI,
  GRUPO_ESTOQUE_LI,
  GRUPO_VINCULO_LI,
  LIMITE_ESTOQUE_PROPRIO_LI,
  LIMITE_VINCULOS_LI,
  MAX_IDS_POR_CONSULTA_VINCULO_LI,
  MAX_VALORES_IN_ESTOQUE_LI,
  componentesQueLimitamLi,
  consultaVinculosDaContaPorIdsLi,
  depositoDaContaLi,
  formasDoDepositoLi,
  lerComponentesNoDepositoLi,
  lerEstoqueProprioLi,
  MAX_PRODUTOS_POR_LEITURA_ESTOQUE_LI,
  lerProdutoEstoqueLi,
  lerProdutosEstoqueLi,
  lerRegistrosNoDepositoLi,
  lerVinculosDoProdutoLi,
  quantidadesQueLimitamLi,
  sondarVinculoDuplicadoLi,
  temEstoqueEmQualquerDepositoLi,
} from './leituraEstoqueErp';
import { estoqueNoDepositoLi } from './planoEstoqueLi';

const CONTA = 'conta-li-est';
const DEP = 'dep-1';
const CANONICA = `documents/depositos/${DEP}`;
const NUA = `depositos/${DEP}`;
const OUTRO_DEP = 'documents/depositos/dep-2';

interface Indice {
  readonly collectionGroup: string;
  readonly queryScope: string;
  readonly fields: readonly { readonly fieldPath: string }[];
}

function indices(): readonly Indice[] {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) dir = dirname(dir);
  return (
    JSON.parse(readFileSync(resolve(dir, 'firestore.indexes.json'), 'utf8')) as {
      indexes: Indice[];
    }
  ).indexes;
}

/** The declared indexes of one group and scope whose fields are EXACTLY `campos`, in order. */
function declarados(grupo: string, escopo: string, campos: readonly string[]): Indice[] {
  return indices().filter(
    (i) =>
      i.collectionGroup === grupo &&
      i.queryScope === escopo &&
      JSON.stringify(i.fields.map((f) => f.fieldPath)) === JSON.stringify([...campos]),
  );
}

function seedEstoque(db: FakeDb, produtoId: string, id: string, campos: DocData): void {
  db.seed(`produtos/${produtoId}/estoques/${id}`, campos);
}

const kit = (
  componentes: Record<string, number | { quantidade: number; limitarEstoque: boolean }>,
) => ({
  ehKit: true,
  componentesKit: Object.fromEntries(
    Object.entries(componentes).map(([id, q]) => [
      id,
      typeof q === 'number'
        ? { quantidade: q, limitarEstoque: true, timestamp: null }
        : { ...q, timestamp: null },
    ]),
  ),
});

describe('the indexes the run’s queries ride are declared (Enterprise full-scans without one)', () => {
  it('own record: a COLLECTION estoques index on exactly its fields; the query uses its first, `in` over both forms, limit 3', async () => {
    expect(
      declarados(GRUPO_ESTOQUE_LI, 'COLLECTION', CAMPOS_INDICE_ESTOQUE_PROPRIO_LI),
    ).toHaveLength(1);
    const db = new FakeDb();
    await lerEstoqueProprioLi(asDb(db), 'p1', DEP, null);
    expect(db.consultas).toEqual([
      {
        colecao: `produtos/p1/${GRUPO_ESTOQUE_LI}`,
        filtros: [[CAMPOS_INDICE_ESTOQUE_PROPRIO_LI[0], 'in', [CANONICA, NUA]]],
        ordens: [],
        limite: LIMITE_ESTOQUE_PROPRIO_LI,
        apos: null,
      },
    ]);
    expect(LIMITE_ESTOQUE_PROPRIO_LI).toBe(3);
  });

  it('components: a COLLECTION_GROUP estoques index on exactly its fields; the join uses its first two, once per form', async () => {
    expect(
      declarados(GRUPO_ESTOQUE_LI, 'COLLECTION_GROUP', CAMPOS_INDICE_COMPONENTES_LI),
    ).toHaveLength(1);
    const db = new FakeDb();
    await lerComponentesNoDepositoLi(asDb(db), kit({ c1: 1, c2: 2 }), DEP, null);
    const grupo = db.consultas.filter((c) => c.grupo === true);
    expect(grupo).toEqual(
      [CANONICA, NUA].map((forma) => ({
        colecao: GRUPO_ESTOQUE_LI,
        grupo: true,
        filtros: [
          [CAMPOS_INDICE_COMPONENTES_LI[0], 'in', ['c1', 'c2']],
          [CAMPOS_INDICE_COMPONENTES_LI[1], '==', forma],
        ],
        ordens: [],
        limite: null,
        apos: null,
      })),
    );
  });

  it('duplicate probe: the COLLECTION_GROUP produtolojaintegrada index; `==` per conta form, `id in [number, text]`', async () => {
    expect(declarados(GRUPO_VINCULO_LI, 'COLLECTION_GROUP', CAMPOS_INDICE_VINCULO_LI)).toHaveLength(
      1,
    );
    const db = new FakeDb();
    await sondarVinculoDuplicadoLi(asDb(db), CONTA, '7001', 'p1');
    expect(db.consultas).toEqual(
      [`documents/integracao/${CONTA}`, `integracao/${CONTA}`].map((forma) => ({
        colecao: GRUPO_VINCULO_LI,
        grupo: true,
        filtros: [
          [CAMPOS_INDICE_VINCULO_LI[0], '==', forma],
          [CAMPOS_INDICE_VINCULO_LI[1], 'in', [7001, '7001']],
        ],
        ordens: [],
        limite: LIMITE_VINCULOS_LI,
        apos: null,
      })),
    );
  });

  it('the ONE builder the probe and the reconcile lookup share: up to 15 ids, each as its number AND its text (30 values, the `in` cap); 0 or 16 ids refused', async () => {
    expect(MAX_IDS_POR_CONSULTA_VINCULO_LI * 2).toBe(MAX_VALORES_IN_ESTOQUE_LI);
    const db = new FakeDb();
    const ids = Array.from({ length: MAX_IDS_POR_CONSULTA_VINCULO_LI }, (_, n) => String(10 + n));
    await consultaVinculosDaContaPorIdsLi(asDb(db), `integracao/${CONTA}`, ids).get();
    expect(db.consultas).toEqual([
      {
        colecao: GRUPO_VINCULO_LI,
        grupo: true,
        filtros: [
          [CAMPOS_INDICE_VINCULO_LI[0], '==', `integracao/${CONTA}`],
          [CAMPOS_INDICE_VINCULO_LI[1], 'in', ids.flatMap((id) => [Number(id), id])],
        ],
        ordens: [],
        limite: null,
        apos: null,
      },
    ]);
    expect(() => consultaVinculosDaContaPorIdsLi(asDb(db), 'x', [])).toThrow(RangeError);
    expect(() => consultaVinculosDaContaPorIdsLi(asDb(db), 'x', [...ids, '99'])).toThrow(
      RangeError,
    );
  });
});

describe('the depósito', () => {
  it('both stored forms, canonical first', () => {
    expect(formasDoDepositoLi(DEP)).toEqual([CANONICA, NUA]);
  });

  it('the conta’s depósito: either stored form ⇒ the bare id', () => {
    expect(depositoDaContaLi({ depositoOuterRef: CANONICA })).toBe(DEP);
    expect(depositoDaContaLi({ depositoOuterRef: NUA })).toBe(DEP);
  });

  it.each([
    ['absent', {}],
    ['null', { depositoOuterRef: null }],
    ['another collection', { depositoOuterRef: 'documents/filiais/dep-1' }],
    ['a nested path', { depositoOuterRef: 'documents/depositos/dep-1/x/y' }],
    ['a bare id', { depositoOuterRef: 'dep-1' }],
    ['a number', { depositoOuterRef: 7 }],
  ])('⚠️ NEAR-MISS: %s names no depósito', (_rotulo, conta) => {
    expect(depositoDaContaLi(conta)).toBeNull();
  });
});

describe('the produto and its links', () => {
  it('the produto is ONE masked read: only the quantity’s four fields come back', async () => {
    const db = new FakeDb();
    db.seed('produtos/p1', {
      ehKit: false,
      nome: 'fora da máscara',
      paiId: 'pai',
      componentesKitKeys: ['x'],
      statusProdutosMarketplace: { a: 1 },
    });
    // The MASK itself is pinned on the call: the reader projects the same four fields in code,
    // so its result alone would read the same with an unmasked (dearer) read.
    const getAll = vi.spyOn(db, 'getAll');
    const produto = await lerProdutoEstoqueLi(asDb(db), 'p1');
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll.mock.calls[0]?.at(-1)).toEqual({ fieldMask: [...CAMPOS_PRODUTO_ESTOQUE_LI] });
    expect(produto).toEqual({
      ehKit: false,
      ehKitVirtual: undefined,
      componentesKit: null,
      statusProdutosMarketplace: { a: 1 },
    });
    expect(db.leituras).toEqual(['produtos/p1']);
    expect(CAMPOS_PRODUTO_ESTOQUE_LI).toEqual([
      'ehKit',
      'ehKitVirtual',
      'componentesKit',
      'statusProdutosMarketplace',
    ]);
  });

  it('a produto that does not exist ⇒ null', async () => {
    expect(await lerProdutoEstoqueLi(asDb(new FakeDb()), 'p1')).toBeNull();
  });

  it('its own links, every conta’s, raw, from ONE where-less listing', async () => {
    const db = new FakeDb();
    db.seed('produtos/p1/produtolojaintegrada/a', { id: 1, contaLojaIntegrada: 'x' });
    db.seed('produtos/p1/produtolojaintegrada/b', { id: 2 });
    db.seed('produtos/p2/produtolojaintegrada/c', { id: 3 });
    expect(await lerVinculosDoProdutoLi(asDb(db), 'p1')).toEqual([
      { id: 1, contaLojaIntegrada: 'x' },
      { id: 2 },
    ]);
    expect(db.consultas).toEqual([
      {
        colecao: 'produtos/p1/produtolojaintegrada',
        filtros: [],
        ordens: [],
        limite: null,
        apos: null,
      },
    ]);
  });
});

describe('the own record: a hint only when it IS the canonical record', () => {
  const CANONICO = `est-p1-${DEP}`;

  it('the canonical hint at the depósito ⇒ ONE point read, and NO query', async () => {
    const db = new FakeDb();
    seedEstoque(db, 'p1', CANONICO, { depositoOuterRef: CANONICA, quantidade: 4 });
    const registros = await lerEstoqueProprioLi(asDb(db), 'p1', DEP, CANONICO);
    expect(registros).toEqual([
      {
        caminho: `produtos/p1/estoques/${CANONICO}`,
        dados: { depositoOuterRef: CANONICA, quantidade: 4 },
      },
    ]);
    expect(db.leituras).toEqual([`produtos/p1/estoques/${CANONICO}`]);
    expect(db.consultas).toEqual([]);
  });

  it('⚠️ NEAR-MISS: the canonical hint stored at ANOTHER depósito ⇒ the query decides', async () => {
    const db = new FakeDb();
    seedEstoque(db, 'p1', CANONICO, { depositoOuterRef: OUTRO_DEP, quantidade: 4 });
    seedEstoque(db, 'p1', 'legado', { depositoOuterRef: CANONICA, quantidade: 9 });
    const registros = await lerEstoqueProprioLi(asDb(db), 'p1', DEP, CANONICO);
    expect(registros.map((r) => r.caminho)).toEqual(['produtos/p1/estoques/legado']);
    expect(db.consultas).toHaveLength(1);
  });

  it('a canonical hint whose record is gone ⇒ the query decides', async () => {
    const db = new FakeDb();
    const registros = await lerEstoqueProprioLi(asDb(db), 'p1', DEP, CANONICO);
    expect(registros).toEqual([]);
    expect(db.leituras).toEqual([`produtos/p1/estoques/${CANONICO}`]);
    expect(db.consultas).toHaveLength(1);
  });

  it('⚠️ a LEGACY hint is never read: a canonical record may sit beside it, and the query sees both', async () => {
    const db = new FakeDb();
    seedEstoque(db, 'p1', 'legado', { depositoOuterRef: CANONICA, quantidade: 9 });
    seedEstoque(db, 'p1', CANONICO, { depositoOuterRef: CANONICA, quantidade: 4 });
    const registros = await lerEstoqueProprioLi(asDb(db), 'p1', DEP, 'legado');
    expect(db.leituras).toEqual([]);
    expect(estoqueNoDepositoLi({ produtoId: 'p1', depositoId: DEP, registros })).toEqual({
      tipo: 'um',
      registro: {
        caminho: `produtos/p1/estoques/${CANONICO}`,
        dados: { depositoOuterRef: CANONICA, quantidade: 4 },
      },
    });
  });

  it('a record stored with the BARE ref form is found', async () => {
    const db = new FakeDb();
    seedEstoque(db, 'p1', 'nua', { depositoOuterRef: NUA, quantidade: 2 });
    seedEstoque(db, 'p1', 'outra', { depositoOuterRef: OUTRO_DEP, quantidade: 5 });
    const registros = await lerEstoqueProprioLi(asDb(db), 'p1', DEP, null);
    expect(registros.map((r) => r.caminho)).toEqual(['produtos/p1/estoques/nua']);
  });

  it('⚠️ NEAR-MISS of the limit: the canonical record beside TWO legacy ones is still seen', async () => {
    const db = new FakeDb();
    // Ids that sort BEFORE the canonical one: a limit of 2 would hand back only the two legacy ones.
    seedEstoque(db, 'p1', 'a-legado', { depositoOuterRef: CANONICA, quantidade: 1 });
    seedEstoque(db, 'p1', 'b-legado', { depositoOuterRef: NUA, quantidade: 2 });
    seedEstoque(db, 'p1', CANONICO, { depositoOuterRef: CANONICA, quantidade: 3 });
    const registros = await lerEstoqueProprioLi(asDb(db), 'p1', DEP, null);
    const resolvido = estoqueNoDepositoLi({ produtoId: 'p1', depositoId: DEP, registros });
    expect(resolvido).toMatchObject({
      tipo: 'um',
      registro: { caminho: `produtos/p1/estoques/${CANONICO}` },
    });
  });
});

describe('the kit components', () => {
  it('only the components that BOUND the kit, in the shared fold’s sense; none for a non-kit', () => {
    expect(
      componentesQueLimitamLi(
        kit({ c1: 1, c2: { quantidade: 1, limitarEstoque: false }, c3: 0, 'a/b': 1 }),
      ),
    ).toEqual(['c1']);
    expect(componentesQueLimitamLi({ ...kit({ c1: 1 }), ehKit: false })).toEqual([]);
    expect(
      componentesQueLimitamLi({
        ehKitVirtual: true,
        componentesKit: kit({ c1: 2 }).componentesKit,
      }),
    ).toEqual(['c1']);
  });

  it('a produto no component bounds costs ZERO reads', async () => {
    const db = new FakeDb();
    expect(await lerComponentesNoDepositoLi(asDb(db), {}, DEP, null)).toEqual([]);
    expect(
      await lerComponentesNoDepositoLi(
        asDb(db),
        kit({ c1: { quantidade: 1, limitarEstoque: false } }),
        DEP,
        null,
      ),
    ).toEqual([]);
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
  });

  it('the payload’s canonical ids ⇒ ONE getAll of exactly those paths, and no query', async () => {
    const db = new FakeDb();
    seedEstoque(db, 'c1', `est-c1-${DEP}`, {
      depositoOuterRef: CANONICA,
      quantidade: 5,
      parentId: 'c1',
    });
    seedEstoque(db, 'c2', `est-c2-${DEP}`, {
      depositoOuterRef: NUA,
      quantidade: 3,
      parentId: 'c2',
    });
    const registros = await lerComponentesNoDepositoLi(asDb(db), kit({ c1: 1, c2: 1 }), DEP, {
      c1: `est-c1-${DEP}`,
      c2: `est-c2-${DEP}`,
    });
    expect(registros.map((r) => r.caminho).sort()).toEqual([
      `produtos/c1/estoques/est-c1-${DEP}`,
      `produtos/c2/estoques/est-c2-${DEP}`,
    ]);
    expect(db.leituras).toEqual([
      `produtos/c1/estoques/est-c1-${DEP}`,
      `produtos/c2/estoques/est-c2-${DEP}`,
    ]);
    expect(db.consultas).toEqual([]);
  });

  it('a payload id at ANOTHER depósito ⇒ the group join; a component the join found only through a LEGACY record, and one with no parentId ⇒ each its own collection', async () => {
    const db = new FakeDb();
    seedEstoque(db, 'c1', `est-c1-${DEP}`, {
      depositoOuterRef: OUTRO_DEP,
      quantidade: 5,
      parentId: 'c1',
    });
    seedEstoque(db, 'c1', 'legado-c1', { depositoOuterRef: NUA, quantidade: 4, parentId: 'c1' });
    seedEstoque(db, 'c2', 'sem-dono', { depositoOuterRef: CANONICA, quantidade: 3 });
    const registros = await lerComponentesNoDepositoLi(asDb(db), kit({ c1: 1, c2: 1 }), DEP, {
      c1: `est-c1-${DEP}`,
    });
    expect(registros.map((r) => r.caminho).sort()).toEqual([
      'produtos/c1/estoques/legado-c1',
      'produtos/c2/estoques/sem-dono',
    ]);
    // c1's join hit is a legacy record: its canonical one may sit beside it with no parentId.
    expect(db.consultas.map((c) => c.colecao)).toEqual([
      GRUPO_ESTOQUE_LI,
      GRUPO_ESTOQUE_LI,
      'produtos/c1/estoques',
      'produtos/c2/estoques',
    ]);
  });

  it('⚠️ a LEGACY record the join finds never hides the CANONICAL one stored with no parentId: the canonical wins', async () => {
    const db = new FakeDb();
    seedEstoque(db, 'c1', 'legado', { depositoOuterRef: CANONICA, quantidade: 20, parentId: 'c1' });
    seedEstoque(db, 'c1', `est-c1-${DEP}`, { depositoOuterRef: NUA, quantidade: 0 });
    const registros = await lerComponentesNoDepositoLi(asDb(db), kit({ c1: 1 }), DEP, null);
    expect(registros.map((r) => r.caminho).sort()).toEqual([
      `produtos/c1/estoques/est-c1-${DEP}`,
      'produtos/c1/estoques/legado',
    ]);
    // …so the plan reads the canonical 0, never the legacy 20.
    expect(estoqueNoDepositoLi({ produtoId: 'c1', depositoId: DEP, registros })).toEqual({
      tipo: 'um',
      registro: expect.objectContaining({ caminho: `produtos/c1/estoques/est-c1-${DEP}` }),
    });
  });

  it('⚠️ two LEGACY records, only one carrying parentId ⇒ both come back, and the plan reads `ambiguo`', async () => {
    const db = new FakeDb();
    seedEstoque(db, 'c1', 'a', { depositoOuterRef: CANONICA, quantidade: 9, parentId: 'c1' });
    seedEstoque(db, 'c1', 'b', { depositoOuterRef: CANONICA, quantidade: 1 });
    const registros = await lerComponentesNoDepositoLi(asDb(db), kit({ c1: 1 }), DEP, null);
    expect(registros.map((r) => r.caminho).sort()).toEqual([
      'produtos/c1/estoques/a',
      'produtos/c1/estoques/b',
    ]);
    expect(estoqueNoDepositoLi({ produtoId: 'c1', depositoId: DEP, registros })).toEqual({
      tipo: 'ambiguo',
    });
  });

  it('NEAR-MISS (cost): the join finds the CANONICAL record ⇒ no own-collection query for that component', async () => {
    const db = new FakeDb();
    seedEstoque(db, 'c1', `est-c1-${DEP}`, {
      depositoOuterRef: CANONICA,
      quantidade: 5,
      parentId: 'c1',
    });
    seedEstoque(db, 'c1', 'legado', { depositoOuterRef: NUA, quantidade: 20, parentId: 'c1' });
    const registros = await lerComponentesNoDepositoLi(asDb(db), kit({ c1: 1 }), DEP, null);
    expect(registros).toHaveLength(2);
    expect(db.consultas.map((c) => c.colecao)).toEqual([GRUPO_ESTOQUE_LI, GRUPO_ESTOQUE_LI]);
  });

  it('⚠️ every record of a component comes back, so the plan can see two legacy ones', async () => {
    const db = new FakeDb();
    seedEstoque(db, 'c1', 'a', { depositoOuterRef: CANONICA, quantidade: 5, parentId: 'c1' });
    seedEstoque(db, 'c1', 'b', { depositoOuterRef: NUA, quantidade: 1, parentId: 'c1' });
    const registros = await lerComponentesNoDepositoLi(asDb(db), kit({ c1: 1 }), DEP, null);
    expect(registros.map((r) => r.caminho).sort()).toEqual([
      'produtos/c1/estoques/a',
      'produtos/c1/estoques/b',
    ]);
  });

  it('⚠️ the owner is the PATH’s: a record whose stored parentId names a component but lives under another produto is not that component’s', async () => {
    const db = new FakeDb();
    seedEstoque(db, 'intruso', 'x', { depositoOuterRef: CANONICA, quantidade: 50, parentId: 'c1' });
    const registros = await lerComponentesNoDepositoLi(asDb(db), kit({ c1: 1 }), DEP, null);
    expect(registros).toEqual([]);
  });

  it('a LEGACY id from the payload is never read (the join decides)', async () => {
    const db = new FakeDb();
    seedEstoque(db, 'c1', 'legado', { depositoOuterRef: CANONICA, quantidade: 5, parentId: 'c1' });
    await lerComponentesNoDepositoLi(asDb(db), kit({ c1: 1 }), DEP, { c1: 'legado' });
    expect(db.leituras).toEqual([]);
  });
});

describe('the hold’s listing and the duplicate probe', () => {
  it('any record at any depósito: a where-less listing, limit 1', async () => {
    const db = new FakeDb();
    expect(await temEstoqueEmQualquerDepositoLi(asDb(db), 'p1')).toBe(false);
    seedEstoque(db, 'p1', 'x', { depositoOuterRef: OUTRO_DEP });
    expect(await temEstoqueEmQualquerDepositoLi(asDb(db), 'p1')).toBe(true);
    expect(db.consultas.at(-1)).toEqual({
      colecao: 'produtos/p1/estoques',
      filtros: [],
      ordens: [],
      limite: 1,
      apos: null,
    });
  });

  const link = (extra: DocData) => ({
    contaLojaIntegrada: `documents/integracao/${CONTA}`,
    id: 7001,
    ...extra,
  });

  it.each([
    ['a number id under the canonical form', link({})],
    [
      'a TEXT id under the bare form',
      link({ id: '7001', contaLojaIntegrada: `integracao/${CONTA}` }),
    ],
    ['a hidden one (it still counts)', link({ ativo: false })],
  ])('another produto holding %s ⇒ duplicate', async (_rotulo, dados) => {
    const db = new FakeDb();
    db.seed('produtos/p1/produtolojaintegrada/meu', link({}));
    db.seed('produtos/p2/produtolojaintegrada/dele', dados);
    expect(await sondarVinculoDuplicadoLi(asDb(db), CONTA, '7001', 'p1')).toBe(true);
  });

  it.each([
    ['our own link alone', null],
    ['a TRASHED link on another produto', link({ removido: true })],
    ['another conta’s link', link({ contaLojaIntegrada: 'documents/integracao/outra' })],
    ['another store id', link({ id: 7002 })],
  ])('⚠️ NEAR-MISS: %s ⇒ no duplicate', async (_rotulo, dados) => {
    const db = new FakeDb();
    db.seed('produtos/p1/produtolojaintegrada/meu', link({}));
    db.seed(
      'produtos/p1/produtolojaintegrada/meu-nu',
      link({ contaLojaIntegrada: `integracao/${CONTA}` }),
    );
    if (dados !== null) db.seed('produtos/p2/produtolojaintegrada/dele', dados);
    expect(await sondarVinculoDuplicadoLi(asDb(db), CONTA, '7001', 'p1')).toBe(false);
  });
});

describe('the daily reconcile’s bulk readers share the send run’s (PR 12-g)', () => {
  it('lerProdutosEstoqueLi reads many produtos with the SAME mask, one getAll per 300, absent ⇒ null', async () => {
    const db = new FakeDb();
    db.seed('produtos/p1', { ehKit: true, nome: 'fora da máscara', componentesKit: null });
    const getAll = vi.spyOn(db, 'getAll');
    const ids = Array.from({ length: MAX_PRODUTOS_POR_LEITURA_ESTOQUE_LI + 1 }, (_, i) =>
      i === 0 ? 'p1' : `x${String(i)}`,
    );
    const lidos = await lerProdutosEstoqueLi(asDb(db), [...ids, 'p1']);
    expect(getAll).toHaveBeenCalledTimes(2);
    expect(getAll.mock.calls[0]?.at(-1)).toEqual({ fieldMask: [...CAMPOS_PRODUTO_ESTOQUE_LI] });
    expect(lidos.get('p1')).toEqual(await lerProdutoEstoqueLi(asDb(db), 'p1'));
    expect(lidos.get('x1')).toBeNull();
    expect(lidos.size).toBe(MAX_PRODUTOS_POR_LEITURA_ESTOQUE_LI + 1);
    expect(await lerProdutosEstoqueLi(asDb(db), [])).toEqual(new Map());
  });

  it('quantidadesQueLimitamLi names EXACTLY the components componentesQueLimitamLi reads, with their quantities', () => {
    const produto = kit({
      a: 2,
      b: { quantidade: 1, limitarEstoque: false },
      c: 0,
      'd/e': 1,
      f: 1.5,
    });
    expect(quantidadesQueLimitamLi(produto)).toEqual({ a: 2, f: 1.5 });
    expect(Object.keys(quantidadesQueLimitamLi(produto))).toEqual(componentesQueLimitamLi(produto));
    expect(quantidadesQueLimitamLi({ componentesKit: kit({ a: 1 }).componentesKit })).toEqual({});
  });

  it('⚠️ lerRegistrosNoDepositoLi with 20 at a time issues the SAME query set as one at a time, and finds the same records', async () => {
    const semear = (db: FakeDb) => {
      for (let i = 0; i < 35; i += 1) {
        const p = `p${String(i).padStart(2, '0')}`;
        if (i % 3 === 0)
          seedEstoque(db, p, `est-${p}-${DEP}`, {
            parentId: p,
            depositoOuterRef: CANONICA,
            quantidade: i,
          });
        else if (i % 3 === 1)
          seedEstoque(db, p, 'legado', { parentId: p, depositoOuterRef: NUA, quantidade: i });
        else seedEstoque(db, p, 'sem-pai', { depositoOuterRef: CANONICA, quantidade: i });
      }
    };
    const ids = Array.from({ length: 35 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const canonicos = Object.fromEntries(ids.map((p) => [p, `est-${p}-${DEP}`]));
    const um = new FakeDb();
    semear(um);
    const vinte = new FakeDb();
    semear(vinte);
    const a = await lerRegistrosNoDepositoLi(asDb(um), ids, DEP, canonicos);
    const b = await lerRegistrosNoDepositoLi(asDb(vinte), ids, DEP, canonicos, {
      concorrencia: 20,
    });
    const chave = (c: { colecao: string; filtros: unknown }) =>
      JSON.stringify([c.colecao, c.filtros]);
    expect(vinte.consultas.map(chave).sort()).toEqual(um.consultas.map(chave).sort());
    expect(b.map((r) => r.caminho).sort()).toEqual(a.map((r) => r.caminho).sort());
    expect(a).toHaveLength(35);
    // The send run's kit read IS this reader: the same queries for the same components.
    const kitDb = new FakeDb();
    semear(kitDb);
    await lerComponentesNoDepositoLi(
      asDb(kitDb),
      kit(Object.fromEntries(ids.map((p) => [p, 1]))),
      DEP,
      null,
    );
    const direto = new FakeDb();
    semear(direto);
    await lerRegistrosNoDepositoLi(asDb(direto), ids, DEP, null);
    expect(kitDb.consultas).toEqual(direto.consultas);
  });
});
