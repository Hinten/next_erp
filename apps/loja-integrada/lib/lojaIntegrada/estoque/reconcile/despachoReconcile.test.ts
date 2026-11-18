/**
 * `despachoReconcile.ts` (master plan step 12, PR 12-g): one slice of the daily stock reconcile,
 * start to finish, against `testing/fakeDb.ts` and a recording reads-queue producer — the gates
 * that read nothing, the run document's decisions, the ERP phase across slices under the budget,
 * the kits map and its sweep, the end-of-slice checkpoint and the named hand-off, and the queue's
 * last attempt. No Loja Integrada call anywhere: the global `fetch` throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import { FLAG_ENTRADA_ESTOQUE_LI, TIPO_TAREFA_RECONCILE_ESTOQUE_LI } from '@delfrance/schemas';

import { FakeDb, asDb, grpc } from '../../testing/fakeDb';
import {
  AGORA_RECONCILE_MS,
  RUN_A,
  RUN_B,
  agendadorGravador,
  componentesDoKit,
  loggerGravador,
  seedContaComDeposito,
  seedLinkFilho,
  seedProduto,
  seedRegistro,
} from '../../testing/reconcileEstoqueLi';
import { LiTarefasDesligadasError, LiTarefasTransitoriasError } from './agendadorReconcile';
import {
  LEASE_RECONCILE_ESTOQUE_LI_MS,
  LiReconcileEstoqueAdiadoError,
  refRunReconcileLi,
} from './execucaoReconcile';
import { type DepsReconcileEstoqueLi, despacharReconcileEstoqueLi } from './despachoReconcile';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('despachoReconcile.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const RUN_PATH = 'reconcileEstoqueLojaIntegrada/atual';
const tarefa = (seq: number, execucaoId = RUN_A) => ({
  tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  execucaoId,
  seq,
});

/** One slice's world: a clock the test moves, the recording producer and logger. */
function mundo(over: Partial<DepsReconcileEstoqueLi> = {}, falha?: () => unknown) {
  const relogio = { agora: AGORA_RECONCILE_MS };
  const fila = agendadorGravador(falha);
  const log = loggerGravador();
  const deps = (extra: Partial<DepsReconcileEstoqueLi> = {}): DepsReconcileEstoqueLi => ({
    ambiente: { LOJA_INTEGRADA_MODO_ESTOQUE: 'dry-run' },
    agoraMs: () => relogio.agora,
    inicioMs: relogio.agora,
    tentativa: 0,
    agendador: () => fila.agendador,
    logger: log.logger,
    tamanhoPaginaCaminhada: 2,
    ...over,
    ...extra,
  });
  return { relogio, fila, log, deps };
}

/** Two contas, three plain children and a kit, a parent, a duplicate across pages. */
function semearCatalogo(db: FakeDb): void {
  seedContaComDeposito(db, 'C1', 'documents/depositos/dep-1', { nome: 'a' });
  seedContaComDeposito(db, 'C2', 'depositos/dep-2', { nome: 'b' });
  seedContaComDeposito(db, 'C3', null, { nome: 'c' });
  seedContaComDeposito(db, 'C4', 'documents/depositos/dep-4', { nome: 'd', ativo: false });
  // C1: two children, one kit (blank + print), a parent, and store id 7 on TWO produtos.
  for (const [p, id, q] of [
    ['a1', 1, 3],
    ['a2', 2, 4],
  ] as const) {
    seedProduto(db, p);
    seedLinkFilho(db, p, 'l1', 'C1', id);
    seedRegistro(db, p, 'dep-1', q);
  }
  seedProduto(db, 'kit', { ehKit: true, componentesKit: componentesDoKit({ blank: 1, print: 2 }) });
  seedLinkFilho(db, 'kit', 'l1', 'C1', 50);
  seedRegistro(db, 'blank', 'dep-1', 5);
  seedRegistro(db, 'print', 'dep-1', 6);
  seedLinkFilho(db, 'paiP', 'l1', 'C1', 900, { paiProdutoIntegradaId: null, grades: [1] });
  seedProduto(db, 'd1');
  seedLinkFilho(db, 'd1', 'l1', 'C1', 7);
  seedRegistro(db, 'd1', 'dep-1', 1);
  seedProduto(db, 'z9');
  seedLinkFilho(db, 'z9', 'l1', 'C1', 7);
  seedRegistro(db, 'z9', 'dep-1', 1);
  // C2: one child, its record at C2's depósito in the bare form.
  seedProduto(db, 'b1');
  seedLinkFilho(db, 'b1', 'l1', 'C2', 8, { contaLojaIntegrada: 'integracao/C2' });
  seedRegistro(db, 'b1', 'dep-2', 9, { depositoOuterRef: 'depositos/dep-2' });
  // A stale header of an older run, for a component in no kit any more.
  db.seed('sincEstoqueLojaIntegrada/C1/kits/velho', { execucaoId: RUN_B, F: 1 });
}

