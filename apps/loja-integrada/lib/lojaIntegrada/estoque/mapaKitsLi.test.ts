/**
 * `mapaKitsLi.ts` (master plan step 12, PR 12-f): the kits map's read side — every read a point
 * read in ONE `getAll`, a header parsed with the REFINED schema, shards counted, never guessed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tarefaEstoqueLiSchema } from '@delfrance/schemas';

import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import {
  lerCabecalhosKitsLi,
  lerFatiasKitsLi,
  lerRegistrosPorCaminhoLi,
  tarefaDoKitLi,
} from './mapaKitsLi';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('mapaKitsLi.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const EXEC = 'estoque-reconcile-20261118';
const cabecalhoPath = (conta: string, p: string) => `sincEstoqueLojaIntegrada/${conta}/kits/${p}`;
const fatiaPath = (conta: string, id: string) =>
  `sincEstoqueLojaIntegrada/${conta}/kitsFatias/${id}`;

function kits(n: number, componente = 'p'): Record<string, DocData> {
  return Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `kit-${String(i)}`,
      { i: String(100 + i), q: { [componente]: 1 } },
    ]),
  );
}

function cabecalhoEmLinha(n: number, over: DocData = {}): DocData {
  return {
    execucaoId: EXEC,
    F: n,
    qMax: 1,
    comps: { p: 'est-p-dep' },
    kits: kits(n),
    fatias: 0,
    ...over,
  };
}

describe('lerCabecalhosKitsLi', () => {
  it('ONE getAll over every conta: NOT_FOUND ⇒ ausente, a valid header ⇒ ok (parsed), keyed by conta', async () => {
    const db = new FakeDb();
    db.seed(cabecalhoPath('b', 'p'), cabecalhoEmLinha(2));

    const lidos = await lerCabecalhosKitsLi(asDb(db), ['a', 'b'], 'p');

    expect(db.leituras).toEqual([cabecalhoPath('a', 'p'), cabecalhoPath('b', 'p')]);
    expect(lidos.get('a')).toEqual({ tipo: 'ausente' });
    const b = lidos.get('b');
    expect(b?.tipo).toBe('ok');
    expect(b?.tipo === 'ok' ? Object.keys(b.cabecalho.kits ?? {}).sort() : null).toEqual([
      'kit-0',
      'kit-1',
    ]);
  });

  it('a header off the REFINED schema (F disagreeing with its inline kits) ⇒ invalido, field names only', async () => {
    const db = new FakeDb();
    db.seed(cabecalhoPath('a', 'p'), cabecalhoEmLinha(2, { F: 3 }));
    db.seed(cabecalhoPath('b', 'p'), { execucaoId: 'x y', F: 1, qMax: 1 });

    const lidos = await lerCabecalhosKitsLi(asDb(db), ['a', 'b'], 'p');

    expect(lidos.get('a')).toEqual({ tipo: 'invalido', campos: ['kits'] });
    expect(lidos.get('b')).toEqual({ tipo: 'invalido', campos: ['execucaoId', 'fatias', 'kits'] });
  });

  it('no conta ⇒ no read at all', async () => {
    const db = new FakeDb();
    expect((await lerCabecalhosKitsLi(asDb(db), [], 'p')).size).toBe(0);
    expect(db.leituras).toEqual([]);
  });
});

describe('lerRegistrosPorCaminhoLi', () => {
  it('ONE getAll of the DEDUPLICATED paths; absent ⇒ null', async () => {
    const db = new FakeDb();
    db.seed('produtos/c1/estoques/e1', { quantidade: 4 });

    const lidos = await lerRegistrosPorCaminhoLi(asDb(db), [
      'produtos/c1/estoques/e1',
      'produtos/c2/estoques/e1',
      'produtos/c1/estoques/e1',
    ]);

    expect(db.leituras).toEqual(['produtos/c1/estoques/e1', 'produtos/c2/estoques/e1']);
    expect(lidos.get('produtos/c1/estoques/e1')).toEqual({ quantidade: 4 });
    expect(lidos.get('produtos/c2/estoques/e1')).toBeNull();
  });

  it('no path ⇒ no read; a text that is not a stock path is a bug (RangeError)', async () => {
    const db = new FakeDb();
    expect((await lerRegistrosPorCaminhoLi(asDb(db), [])).size).toBe(0);
    expect(db.leituras).toEqual([]);
    await expect(lerRegistrosPorCaminhoLi(asDb(db), ['produtos/c1/outros/e1'])).rejects.toThrow(
      RangeError,
    );
  });
});

describe('lerFatiasKitsLi', () => {
  const cab = { execucaoId: EXEC, F: 3, fatias: 2 };

  it('ONE getAll of the promised shards (ids from idFatiaKitsEstoqueLi), merged; complete when every shard is there, of the run, with F kits', async () => {
    const db = new FakeDb();
    db.seed(fatiaPath('a', 'p~0'), {
      execucaoId: EXEC,
      kits: { k1: { i: '1', q: { p: 1 } }, k2: { i: '2', q: { p: 2 } } },
    });
    db.seed(fatiaPath('a', 'p~1'), { execucaoId: EXEC, kits: { k3: { i: '3', q: { p: 3 } } } });

    const lidas = await lerFatiasKitsLi(asDb(db), 'a', 'p', cab);

    expect(db.leituras).toEqual([fatiaPath('a', 'p~0'), fatiaPath('a', 'p~1')]);
    expect(Object.keys(lidas.kits).sort()).toEqual(['k1', 'k2', 'k3']);
    expect(lidas).toMatchObject({
      ausentes: 0,
      invalidas: 0,
      deOutraExecucao: 0,
      repetidos: 0,
      completa: true,
    });
  });

  it('a missing shard, an invalid one, another run’s, a kit in two shards, or a count off F ⇒ counted, NOT complete — and the readable kits still merged', async () => {
    const db = new FakeDb();
    db.seed(fatiaPath('a', 'p~0'), {
      execucaoId: 'outra-execucao',
      kits: { k1: { i: '1', q: { p: 1 } } },
    });
    db.seed(fatiaPath('a', 'p~1'), { execucaoId: EXEC, kits: { k1: { i: '1', q: { p: 1 } } } });
    const repetido = await lerFatiasKitsLi(asDb(db), 'a', 'p', cab);
    expect(repetido).toMatchObject({ deOutraExecucao: 1, repetidos: 1, completa: false });
    expect(Object.keys(repetido.kits)).toEqual(['k1']);

    const db2 = new FakeDb();
    db2.seed(fatiaPath('a', 'p~1'), { execucaoId: EXEC, kits: {} });
    const vazia = await lerFatiasKitsLi(asDb(db2), 'a', 'p', cab);
    expect(vazia).toMatchObject({ ausentes: 1, invalidas: 1, completa: false });

    const db3 = new FakeDb();
    db3.seed(fatiaPath('a', 'p~0'), { execucaoId: EXEC, kits: { k1: { i: '1', q: { p: 1 } } } });
    db3.seed(fatiaPath('a', 'p~1'), { execucaoId: EXEC, kits: { k2: { i: '2', q: { p: 1 } } } });
    // ⚠️ NEAR-MISS of the complete case: every shard fine, but 2 kits where F says 3.
    expect(await lerFatiasKitsLi(asDb(db3), 'a', 'p', cab)).toMatchObject({ completa: false });
  });

  it('a kit repeated across shards keeps the FIRST shard’s copy (counted as repeated); ⚠️ NEAR-MISS: the later shard’s other quantity is not taken', async () => {
    const db = new FakeDb();
    db.seed(fatiaPath('a', 'p~0'), { execucaoId: EXEC, kits: { k1: { i: '1', q: { p: 1 } } } });
    db.seed(fatiaPath('a', 'p~1'), {
      execucaoId: EXEC,
      kits: { k1: { i: '9', q: { p: 5 } }, k2: { i: '2', q: { p: 2 } } },
    });
    const lidas = await lerFatiasKitsLi(asDb(db), 'a', 'p', cab);
    expect(lidas.kits.k1).toEqual({ i: '1', q: { p: 1 } });
    expect(lidas.kits.k2).toEqual({ i: '2', q: { p: 2 } });
    expect(lidas).toMatchObject({ repetidos: 1, completa: false });
  });

  it('a header promising no shard reads nothing', async () => {
    const db = new FakeDb();
    const lidas = await lerFatiasKitsLi(asDb(db), 'a', 'p', { execucaoId: EXEC, F: 1, fatias: 0 });
    expect(db.leituras).toEqual([]);
    expect(lidas.completa).toBe(false);
  });
});

describe('tarefaDoKitLi: the ONE kit send task both kit producers build', () => {
  it('origin kit, no record, no delete, generation 0; each of the kit’s components → its comps id, verbatim (a legacy one too), else null', () => {
    const t = tarefaDoKitLi(
      'conta-li-a',
      'kit-1',
      { i: '5000', q: { blank: 1, print: 2, tinta: 1 } },
      { blank: 'est-blank-dep', print: 'auto-legado-1', outro: 'est-outro-dep' },
    );
    expect(t).toEqual({
      contaId: 'conta-li-a',
      produtoId: 'kit-1',
      origem: 'kit',
      estoqueId: null,
      apagado: false,
      estoqueIds: { blank: 'est-blank-dep', print: 'auto-legado-1', tinta: null },
      geracao: 0,
    });
    // It parses as a send task once a window is added.
    expect(tarefaEstoqueLiSchema.safeParse({ ...t, tipo: 'estoque', janela: 1 }).success).toBe(
      true,
    );
  });

  it('⚠️ NEAR-MISS: an INHERITED comps key is not the header’s — the component reads null', () => {
    const comps = Object.create({ blank: 'herdado' }) as Record<string, string | null>;
    expect(
      tarefaDoKitLi('conta-li-a', 'kit-1', { i: '1', q: { blank: 1 } }, comps).estoqueIds,
    ).toEqual({ blank: null });
  });
});
