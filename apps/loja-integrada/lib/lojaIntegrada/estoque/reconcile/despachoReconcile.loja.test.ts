/**
 * `despachoReconcile.ts` × `faseLi.ts` (master plan step 12, PR 12-g): the store phase INSIDE the
 * slice machine — the real budget against a clock the store's pacer moves, the end-of-slice
 * checkpoint of the list cursor and the hand-off, the 429 pause, the progress checkpoint before a
 * retried failure, the queue's last attempt, and a whole run from the ERP walk to the release.
 * Against `testing/fakeDb.ts` and the stateful store (`testing/plataformaEscritaLi.ts`).
 *
 * No call to the store: the global `fetch` is stubbed to throw in every test of this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import { LiHttpError } from '@delfrance/integrations-loja-integrada';
import {
  type EntradaSnapshotEstoqueLi,
  FLAG_ENTRADA_ESTOQUE_LI,
  TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../../core/contaCache';
import { CHAMADAS_ENV_LI } from '../../core/valvulas';
import { FakeDb, asDb, increment } from '../../testing/fakeDb';
import { gravadorDeLog, seedCredencial } from '../../testing/fixtures';
import {
  CAMINHO_LISTA_ESTOQUE_LI,
  chamadaDaListaLi,
  criarPlataformaEscritaLi,
  linhaEstoqueLi,
  naProxima,
  respostaJson,
} from '../../testing/plataformaEscritaLi';
import {
  AGORA_RECONCILE_MS,
  CAMINHO_RUN_RECONCILE_LI,
  INICIO_RUN_RECONCILE_MS,
  RUN_A,
  agendadorGravador,
  loggerGravador,
  refDeposito,
  seedContaComDeposito,
  seedLinkFilho,
  seedProduto,
  seedRegistro,
  seedRunNaFaseLi,
} from '../../testing/reconcileEstoqueLi';
import { LIMITE_PAGINA_ESTOQUE_ENV_LI } from '../configEstoqueLi';
import { type DepsReconcileEstoqueLi, despacharReconcileEstoqueLi } from './despachoReconcile';

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_RECONCILE_MS);
  vi.stubGlobal('fetch', () => {
    throw new Error('despachoReconcile.loja.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
});

const tarefa = (seq: number) => ({
  tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  execucaoId: RUN_A,
  seq,
});
const v = (p: string, s: number): EntradaSnapshotEstoqueLi => ({
  p,
  s,
  f: FLAG_ENTRADA_ESTOQUE_LI.valido,
});

/** Every slice's world: the store, a clock its pacer moves by `passoMs`, the producer, the logs. */
function mundo(
  p: ReturnType<typeof criarPlataformaEscritaLi>,
  o: { readonly passoMs?: number; readonly limite?: string; readonly chamadas?: string } = {},
) {
  const relogio = { agora: AGORA_RECONCILE_MS };
  const fila = agendadorGravador();
  const log = loggerGravador();
  const sink = gravadorDeLog();
  const deps = (extra: Partial<DepsReconcileEstoqueLi> = {}): DepsReconcileEstoqueLi => ({
    ambiente: {
      LOJA_INTEGRADA_MODO_ESTOQUE: 'dry-run',
      [CHAMADAS_ENV_LI]: o.chamadas ?? 'on',
      [LIMITE_PAGINA_ESTOQUE_ENV_LI]: o.limite ?? '2',
    },
    agoraMs: () => relogio.agora,
    inicioMs: relogio.agora,
    tentativa: 0,
    idTarefa: null,
    esperar: async (ms) => {
      await p.esperar(ms);
      relogio.agora += o.passoMs ?? 0;
      // A macrotask turn per call: a slice that never ends fails on the test's timeout instead
      // of starving the timer queue.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
    increment,
    agendador: () => fila.agendador,
    logger: log.logger,
    fetch: p.fetch,
    escrever: sink.escrever,
    tamanhoPaginaCaminhada: 2,
    ...extra,
  });
  return { relogio, fila, log, sink, deps };
}

/** Runs slices from `seq`, each handing off to the next, until one does not. */
async function encadear(db: FakeDb, m: ReturnType<typeof mundo>, seq: number) {
  const resultados = [];
  let atual = seq;
  for (let n = 0; n < 60; n += 1) {
    const r = await despacharReconcileEstoqueLi(
      asDb(db),
      tarefa(atual),
      m.deps({ inicioMs: m.relogio.agora }),
    );
    resultados.push(r);
    if (r.kind !== 'continua') return resultados;
    atual = r.seq;
    m.relogio.agora += 2_000;
  }
  throw new Error('a cadeia não terminou');
}

/** One conta (C1, dep-1) at the store phase, `n` store rows all in step with their entries. */
function contaEmDia(n: number) {
  const db = new FakeDb();
  seedContaComDeposito(db, 'C1', refDeposito('dep-1'));
  seedCredencial(db, 'C1');
  const ids = Array.from({ length: n }, (_, k) => 100 + k);
  seedRunNaFaseLi(db, [
    {
      contaId: 'C1',
      depositoId: 'dep-1',
      entradas: Object.fromEntries(ids.map((id) => [String(id), v(`p${String(id)}`, 1)])),
    },
  ]);
  const p = criarPlataformaEscritaLi({
    estoque: ids.map((id) => linhaEstoqueLi(id, { quantidade: 1 })),
  });
  return { db, p };
}

const listas = (p: ReturnType<typeof criarPlataformaEscritaLi>) =>
  p.chamadasComBusca().filter((c) => c.startsWith(`GET ${CAMINHO_LISTA_ESTOQUE_LI}?`));

describe('the store phase in the slice machine', () => {
  it('⚠️ a run cut at page 13 of 25 RESUMES at 13: the next slice’s FIRST call is that page, and the conta costs exactly 25 page calls', async () => {
    const { db, p } = contaEmDia(100);
    // Each call moves the clock 4.1 s: 12 pages start inside a slice (the 13th would at 49.2 s).
    const m = mundo(p, { passoMs: 4_100, limite: '4' });
    const r1 = await despacharReconcileEstoqueLi(asDb(db), tarefa(5), m.deps());
    expect(r1).toEqual({ kind: 'continua', fase: 'li', seq: 6 });
    expect(listas(p)).toHaveLength(12);
    expect(db.ler('sincEstoqueLojaIntegrada/C1')?.reconcile).toEqual({
      offset: 48,
      limite: 4,
      iniciadoEmMs: AGORA_RECONCILE_MS,
    });
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)).toMatchObject({ seq: 6, fase: 'li', idxConta: 0 });
    expect(m.fila.enfileirados).toEqual([{ execucaoId: RUN_A, seq: 6, atrasoS: 2 }]);

    m.relogio.agora += 2_000;
    const antes = listas(p).length;
    const resto = await encadear(db, m, 6);
    expect(resto.at(-1)).toEqual({ kind: 'encerrado' });
    expect(listas(p)[antes]).toBe(chamadaDaListaLi(48, 4));
    expect(listas(p)).toHaveLength(25);
    expect(new Set(listas(p)).size).toBe(25);
    // The counters that land in the run document before the release.
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({
      c0Paginas: 25,
      c0Linhas: 100,
      c0EmDia: 100,
      c0ListaCompleta: 1,
      c0VerificacaoFeita: 1,
    });
  });

  it('a 429 PAUSES: the slice checkpoints (pausas429 + 1) and hands off 60 s later; the task resolves; the next slice re-reads that page', async () => {
    const { db, p } = contaEmDia(6);
    p.fila.push((r) =>
      r.caminho === CAMINHO_LISTA_ESTOQUE_LI && r.busca.includes('offset=2')
        ? respostaJson(429, {})
        : null,
    );
    const m = mundo(p);
    const r1 = await despacharReconcileEstoqueLi(asDb(db), tarefa(5), m.deps());
    expect(r1).toEqual({ kind: 'continua', fase: 'li', seq: 6 });
    expect(m.fila.enfileirados).toEqual([{ execucaoId: RUN_A, seq: 6, atrasoS: 60 }]);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({
      c0Pausas429: 1,
      c0Paginas: 1,
    });
    expect(db.ler('sincEstoqueLojaIntegrada/C1')?.reconcile).toMatchObject({ offset: 2 });
    m.relogio.agora += 60_000;
    expect((await encadear(db, m, 6)).at(-1)).toEqual({ kind: 'encerrado' });
    expect(listas(p)).toEqual([
      chamadaDaListaLi(0, 2),
      chamadaDaListaLi(2, 2),
      chamadaDaListaLi(2, 2),
      chamadaDaListaLi(4, 2),
    ]);
  });

  it('⚠️ a 503 is RETRIED: the slice first writes what it completed at the SAME seq (the cursor at the failed page), then rethrows the original error; the retry resumes there', async () => {
    const { db, p } = contaEmDia(6);
    // The first page passes; the second answers 503.
    p.fila.push((r) =>
      r.caminho === CAMINHO_LISTA_ESTOQUE_LI && r.busca.includes('offset=2')
        ? respostaJson(503, {})
        : null,
    );
    const m = mundo(p);
    await expect(despacharReconcileEstoqueLi(asDb(db), tarefa(5), m.deps())).rejects.toBeInstanceOf(
      LiHttpError,
    );
    const run = db.ler(CAMINHO_RUN_RECONCILE_LI);
    expect(run).toMatchObject({ seq: 5, fase: 'li' });
    expect(run?.contadores).toMatchObject({ c0Paginas: 1, c0Linhas: 2 });
    expect(db.ler('sincEstoqueLojaIntegrada/C1')?.reconcile).toMatchObject({ offset: 2 });
    expect(m.fila.enfileirados).toEqual([]);
    // The queue's retry of the SAME task resumes at the failed page.
    p.fila.length = 0;
    const r = await encadear(db, { ...m, deps: (x = {}) => m.deps({ tentativa: 1, ...x }) }, 5);
    expect(r.at(-1)).toEqual({ kind: 'encerrado' });
    expect(listas(p)).toEqual([
      chamadaDaListaLi(0, 2),
      chamadaDaListaLi(2, 2),
      chamadaDaListaLi(2, 2),
      chamadaDaListaLi(4, 2),
    ]);
  });

  it(`on the queue's LAST attempt the failing conta is ENDED and the chain goes on with the next one`, async () => {
    const db = new FakeDb();
    for (const conta of ['C1', 'C2']) {
      seedContaComDeposito(db, conta, refDeposito('dep-1'), { nome: conta });
      seedCredencial(db, conta);
    }
    seedRunNaFaseLi(db, [
      { contaId: 'C1', depositoId: 'dep-1', entradas: { '100': v('a', 1) } },
      { contaId: 'C2', depositoId: 'dep-1', entradas: { '100': v('b', 1) } },
    ]);
    const p = criarPlataformaEscritaLi({ estoque: [linhaEstoqueLi(100, { quantidade: 1 })] });
    p.fila.push(naProxima(CAMINHO_LISTA_ESTOQUE_LI, 'GET', () => respostaJson(503, {})));
    const m = mundo(p);
    const r = await despacharReconcileEstoqueLi(
      asDb(db),
      tarefa(5),
      m.deps({ tentativa: TASK_MAX_ATTEMPTS - 1 }),
    );
    expect(r).toEqual({ kind: 'encerrado' });
    const contadores = db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores as Record<string, number>;
    expect(contadores).toMatchObject({ c0TentativasEsgotadas: 1, c1ListaCompleta: 1, c1EmDia: 1 });
    expect(contadores.c0ListaCompleta).toBeUndefined();
    expect(m.log.linhas.filter((l) => l.nivel === 'error').map((l) => l.meta.contaId)).toEqual([
      'C1',
    ]);
  });

  it('the read switch off: every conta skipped in ONE slice, zero calls, the lease released', async () => {
    const db = new FakeDb();
    for (const conta of ['C1', 'C2']) {
      seedContaComDeposito(db, conta, refDeposito('dep-1'), { nome: conta });
      seedCredencial(db, conta);
    }
    seedRunNaFaseLi(db, [
      { contaId: 'C1', depositoId: 'dep-1' },
      { contaId: 'C2', depositoId: 'dep-1' },
    ]);
    const p = criarPlataformaEscritaLi();
    const m = mundo(p, { chamadas: 'off' });
    expect(await despacharReconcileEstoqueLi(asDb(db), tarefa(5), m.deps())).toEqual({
      kind: 'encerrado',
    });
    expect(p.requisicoes).toEqual([]);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)).toMatchObject({
      emExecucaoAteMs: 0,
      contadores: { c0ChamadasDesligadas: 1, c1ChamadasDesligadas: 1 },
    });
    expect(m.sink.linhas.filter((l) => l.campos.evento === 'chamada-bloqueada')).toHaveLength(2);
  });
});