/** Runs slices, each handing off to the next, until one does not (a fresh budget each). */
async function encadear(db: FakeDb, m: ReturnType<typeof mundo>, primeira = 0) {
  const resultados = [];
  let seq = primeira;
  for (let n = 0; n < 40; n += 1) {
    const r = await despacharReconcileEstoqueLi(
      asDb(db),
      tarefa(seq),
      m.deps({ inicioMs: m.relogio.agora }),
    );
    resultados.push(r);
    if (r.kind !== 'continua') return resultados;
    seq = r.seq;
    m.relogio.agora += 2_000;
  }
  throw new Error('a cadeia não terminou');
}

describe('the gates that read NOTHING', () => {
  it('a payload off its schema, the valve off, an unreadable cap: zero reads, zero writes, zero enqueues', async () => {
    const db = new FakeDb();
    const m = mundo();
    expect(
      await despacharReconcileEstoqueLi(
        asDb(db),
        { tipo: 'estoque-reconcile', execucaoId: 'a b', seq: 0 },
        m.deps(),
      ),
    ).toEqual({
      kind: 'payload-invalido',
    });
    expect(
      await despacharReconcileEstoqueLi(asDb(db), tarefa(0), m.deps({ ambiente: {} })),
    ).toEqual({
      kind: 'desligado',
    });
    expect(
      await despacharReconcileEstoqueLi(
        asDb(db),
        tarefa(0),
        m.deps({
          ambiente: { LOJA_INTEGRADA_MODO_ESTOQUE: 'on', LOJA_INTEGRADA_ESTOQUE_MAX: '0' },
        }),
      ),
    ).toEqual({ kind: 'teto-invalido' });
    expect(m.log.linhas.filter((l) => l.nivel === 'error')).toHaveLength(1);
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
    expect(db.escritas).toEqual([]);
    expect(m.fila.enfileirados).toEqual([]);
  });
});

describe('the run document decides', () => {
  const emCurso = (db: FakeDb, over: Record<string, unknown> = {}) => {
    db.seed(RUN_PATH, {
      execucaoId: RUN_A,
      iniciadoEmMs: AGORA_RECONCILE_MS - 600_000,
      emExecucaoAteMs: AGORA_RECONCILE_MS + 60_000,
      seq: 4,
      fase: 'erp',
      contas: [],
      ...over,
    });
  };

  it('a stale slice: ONE read of the run document, nothing written or enqueued', async () => {
    const db = new FakeDb();
    emCurso(db);
    const m = mundo();
    expect(await despacharReconcileEstoqueLi(asDb(db), tarefa(2), m.deps())).toEqual({
      kind: 'nada',
    });
    expect(db.leituras).toEqual([RUN_PATH]);
    expect(db.escritas).toEqual([]);
    expect(m.fila.enfileirados).toEqual([]);
  });

  it('the repair: one seq behind with the lease held ⇒ the stored seq re-enqueued at 60 s, nothing written', async () => {
    const db = new FakeDb();
    emCurso(db);
    const m = mundo();
    expect(await despacharReconcileEstoqueLi(asDb(db), tarefa(3), m.deps())).toEqual({
      kind: 'continuacao',
      seq: 4,
    });
    expect(m.fila.enfileirados).toEqual([{ execucaoId: RUN_A, seq: 4, atrasoS: 60 }]);
    expect(db.leituras).toEqual([RUN_PATH]);
    expect(db.escritas).toEqual([]);
  });

  it('a new run while another runs (< 48 h): ocupado — one read, one INFO, nothing else', async () => {
    const db = new FakeDb();
    emCurso(db);
    const m = mundo();
    expect(await despacharReconcileEstoqueLi(asDb(db), tarefa(0, RUN_B), m.deps())).toEqual({
      kind: 'ocupado',
    });
    expect(db.leituras).toEqual([RUN_PATH]);
    expect(db.escritas).toEqual([]);
    expect(m.log.linhas.map((l) => l.nivel)).toEqual(['info']);
  });

  it('a new run in the minute window the stored one started in: a retryable throw', async () => {
    const db = new FakeDb();
    emCurso(db, { emExecucaoAteMs: 0, iniciadoEmMs: AGORA_RECONCILE_MS });
    await expect(
      despacharReconcileEstoqueLi(asDb(db), tarefa(0, RUN_B), mundo().deps()),
    ).rejects.toBeInstanceOf(LiReconcileEstoqueAdiadoError);
    expect(db.escritas).toEqual([]);
  });

  it('no active conta with a depósito: the run is taken and released at once — sem-contas, no walk', async () => {
    const db = new FakeDb();
    seedContaComDeposito(db, 'C3', null);
    const m = mundo();
    expect(await despacharReconcileEstoqueLi(asDb(db), tarefa(0), m.deps())).toEqual({
      kind: 'sem-contas',
    });
    expect(db.ler(RUN_PATH)).toMatchObject({
      execucaoId: RUN_A,
      emExecucaoAteMs: 0,
      fase: 'fim',
      seq: 1,
    });
    expect(db.consultas.filter((c) => c.grupo === true)).toEqual([]);
    expect(m.log.linhas.filter((l) => l.nivel === 'warn')).toHaveLength(1);
  });
});

