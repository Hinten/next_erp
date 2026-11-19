/**
 * `mapaKitsReconcile.ts` (master plan step 12, PR 12-g): the kits map built from the snapshot alone,
 * inline up to 30 kits and sharded beyond, each component's header and shards in ONE batch the
 * reader then calls `completa`, and the sweep removing only another run's documents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLAG_ENTRADA_ESTOQUE_LI,
  type EntradaSnapshotEstoqueLi,
  MAX_KITS_EM_LINHA_ESTOQUE_LI,
  MAX_KITS_POR_FATIA_ESTOQUE_LI,
} from '@delfrance/schemas';

import { FakeDb, asDb } from '../../testing/fakeDb';
import { AGORA_RECONCILE_MS, RUN_A, RUN_B } from '../../testing/reconcileEstoqueLi';
import { lerCabecalhosKitsLi, lerFatiasKitsLi } from '../mapaKitsLi';
import { gravarLoteReconcileLi, lerRunReconcileLi } from './execucaoReconcile';
import {
  MAX_ESCRITAS_LOTE_MAPA_LI,
  histogramaDeKitsLi,
  montarMapaKitsLi,
  proximoLoteDeEscritaDoMapaLi,
  proximoLoteDeVarreduraDoMapaLi,
} from './mapaKitsReconcile';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('mapaKitsReconcile.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A store kit's entry: kit produto `p`, components → quantity, each resolved to `est-<c>`. */
function kit(p: string, q: Record<string, number>): EntradaSnapshotEstoqueLi {
  return {
    p,
    s: 1,
    f: FLAG_ENTRADA_ESTOQUE_LI.valido,
    k: true,
    q,
    e: Object.fromEntries(Object.keys(q).map((c) => [c, `est-${c}`])),
  };
}

/** `n` store kits of component `blank` (with `print` beside it), store ids from 1000. */
function kitsDoBlank(n: number): [string, EntradaSnapshotEstoqueLi][] {
  return Array.from({ length: n }, (_, i) => [
    String(1000 + i),
    kit(`k${String(i).padStart(5, '0')}`, { blank: 1, print: 2 }),
  ]);
}

describe('montarMapaKitsLi — from the snapshot alone', () => {
  it(`F = ${String(MAX_KITS_EM_LINHA_ESTOQUE_LI)} ⇒ inline (no shard); F = ${String(MAX_KITS_EM_LINHA_ESTOQUE_LI + 1)} ⇒ kits null, ONE shard (near-miss)`, () => {
    const em30 = montarMapaKitsLi(RUN_A, kitsDoBlank(MAX_KITS_EM_LINHA_ESTOQUE_LI)).componentes.get(
      'blank',
    );
    expect(em30?.cabecalho).toMatchObject({ F: 30, fatias: 0 });
    expect(Object.keys((em30?.cabecalho.kits ?? {}) as object)).toHaveLength(30);
    expect(em30?.fatias).toEqual([]);
    const em31 = montarMapaKitsLi(
      RUN_A,
      kitsDoBlank(MAX_KITS_EM_LINHA_ESTOQUE_LI + 1),
    ).componentes.get('blank');
    expect(em31?.cabecalho).toMatchObject({ F: 31, kits: null, fatias: 1 });
    expect(em31?.fatias.map(([n]) => n)).toEqual([0]);
  });

  it(`F = 1 001 ⇒ two shards of at most ${String(MAX_KITS_POR_FATIA_ESTOQUE_LI)}, every kit once`, () => {
    const docs = montarMapaKitsLi(RUN_A, kitsDoBlank(1001)).componentes.get('blank');
    expect(docs?.cabecalho).toMatchObject({ F: 1001, fatias: 2, execucaoId: RUN_A });
    const tamanhos = docs?.fatias.map(([, f]) => Object.keys(f.kits as object).length);
    expect(tamanhos).toEqual([1000, 1]);
  });

  it('qMax is the component’s largest quantity in any kit; comps every component → the first kit’s record; a kit with no composition is left out and counted', () => {
    const mapa = montarMapaKitsLi(RUN_A, [
      ['1', kit('kb', { blank: 3, print: 1 })],
      ['2', { ...kit('ka', { blank: 1 }), e: { blank: 'est-outro' } }],
      ['3', { p: 'kc', s: 1, f: FLAG_ENTRADA_ESTOQUE_LI.valido, k: true }],
      ['4', { p: 'nk', s: 1, f: FLAG_ENTRADA_ESTOQUE_LI.valido }],
      ['5', { p: 'amb', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.ambiguo, k: true }],
    ]);
    expect(mapa.kitsSemComposicao).toBe(1);
    expect(mapa.kits).toBe(2);
    const blank = mapa.componentes.get('blank')?.cabecalho;
    expect(blank).toMatchObject({
      F: 2,
      qMax: 3,
      comps: { blank: 'est-outro', print: 'est-print' },
      kits: { ka: { i: '2', q: { blank: 1 } }, kb: { i: '1', q: { blank: 3, print: 1 } } },
    });
    expect(mapa.componentes.get('print')?.cabecalho).toMatchObject({ F: 1, qMax: 1 });
    expect([...mapa.componentes.keys()]).toEqual(['blank', 'print']);
  });

  it('the kits-per-component histogram', () => {
    const mapa = montarMapaKitsLi(RUN_A, [...kitsDoBlank(31)]);
    expect(histogramaDeKitsLi(mapa)).toEqual({
      f1: 0,
      f2a5: 0,
      f6a30: 0,
      f31a100: 2,
      f101a1000: 0,
      acimaDe1000: 0,
    });
  });
});

