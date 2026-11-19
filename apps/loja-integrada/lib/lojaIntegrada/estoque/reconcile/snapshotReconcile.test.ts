/**
 * `snapshotReconcile.ts` (master plan step 12, PR 12-g): which entry wins when several produtos
 * name one store id (pure), and one slice's per-conta state — loaded in one read, a bucket of
 * another run replaced at first touch carrying only its `x` entries, and written back whole.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLAG_ENTRADA_ESTOQUE_LI,
  type EntradaSnapshotEstoqueLi,
  MAX_AMOSTRA_AVISO_ESTOQUE_LI,
} from '@delfrance/schemas';

import { FakeDb, asDb } from '../../testing/fakeDb';
import { RUN_A, RUN_B } from '../../testing/reconcileEstoqueLi';
import {
  IDS_BALDES_SNAPSHOT_LI,
  carregarEstadosReconcileLi,
  mesclarEntradaSnapshotLi,
} from './snapshotReconcile';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('snapshotReconcile.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const v = (p: string, s = 1): EntradaSnapshotEstoqueLi => ({
  p,
  s,
  f: FLAG_ENTRADA_ESTOQUE_LI.valido,
});
const amb = (p: string): EntradaSnapshotEstoqueLi => ({
  p,
  s: null,
  f: FLAG_ENTRADA_ESTOQUE_LI.ambiguo,
});
const x: EntradaSnapshotEstoqueLi = { p: null, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.semVinculo };

describe('mesclarEntradaSnapshotLi — which entry wins', () => {
  it('EQUAL: the same produto again is a re-evaluation — the new entry, no duplicate', () => {
    expect(mesclarEntradaSnapshotLi(v('p1', 1), v('p1', 4))).toEqual({
      entrada: v('p1', 4),
      duplicados: [],
    });
  });

  it('⚠️ NEAR-MISS: two produtos on one store id ⇒ dup (p = the first, nothing sent), both sampled', () => {
    expect(mesclarEntradaSnapshotLi(v('p1'), v('p2'))).toEqual({
      entrada: { p: 'p1', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.duplicado },
      duplicados: ['p1', 'p2'],
    });
    expect(mesclarEntradaSnapshotLi(amb('p1'), v('p2')).entrada.f).toBe(
      FLAG_ENTRADA_ESTOQUE_LI.duplicado,
    );
  });

  it('a third produto joins the duplicate’s sample; the entry stays the first’s dup', () => {
    const dup: EntradaSnapshotEstoqueLi = {
      p: 'p1',
      s: null,
      f: FLAG_ENTRADA_ESTOQUE_LI.duplicado,
    };
    expect(mesclarEntradaSnapshotLi(dup, v('p3'))).toEqual({ entrada: dup, duplicados: ['p3'] });
  });

  it('⚠️ an x (carried, or a gone produto’s) never counts as a second produto: a walk entry displaces it, and it displaces nothing', () => {
    expect(mesclarEntradaSnapshotLi(x, v('p2'))).toEqual({ entrada: v('p2'), duplicados: [] });
    expect(mesclarEntradaSnapshotLi(v('p2'), x)).toEqual({ entrada: v('p2'), duplicados: [] });
    expect(mesclarEntradaSnapshotLi(x, x)).toEqual({ entrada: x, duplicados: [] });
    expect(mesclarEntradaSnapshotLi(undefined, x)).toEqual({ entrada: x, duplicados: [] });
  });
});

const raiz = (execucaoId: string) => ({
  execucao: { execucaoId, depositoId: 'dep-1', vistos: [], amostras: {}, mapa: null },
});

describe('carregarEstadosReconcileLi — one read, another run’s buckets replaced', () => {
  it('reads the root, the 32 buckets and pais of every conta in ONE getAll; the depósito is the root’s', async () => {
    const db = new FakeDb();
    db.seed('sincEstoqueLojaIntegrada/C1', raiz(RUN_A));
    db.seed('sincEstoqueLojaIntegrada/C2', {
      ...raiz(RUN_A),
      execucao: { ...raiz(RUN_A).execucao, depositoId: 'dep-2' },
    });
    const estados = await carregarEstadosReconcileLi(asDb(db), RUN_A, ['C1', 'C2']);
    expect(db.leituras).toHaveLength(2 * (IDS_BALDES_SNAPSHOT_LI.length + 2));
    expect([...(estados?.values() ?? [])].map((e) => e.conta)).toEqual([
      { idx: 0, contaId: 'C1', depositoId: 'dep-1' },
      { idx: 1, contaId: 'C2', depositoId: 'dep-2' },
    ]);
  });

  it('a root whose run state is ANOTHER run’s ⇒ null (the lease is not this slice’s)', async () => {
    const db = new FakeDb();
    db.seed('sincEstoqueLojaIntegrada/C1', raiz(RUN_B));
    expect(await carregarEstadosReconcileLi(asDb(db), RUN_A, ['C1'])).toBeNull();
  });

  it('⚠️ a bucket of another run is REPLACED at load, carrying forward ONLY its x entries; one of this run is kept as is', async () => {
    const db = new FakeDb();
    db.seed('sincEstoqueLojaIntegrada/C1', raiz(RUN_A));
    db.seed('sincEstoqueLojaIntegrada/C1/snapshot/05', {
      execucaoId: RUN_B,
      e: { '5': v('p1'), '37': x, '69': { p: 'p9', s: null, f: 'r' } },
    });
    db.seed('sincEstoqueLojaIntegrada/C1/snapshot/06', {
      execucaoId: RUN_A,
      e: { '6': v('p6', 2) },
    });
    db.seed('sincEstoqueLojaIntegrada/C1/snapshot/pais', { execucaoId: RUN_B, ids: ['900'] });
    const estado = (await carregarEstadosReconcileLi(asDb(db), RUN_A, ['C1']))?.get('C1');
    expect(estado?.entrada('5')).toBeUndefined();
    expect(estado?.entrada('37')).toEqual(x);
    expect(estado?.entrada('69')).toBeUndefined();
    expect(estado?.entrada('6')).toEqual(v('p6', 2));
    const escritas = estado?.escritas() ?? [];
    // Every bucket not of this run (absent included) and pais are written; bucket 06 is not.
    expect(escritas.map((e) => e.ref.path).sort()).toEqual(
      [
        ...IDS_BALDES_SNAPSHOT_LI.filter((id) => id !== '06').map(
          (id) => `sincEstoqueLojaIntegrada/C1/snapshot/${id}`,
        ),
        'sincEstoqueLojaIntegrada/C1/snapshot/pais',
      ].sort(),
    );
    const do05 = escritas.find((e) => e.ref.path.endsWith('/05'));
    expect(do05).toMatchObject({ tipo: 'gravar', dados: { execucaoId: RUN_A, e: { '37': x } } });
    // Present when read ⇒ an update under that read's stamp; absent ⇒ a create.
    expect(
      do05?.tipo === 'gravar'
        ? do05.versao?.isEqual(db.carimboDe('sincEstoqueLojaIntegrada/C1/snapshot/05') as never)
        : false,
    ).toBe(true);
    const do00 = escritas.find((e) => e.ref.path.endsWith('/00'));
    expect(do00?.tipo === 'gravar' ? do00.versao : 'x').toBeNull();
  });

  it('entries, parents and samples change in memory and only the touched documents are written', async () => {
    const db = new FakeDb();
    db.seed('sincEstoqueLojaIntegrada/C1', raiz(RUN_A));
    for (const id of IDS_BALDES_SNAPSHOT_LI) {
      db.seed(`sincEstoqueLojaIntegrada/C1/snapshot/${id}`, { execucaoId: RUN_A, e: {} });
    }
    db.seed('sincEstoqueLojaIntegrada/C1/snapshot/pais', { execucaoId: RUN_A, ids: [] });
    const estado = (await carregarEstadosReconcileLi(asDb(db), RUN_A, ['C1']))?.get('C1');
    if (estado === undefined) throw new Error('fixture');
    expect(estado.escritas()).toEqual([]);
    expect(estado.aplicar('33', v('p1'))).toEqual([]);
    expect(estado.aplicar('33', v('p2'))).toEqual(['p1', 'p2']);
    estado.adicionarPai('900');
    const caminhos = estado.escritas().map((e) => e.ref.path);
    expect(caminhos).toEqual([
      'sincEstoqueLojaIntegrada/C1',
      'sincEstoqueLojaIntegrada/C1/snapshot/01',
      'sincEstoqueLojaIntegrada/C1/snapshot/pais',
    ]);
    expect(estado.raiz.execucao.amostras).toEqual({ duplicado: ['p1', 'p2'] });
  });

  it(`a sample keeps at most ${String(MAX_AMOSTRA_AVISO_ESTOQUE_LI)} ids, deduplicated`, async () => {
    const db = new FakeDb();
    db.seed('sincEstoqueLojaIntegrada/C1', raiz(RUN_A));
    const estado = (await carregarEstadosReconcileLi(asDb(db), RUN_A, ['C1']))?.get('C1');
    if (estado === undefined) throw new Error('fixture');
    estado.amostrar('retido', ['p0', 'p0']);
    estado.amostrar(
      'retido',
      Array.from({ length: MAX_AMOSTRA_AVISO_ESTOQUE_LI + 5 }, (_, i) => `p${String(i)}`),
    );
    const amostra = estado.raiz.execucao.amostras.retido ?? [];
    expect(amostra).toHaveLength(MAX_AMOSTRA_AVISO_ESTOQUE_LI);
    expect(new Set(amostra).size).toBe(MAX_AMOSTRA_AVISO_ESTOQUE_LI);
    expect(amostra[0]).toBe('p0');
  });
});