describe('a whole run — the ERP phase, the kits map, the release', () => {
  it('ONE chain for every conta: the snapshot, pais, dup across pages, the kits map and its sweep, then the lease released', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const m = mundo();
    const resultados = await encadear(db, m);
    expect(resultados.at(-1)).toEqual({ kind: 'encerrado' });
    const run = db.ler(RUN_PATH) ?? {};
    expect(run).toMatchObject({
      execucaoId: RUN_A,
      fase: 'fim',
      emExecucaoAteMs: 0,
      contas: ['C1', 'C2'],
      walk: { concluida: true },
    });
    const baldeDe = (conta: string, id: string) =>
      (db.ler(`sincEstoqueLojaIntegrada/${conta}/snapshot/${id}`)?.e ?? {}) as Record<
        string,
        unknown
      >;
    expect(baldeDe('C1', '01')['1']).toEqual({ p: 'a1', s: 3, f: 'v' });
    expect(baldeDe('C1', '07')['7']).toEqual({
      p: 'd1',
      s: null,
      f: FLAG_ENTRADA_ESTOQUE_LI.duplicado,
    });
    expect(baldeDe('C1', '18')['50']).toMatchObject({ p: 'kit', s: 3, k: true });
    expect(baldeDe('C2', '08')['8']).toEqual({ p: 'b1', s: 9, f: 'v' });
    expect(db.ler('sincEstoqueLojaIntegrada/C1/snapshot/pais')).toEqual({
      execucaoId: RUN_A,
      ids: ['900'],
    });
    // All 32 buckets of each conta carry this run.
    for (const conta of ['C1', 'C2']) {
      expect(db.idsEm(`sincEstoqueLojaIntegrada/${conta}/snapshot`)).toHaveLength(33);
    }
    // The kits map: the current kit's components written, the stale header swept.
    expect(db.ler('sincEstoqueLojaIntegrada/C1/kits/blank')).toMatchObject({
      execucaoId: RUN_A,
      F: 1,
    });
    expect(db.ler('sincEstoqueLojaIntegrada/C1/kits/velho')).toBeUndefined();
    expect(db.ler('sincEstoqueLojaIntegrada/C1')).toMatchObject({
      execucao: { amostras: { duplicado: ['d1', 'z9'] }, mapa: { etapa: 'feito' } },
    });
    // Five send verdicts in C1 (two of them on one store id: a duplicate), one in C2.
    expect(run.contadores).toMatchObject({
      c0Validos: 5,
      c0Duplicados: 2,
      c0Pais: 1,
      c1Validos: 1,
    });
    // C3 (no depósito) warned once; C4 (inactive) silently out.
    expect(m.log.linhas.filter((l) => l.nivel === 'warn').map((l) => l.meta.contaId)).toEqual([
      'C3',
    ]);
    // Every hand-off named (run, seq + 1), 2 s later; the last slice hands off nothing.
    const continuas = resultados.filter((r) => r.kind === 'continua');
    expect(m.fila.enfileirados).toEqual(
      continuas.map((_, i) => ({ execucaoId: RUN_A, seq: i + 1, atrasoS: 2 })),
    );
    expect(run.seq).toBe(resultados.length);
  });

  it('⚠️ the budget: a slice with no room for a unit still checkpoints (seq + 1) and hands off — nothing else', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const m = mundo();
    // A first slice that only takes the lease: its clock is already 50 001 ms in.
    const r = await despacharReconcileEstoqueLi(
      asDb(db),
      tarefa(0),
      m.deps({ inicioMs: m.relogio.agora - 50_001 }),
    );
    expect(r).toEqual({ kind: 'continua', fase: 'erp', seq: 1 });
    expect(db.consultas.filter((c) => c.grupo === true)).toEqual([]);
    expect(db.ler(RUN_PATH)).toMatchObject({ seq: 1, walk: null });
    // NEAR-MISS: at exactly 50 000 ms one walk unit (20 s) still fits — and only one, since the
    // page itself takes 25 s.
    db.antesDaProximaConsulta('produtolojaintegrada', () => {
      m.relogio.agora += 25_000;
    });
    const r2 = await despacharReconcileEstoqueLi(
      asDb(db),
      tarefa(1),
      m.deps({ inicioMs: m.relogio.agora - 50_000 }),
    );
    expect(r2).toEqual({ kind: 'continua', fase: 'erp', seq: 2 });
    expect(db.consultas.filter((c) => c.grupo === true)).toHaveLength(1);
    expect(db.ler(RUN_PATH)).toMatchObject({
      seq: 2,
      walk: { ultimoDocPath: 'produtos/a2/produtolojaintegrada/l1', concluida: false },
    });
  });

  it('a slice spends its budget over several units and resumes where the cursor stands: each produto evaluated once', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const m = mundo();
    // Every walk page takes 25 s: three pages fit a slice (0, 25, 50 — the fourth would end at 95).
    for (let i = 0; i < 40; i += 1) {
      db.antesDaProximaConsulta('produtolojaintegrada', () => {
        m.relogio.agora += 25_000;
      });
    }
    const resultados = await encadear(db, m);
    // Seven links, two a page: four pages — three in the first slice, the last in the second,
    // which also writes the kits map and releases the lease.
    expect(resultados.map((r) => r.kind)).toEqual(['continua', 'encerrado']);
    expect(db.consultas.filter((c) => c.grupo === true)).toHaveLength(4);
    const contadores = db.ler(RUN_PATH)?.contadores as Record<string, number>;
    expect(contadores).toMatchObject({
      paginasErp: 4,
      vinculosLidos: 7,
      c0Validos: 5,
      c0Duplicados: 2,
    });
  });
});