/** A run document holding the lease, and the slice's write state. */
async function estadoDeEscrita(db: FakeDb) {
  db.seed('reconcileEstoqueLojaIntegrada/atual', {
    execucaoId: RUN_A,
    iniciadoEmMs: AGORA_RECONCILE_MS,
    emExecucaoAteMs: AGORA_RECONCILE_MS + 1,
    seq: 1,
    fase: 'erp',
    contas: ['C1'],
  });
  const lido = await lerRunReconcileLi(asDb(db));
  if (lido.versao === null) throw new Error('fixture');
  return { execucaoId: RUN_A, seq: 1, versaoRun: lido.versao, runEsperado: lido.dados };
}

describe('the map written — one batch per unit, a header with ALL its shards', () => {
  it('⚠️ a sharded component’s header and shards land in ONE batch, and the 12-f reader reads it complete', async () => {
    const db = new FakeDb();
    const mapa = montarMapaKitsLi(RUN_A, kitsDoBlank(1001));
    const lote = proximoLoteDeEscritaDoMapaLi(asDb(db), 'C1', mapa, null);
    expect(lote.ultimoComponenteId).toBe('print');
    const estado = await estadoDeEscrita(db);
    await gravarLoteReconcileLi(
      asDb(db),
      estado,
      { emExecucaoAteMs: AGORA_RECONCILE_MS + 2 },
      lote.escritas,
    );
    // Every write of the unit shares ONE batch.
    expect(new Set(db.escritas.map((e) => e.lote)).size).toBe(1);
    const cabecalho = (await lerCabecalhosKitsLi(asDb(db), ['C1'], 'blank')).get('C1');
    expect(cabecalho?.tipo).toBe('ok');
    if (cabecalho?.tipo !== 'ok') return;
    const fatias = await lerFatiasKitsLi(asDb(db), 'C1', 'blank', cabecalho.cabecalho);
    expect(fatias.completa).toBe(true);
    expect(Object.keys(fatias.kits)).toHaveLength(1001);
  });

  it('a batch holds whole components only, within the write ceiling; the next one starts after the cursor', () => {
    const db = new FakeDb();
    // 450 components, each in ONE kit of its own: 450 headers, more than one batch holds.
    const entradas: [string, EntradaSnapshotEstoqueLi][] = Array.from({ length: 450 }, (_, i) => [
      String(10 + i),
      kit(`kit${String(i)}`, { [`c${String(i).padStart(3, '0')}`]: 1 }),
    ]);
    const mapa = montarMapaKitsLi(RUN_A, entradas);
    const primeiro = proximoLoteDeEscritaDoMapaLi(asDb(db), 'C1', mapa, null);
    expect(primeiro.escritas).toHaveLength(MAX_ESCRITAS_LOTE_MAPA_LI);
    expect(primeiro.ultimoComponenteId).toBe('c399');
    const segundo = proximoLoteDeEscritaDoMapaLi(asDb(db), 'C1', mapa, primeiro.ultimoComponenteId);
    expect(segundo.componentes).toBe(50);
    expect(segundo.ultimoComponenteId).toBe('c449');
    expect(proximoLoteDeEscritaDoMapaLi(asDb(db), 'C1', mapa, 'c449')).toEqual({
      escritas: [],
      ultimoComponenteId: null,
      componentes: 0,
    });
  });
});

describe('the sweep — only ANOTHER run’s headers and shards', () => {
  it('lists both subcollections projected to the run id, and deletes exactly what is not this run’s', async () => {
    const db = new FakeDb();
    const kits = 'sincEstoqueLojaIntegrada/C1/kits';
    const fatias = 'sincEstoqueLojaIntegrada/C1/kitsFatias';
    db.seed(`${kits}/blank`, { execucaoId: RUN_A, F: 1 });
    db.seed(`${kits}/sumiu`, { execucaoId: RUN_B, F: 1 });
    db.seed(`${kits}/semRun`, { F: 1 });
    db.seed(`${fatias}/blank~0`, { execucaoId: RUN_A, kits: {} });
    db.seed(`${fatias}/blank~1`, { execucaoId: RUN_B, kits: {} });
    const apagar = await proximoLoteDeVarreduraDoMapaLi(asDb(db), 'C1', RUN_A);
    expect(apagar.map((e) => e.ref.path).sort()).toEqual(
      [`${kits}/semRun`, `${kits}/sumiu`, `${fatias}/blank~1`].sort(),
    );
    expect(apagar.every((e) => e.tipo === 'apagar')).toBe(true);
    expect(db.consultas.map((c) => [c.colecao, c.selecao])).toEqual([
      [kits, ['execucaoId']],
      [fatias, ['execucaoId']],
    ]);
  });

  it('⚠️ NEAR-MISS: with nothing of another run left, the sweep deletes nothing', async () => {
    const db = new FakeDb();
    db.seed('sincEstoqueLojaIntegrada/C1/kits/blank', { execucaoId: RUN_A, F: 1 });
    expect(await proximoLoteDeVarreduraDoMapaLi(asDb(db), 'C1', RUN_A)).toEqual([]);
  });
});