describe('a whole run, the ERP walk then the store’s list', () => {
  it('the snapshot the walk wrote is what the list is diffed against: one row out of step ⇒ one INFO diff line; an unlinked row cached `x`', async () => {
    const db = new FakeDb();
    seedContaComDeposito(db, 'C1', refDeposito('dep-1'));
    seedCredencial(db, 'C1');
    for (const [produto, id, q] of [
      ['a1', 1, 3],
      ['a2', 2, 4],
    ] as const) {
      seedProduto(db, produto);
      seedLinkFilho(db, produto, 'l1', 'C1', id);
      seedRegistro(db, produto, 'dep-1', q);
    }
    const p = criarPlataformaEscritaLi({
      estoque: [
        linhaEstoqueLi(1, { quantidade: 3 }),
        linhaEstoqueLi(2, { quantidade: 9 }),
        linhaEstoqueLi(77, { quantidade: 0 }),
      ],
    });
    const m = mundo(p);
    const resultados = await encadear(db, m, 0);
    expect(resultados.at(-1)).toEqual({ kind: 'encerrado' });
    const diffs = m.log.linhas.filter((l) => l.msg.includes('diferença'));
    expect(diffs.map((l) => [l.meta.idLi, l.meta.produtoId, l.meta.S, l.meta.d])).toEqual([
      ['2', 'a2', 4, 5],
    ]);
    expect(
      (db.ler('sincEstoqueLojaIntegrada/C1/snapshot/13')?.e as Record<string, unknown>)['77'],
    ).toEqual({ p: null, s: null, f: 'x' });
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({
      c0Validos: 2,
      c0EmDia: 1,
      c0SemVinculoNovos: 1,
      c0ListaCompleta: 1,
    });
    expect(db.ler('sincEstoqueLojaIntegrada/C1')?.execucao).toMatchObject({
      vistos: ['1', '2', '77'],
    });
    expect(INICIO_RUN_RECONCILE_MS).toBeLessThan(AGORA_RECONCILE_MS);
  });
});