describe('a slice and the other writers of the run document', () => {
  it('⚠️ the kit fan-out writes the slot between the slice’s read and its end checkpoint: the checkpoint lands and the slot is kept', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    db.seed(RUN_PATH, { proximoSlotMs: AGORA_RECONCILE_MS + 1 });
    const m = mundo();
    // The slice's FIRST write (the take) goes through; the fan-out lands before its second.
    db.antesDaProximaEscrita(RUN_PATH, () => undefined);
    db.antesDaProximaEscrita(RUN_PATH, async () => {
      await refRunReconcileLi(asDb(db)).update(
        { proximoSlotMs: AGORA_RECONCILE_MS + 77_000 },
        { lastUpdateTime: db.carimboDe(RUN_PATH) as never },
      );
    });
    const resultados = await encadear(db, m);
    expect(resultados.at(-1)).toEqual({ kind: 'encerrado' });
    expect(db.ler(RUN_PATH)).toMatchObject({
      proximoSlotMs: AGORA_RECONCILE_MS + 77_000,
      fase: 'fim',
    });
  });

  it('another run takes the lease mid-slice: the slice stops (parado) — no hand-off, nothing more of it written', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const m = mundo();
    db.antesDaProximaEscrita(RUN_PATH, () => undefined);
    db.antesDaProximaEscrita(RUN_PATH, async () => {
      await refRunReconcileLi(asDb(db)).update(
        { execucaoId: RUN_B, seq: 0, iniciadoEmMs: AGORA_RECONCILE_MS },
        { lastUpdateTime: db.carimboDe(RUN_PATH) as never },
      );
    });
    const r = await despacharReconcileEstoqueLi(asDb(db), tarefa(0), m.deps());
    expect(r).toEqual({ kind: 'parado' });
    expect(m.fila.enfileirados).toEqual([]);
    expect(db.ler(RUN_PATH)).toMatchObject({ execucaoId: RUN_B });
  });

  it('the sweep-only valve closed at the hand-off: the lease is released with ONE WARNING', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const m = mundo({}, () => new LiTarefasDesligadasError());
    const r = await despacharReconcileEstoqueLi(
      asDb(db),
      tarefa(0),
      m.deps({ inicioMs: m.relogio.agora - 50_001 }),
    );
    expect(r).toEqual({ kind: 'tarefas-desligadas' });
    expect(db.ler(RUN_PATH)).toMatchObject({ emExecucaoAteMs: 0, seq: 2 });
    expect(m.log.linhas.filter((l) => l.nivel === 'warn')).toHaveLength(2);
  });

  it('a transient hand-off failure is RETHROWN; the retry’s continuation check repairs it at 60 s', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const falhando = mundo(
      {},
      () => new LiTarefasTransitoriasError('FirebaseFunctionsError', 'unknown-error', 503),
    );
    await expect(
      despacharReconcileEstoqueLi(
        asDb(db),
        tarefa(0),
        falhando.deps({ inicioMs: falhando.relogio.agora - 50_001 }),
      ),
    ).rejects.toBeInstanceOf(LiTarefasTransitoriasError);
    expect(db.ler(RUN_PATH)).toMatchObject({ seq: 1 });
    const m = mundo();
    expect(
      await despacharReconcileEstoqueLi(asDb(db), tarefa(0), m.deps({ tentativa: 1 })),
    ).toEqual({
      kind: 'continuacao',
      seq: 1,
    });
    expect(m.fila.enfileirados).toEqual([{ execucaoId: RUN_A, seq: 1, atrasoS: 60 }]);
  });
});

describe('the queue’s LAST attempt', () => {
  it(`a Firestore failure in the ERP phase: rethrown before attempt ${String(TASK_MAX_ATTEMPTS)}; on it the lease is released with ONE ERROR`, async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    db.falharConsulta('produtolojaintegrada', grpc(14, 'UNAVAILABLE'));
    const m = mundo();
    await expect(despacharReconcileEstoqueLi(asDb(db), tarefa(0), m.deps())).rejects.toMatchObject({
      code: 14,
    });
    expect(db.ler(RUN_PATH)).toMatchObject({
      seq: 0,
      emExecucaoAteMs: AGORA_RECONCILE_MS + LEASE_RECONCILE_ESTOQUE_LI_MS,
    });
    const r = await despacharReconcileEstoqueLi(
      asDb(db),
      tarefa(0),
      m.deps({ tentativa: TASK_MAX_ATTEMPTS - 1 }),
    );
    expect(r).toEqual({ kind: 'tentativas-esgotadas' });
    expect(db.ler(RUN_PATH)).toMatchObject({ seq: 1, emExecucaoAteMs: 0 });
    expect(m.log.linhas.filter((l) => l.nivel === 'error').map((l) => l.meta.motivo)).toEqual([
      'tentativas-esgotadas',
    ]);
  });

  it('⚠️ NEAR-MISS: a coding bug stays loud on the last attempt too (nothing released)', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    db.falharConsulta('produtolojaintegrada', new TypeError('bug'));
    const m = mundo();
    await expect(
      despacharReconcileEstoqueLi(
        asDb(db),
        tarefa(0),
        m.deps({ tentativa: TASK_MAX_ATTEMPTS - 1 }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(db.ler(RUN_PATH)).toMatchObject({
      emExecucaoAteMs: AGORA_RECONCILE_MS + LEASE_RECONCILE_ESTOQUE_LI_MS,
    });
  });

  it('our end checkpoint LANDED behind an error: the last attempt hands off with OUR delay, never releases', async () => {
    const db = new FakeDb();
    semearCatalogo(db);
    const m = mundo();
    // The take lands; then the end checkpoint lands but surfaces a DEADLINE_EXCEEDED.
    db.antesDaProximaEscrita(RUN_PATH, () => undefined);
    db.respostaPerdidaNaProximaEscrita(RUN_PATH, grpc(4, 'DEADLINE_EXCEEDED'));
    const r = await despacharReconcileEstoqueLi(
      asDb(db),
      tarefa(0),
      m.deps({ tentativa: TASK_MAX_ATTEMPTS - 1, inicioMs: m.relogio.agora - 50_001 }),
    );
    expect(r).toEqual({ kind: 'continua', fase: 'erp', seq: 1 });
    expect(m.fila.enfileirados).toEqual([{ execucaoId: RUN_A, seq: 1, atrasoS: 2 }]);
    expect(db.ler(RUN_PATH)).toMatchObject({ seq: 1 });
  });
});
