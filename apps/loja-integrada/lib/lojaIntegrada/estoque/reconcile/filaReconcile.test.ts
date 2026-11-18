/**
 * `filaReconcile.ts` (master plan step 12, PR 12-g): the daily reconcile's QUEUE phase inside the
 * slice machine — over-advertising first, ONE reservation of exactly each batch's size on the global
 * slot, the run's own window naming every send, a retried slice re-meeting its own sends, the
 * backlog horizon, the slot exhausted, the canary, the safety gate's 5% boundary, a conta whose
 * depósito moved mid-run, the valve (a dry-run enqueues NOTHING) — against `testing/fakeDb.ts` and
 * the REAL stock producer over a recording transport. No Loja Integrada call: `fetch` throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import {
  type CandidatoReconcileEstoqueLi,
  type EntradaSnapshotEstoqueLi,
  FLAG_ENTRADA_ESTOQUE_LI,
  ORIGEM_TAREFA_ESTOQUE_LI,
  TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  type TarefaEstoqueLi,
} from '@delfrance/schemas';

import { CANARIO_ENV_LI, VALVULA_ENV_LI } from '../../core/valvulas';
import { FakeDb, asDb } from '../../testing/fakeDb';
import { falhaDoFunctions } from '../../testing/falhaDeEnfileiramento';
import {
  AGORA_RECONCILE_MS,
  CAMINHO_RUN_RECONCILE_LI,
  INICIO_RUN_RECONCILE_MS,
  RUN_A,
  agendadorGravador,
  filaEstoqueGravadora,
  loggerGravador,
  refDeposito,
  seedContaComDeposito,
  seedRunNaFaseLi,
} from '../../testing/reconcileEstoqueLi';
import { idDaTarefaEstoqueLi, janelaEstoqueLi } from '../agendadorEstoque';
import { DELTA_SEM_LIMITE_LI } from '../planoEstoqueLi';
import {
  INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS,
  LIMITE_AGENDAMENTO_SLOT_ESTOQUE_LI_MS,
  pisoDoSlotEstoqueLi,
  reservarSlotGlobalEstoqueLi,
} from '../slotEstoqueLi';
import { type DepsReconcileEstoqueLi, despacharReconcileEstoqueLi } from './despachoReconcile';
import {
  HORIZONTE_SUBANUNCIO_RECONCILE_LI_MS,
  LIMITE_PERCENTUAL_SEM_REGISTRO_RECONCILE_LI,
  LOTE_FILA_RECONCILE_LI,
  depositoSemRegistrosLi,
} from './filaReconcile';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('filaReconcile.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const I = INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS;
const tarefa = (seq: number) => ({
  tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  execucaoId: RUN_A,
  seq,
});
const v = (p: string, s: number, extra: Partial<EntradaSnapshotEstoqueLi> = {}) => ({
  p,
  s,
  f: FLAG_ENTRADA_ESTOQUE_LI.valido,
  ...extra,
});

/** Two contas (C1 at dep-1, C2 at dep-2) at the QUEUE phase, with `candidatos` and counters. */
function emFila(
  candidatos: readonly CandidatoReconcileEstoqueLi[],
  o: {
    readonly contadores?: Readonly<Record<string, number>>;
    readonly proximoSlotMs?: number;
    readonly entradas?: Readonly<Record<string, EntradaSnapshotEstoqueLi>>;
  } = {},
) {
  const db = new FakeDb();
  seedContaComDeposito(db, 'C1', refDeposito('dep-1'), { nome: 'a' });
  seedContaComDeposito(db, 'C2', `depositos/dep-2`, { nome: 'b' });
  seedRunNaFaseLi(
    db,
    [
      { contaId: 'C1', depositoId: 'dep-1', entradas: o.entradas ?? {} },
      { contaId: 'C2', depositoId: 'dep-2' },
    ],
    {
      fase: 'fila',
      idxConta: 2,
      candidatos: [...candidatos],
      contadores: { ...(o.contadores ?? {}) },
      ...(o.proximoSlotMs === undefined ? {} : { proximoSlotMs: o.proximoSlotMs }),
    },
  );
  return db;
}

/** One slice's world: the clock, both producers, the logs, the valve (`on` with `*` by default). */
function mundo(
  o: {
    readonly modo?: string;
    readonly canario?: string;
    readonly estoque?: ReturnType<typeof filaEstoqueGravadora>;
    readonly tentativa?: number;
  } = {},
) {
  const relogio = { agora: AGORA_RECONCILE_MS };
  const fila = agendadorGravador();
  const estoque = o.estoque ?? filaEstoqueGravadora();
  const log = loggerGravador();
  const deps = (extra: Partial<DepsReconcileEstoqueLi> = {}): DepsReconcileEstoqueLi => ({
    ambiente: {
      [VALVULA_ENV_LI.estoque]: o.modo ?? 'on',
      [CANARIO_ENV_LI.estoque]: o.canario ?? '*',
    },
    agoraMs: () => relogio.agora,
    inicioMs: relogio.agora,
    tentativa: o.tentativa ?? 0,
    idTarefa: null,
    esperar: () => Promise.resolve(),
    increment: (by) => ({ __increment: by }),
    agendador: () => fila.agendador,
    agendadorEstoque: () => estoque.agendador,
    logger: log.logger,
    escrever: () => undefined,
    ...extra,
  });
  return { relogio, fila, estoque, log, deps };
}

/** Runs slices from `seq` until one does not hand off. */
async function encadear(db: FakeDb, m: ReturnType<typeof mundo>, seq = 5) {
  const resultados = [];
  let atual = seq;
  for (let n = 0; n < 40; n += 1) {
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

const J_RUN = janelaEstoqueLi(INICIO_RUN_RECONCILE_MS);
const nome = (contaId: string, produtoId: string) =>
  idDaTarefaEstoqueLi({
    origem: ORIGEM_TAREFA_ESTOQUE_LI.reconcile,
    contaId,
    produtoId,
    apagado: false,
    janela: J_RUN,
  });

describe('the safety gate (pure)', () => {
  it(`⚠️ NEAR-MISS at the boundary: 5 of 100 passes, 6 of 100 blocks (more than ${String(LIMITE_PERCENTUAL_SEM_REGISTRO_RECONCILE_LI)}%)`, () => {
    expect(depositoSemRegistrosLi({ avaliados: 100, zeroPorDeposito: 5 })).toBe(false);
    expect(depositoSemRegistrosLi({ avaliados: 100, zeroPorDeposito: 6 })).toBe(true);
    expect(depositoSemRegistrosLi({ avaliados: 20, zeroPorDeposito: 1 })).toBe(false);
    expect(depositoSemRegistrosLi({ avaliados: 19, zeroPorDeposito: 1 })).toBe(true);
    expect(depositoSemRegistrosLi({ avaliados: 0, zeroPorDeposito: 0 })).toBe(false);
  });
});

describe('the queue phase under on', () => {
  it('⚠️ over-advertising FIRST (d descending), each scheduled EXACTLY at its reserved instant, named by the RUN’s window; the slot advances by exactly 3 × 17 s', async () => {
    const db = emFila([
      { c: 1, i: '30', p: 'p30', d: -2 },
      { c: 0, i: '10', p: 'p10', d: 5 },
      { c: 0, i: '20', p: 'p20', d: DELTA_SEM_LIMITE_LI },
    ]);
    const m = mundo();

    const r = await encadear(db, m);

    expect(r.at(-1)).toEqual({ kind: 'encerrado' });
    const piso = pisoDoSlotEstoqueLi(AGORA_RECONCILE_MS);
    expect(
      m.estoque.enviadas.map((e) => [
        (e.tarefa as TarefaEstoqueLi).produtoId,
        e.scheduleTime.getTime(),
      ]),
    ).toEqual([
      ['p20', piso],
      ['p10', piso + I],
      ['p30', piso + 2 * I],
    ]);
    expect(m.estoque.enviadas.map((e) => e.id)).toEqual([
      nome('C1', 'p20'),
      nome('C1', 'p10'),
      nome('C2', 'p30'),
    ]);
    for (const e of m.estoque.enviadas) {
      expect(e.tarefa).toMatchObject({
        origem: ORIGEM_TAREFA_ESTOQUE_LI.reconcile,
        janela: J_RUN,
        estoqueId: null,
        apagado: false,
        geracao: 0,
      });
    }
    // Exactly what was enqueued, never more: two batches (over, then under), two reservations.
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.proximoSlotMs).toBe(piso + 3 * I);
    const reservas = db.escritas.filter(
      (e) =>
        e.caminho === CAMINHO_RUN_RECONCILE_LI &&
        Object.keys(e.dados ?? {}).join() === 'proximoSlotMs',
    );
    expect(reservas).toHaveLength(2);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)).toMatchObject({
      candidatos: [],
      emExecucaoAteMs: 0,
      contadores: { c0Enfileirados: 2, c1Enfileirados: 1, filaIniciada: 1 },
    });
  });

  it('a retried slice re-meets its own sends by NAME (already-exists = success) and the list ends empty', async () => {
    const candidatos = [
      { c: 0, i: '10', p: 'p10', d: 5 },
      { c: 0, i: '11', p: 'p11', d: 4 },
    ];
    // The first attempt's transport accepted both, then the slice failed before its checkpoint.
    const estoque = filaEstoqueGravadora();
    const primeiro = emFila(candidatos);
    await encadear(primeiro, mundo({ estoque }));
    expect(estoque.enviadas).toHaveLength(2);
    // A second run of the SAME slice (same run, same seq) against a fresh copy of the state.
    const db = emFila(candidatos);
    const r = await encadear(db, mundo({ estoque }));
    expect(r.at(-1)).toEqual({ kind: 'encerrado' });
    expect(estoque.enviadas).toHaveLength(2);
    expect(estoque.tentativas).toEqual([
      nome('C1', 'p10'),
      nome('C1', 'p11'),
      nome('C1', 'p10'),
      nome('C1', 'p11'),
    ]);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({ c0Enfileirados: 2 });
  });

  it(`batches of at most ${String(LOTE_FILA_RECONCILE_LI)}: 230 over-advertising rows ⇒ 3 reservations (100 + 100 + 30), the slot advanced by exactly 230 × 17 s`, async () => {
    const candidatos = Array.from({ length: 230 }, (_, k) => ({
      c: 0,
      i: String(1000 + k),
      p: `p${String(k)}`,
      d: 1 + k,
    }));
    const db = emFila(candidatos);
    const m = mundo();
    await encadear(db, m);
    const piso = pisoDoSlotEstoqueLi(AGORA_RECONCILE_MS);
    expect(m.estoque.enviadas).toHaveLength(230);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.proximoSlotMs).toBe(piso + 230 * I);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({ reservasSlot: 3 });
  });

  it('a kit candidate carries its components’ record ids from its snapshot entry (`e`); a plain child carries none', async () => {
    const db = emFila(
      [
        { c: 0, i: '50', p: 'kit', d: 3 },
        { c: 0, i: '51', p: 'p51', d: 2 },
      ],
      {
        entradas: {
          '50': v('kit', 0, {
            k: true,
            q: { blank: 1, print: 2 },
            e: { blank: 'est-blank-dep-1', print: null },
          }),
          '51': v('p51', 1),
        },
      },
    );
    const m = mundo();
    await encadear(db, m);
    expect(
      m.estoque.enviadas.map((e) => [
        (e.tarefa as TarefaEstoqueLi).produtoId,
        (e.tarefa as TarefaEstoqueLi).estoqueIds,
      ]),
    ).toEqual([
      ['kit', { blank: 'est-blank-dep-1', print: null }],
      ['p51', null],
    ]);
  });

  it('the canary: a list naming only C1’s store id 10 ⇒ C2’s candidate is NOT enqueued (counted foraDoCanario)', async () => {
    const db = emFila([
      { c: 0, i: '10', p: 'p10', d: 5 },
      { c: 1, i: '30', p: 'p30', d: 5 },
    ]);
    const m = mundo({ canario: 'C1:10' });
    await encadear(db, m);
    expect(m.estoque.enviadas.map((e) => (e.tarefa as TarefaEstoqueLi).produtoId)).toEqual(['p10']);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({ c1ForaDoCanario: 1 });
  });
});

describe('the backlog horizon and the slot', () => {
  it(`⚠️ NEAR-MISS: an under-advertising row whose instant lands EXACTLY at now + ${String(HORIZONTE_SUBANUNCIO_RECONCILE_LI_MS / 3_600_000)} h is enqueued; 1 ms later it is DEFERRED (counted, never sent); over-advertising goes regardless`, async () => {
    const H = HORIZONTE_SUBANUNCIO_RECONCILE_LI_MS;
    // The over row takes the stored slot; the under row the next instant, exactly at now + H.
    const exato = emFila(
      [
        { c: 0, i: '10', p: 'over', d: 9 },
        { c: 0, i: '11', p: 'under', d: -1 },
      ],
      { proximoSlotMs: AGORA_RECONCILE_MS + H - I },
    );
    const m1 = mundo();
    await encadear(exato, m1);
    expect(m1.estoque.enviadas.map((e) => (e.tarefa as TarefaEstoqueLi).produtoId)).toEqual([
      'over',
      'under',
    ]);
    expect(m1.estoque.enviadas[1]?.scheduleTime.getTime()).toBe(AGORA_RECONCILE_MS + H);

    const umMsDepois = emFila(
      [
        { c: 0, i: '10', p: 'over', d: 9 },
        { c: 0, i: '11', p: 'under', d: -1 },
      ],
      { proximoSlotMs: AGORA_RECONCILE_MS + H - I + 1 },
    );
    const m2 = mundo();
    await encadear(umMsDepois, m2);
    expect(m2.estoque.enviadas.map((e) => (e.tarefa as TarefaEstoqueLi).produtoId)).toEqual([
      'over',
    ]);
    expect(umMsDepois.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({
      c0AdiadosHorizonte: 1,
      c0Enfileirados: 1,
    });
  });

  it('⚠️ NEAR-MISS: a row with d = 0 is NOT over-advertising — it waits on the horizon like d < 0', async () => {
    const db = emFila([{ c: 0, i: '10', p: 'zero', d: 0 }], {
      proximoSlotMs: AGORA_RECONCILE_MS + HORIZONTE_SUBANUNCIO_RECONCILE_LI_MS + 1,
    });
    const m = mundo();
    await encadear(db, m);
    expect(m.estoque.enviadas).toEqual([]);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({ c0AdiadosHorizonte: 1 });
  });

  it('the slot EXHAUSTED (a reservation past the schedule limit) ⇒ nothing enqueued, ONE ERROR, the rest counted', async () => {
    const db = emFila(
      [
        { c: 0, i: '10', p: 'p10', d: 9 },
        { c: 1, i: '30', p: 'p30', d: 8 },
      ],
      { proximoSlotMs: AGORA_RECONCILE_MS + LIMITE_AGENDAMENTO_SLOT_ESTOQUE_LI_MS },
    );
    const m = mundo();
    const r = await encadear(db, m);
    expect(r.at(-1)).toEqual({ kind: 'encerrado' });
    expect(m.estoque.enviadas).toEqual([]);
    expect(
      m.log.linhas.filter((l) => l.nivel === 'error' && l.meta.motivo === 'slot-esgotado'),
    ).toHaveLength(1);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({
      c0SlotEsgotado: 1,
      c1SlotEsgotado: 1,
    });
  });
});

describe('the gate, the contas read again, and the valve', () => {
  it('⚠️ the gate trips for C1 (6 of 100) ⇒ ONE ERROR, NONE of C1’s candidates enqueued; C2 (5 of 100) is unaffected', async () => {
    const db = emFila(
      [
        { c: 0, i: '10', p: 'p10', d: 5 },
        { c: 1, i: '30', p: 'p30', d: 5 },
      ],
      {
        contadores: {
          c0Avaliados: 100,
          c0ZeroPorDeposito: 6,
          c1Avaliados: 100,
          c1ZeroPorDeposito: 5,
        },
      },
    );
    const m = mundo();
    await encadear(db, m);
    expect(m.estoque.enviadas.map((e) => (e.tarefa as TarefaEstoqueLi).produtoId)).toEqual(['p30']);
    const erros = m.log.linhas.filter((l) => l.meta.motivo === 'deposito-sem-registros');
    expect(erros).toHaveLength(1);
    expect(erros[0]).toMatchObject({ nivel: 'error', meta: { contaId: 'C1' } });
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({
      c0BloqueadoDeposito: 1,
      c0CandidatosBloqueados: 1,
    });
  });

  it('the store phase’s own block (bloqueioForaDoSnapshot) blocks the conta the same way', async () => {
    const db = emFila([{ c: 0, i: '10', p: 'p10', d: 5 }], {
      contadores: { c0BloqueioForaDoSnapshot: 1 },
    });
    const m = mundo();
    await encadear(db, m);
    expect(m.estoque.enviadas).toEqual([]);
  });

  it('⚠️ C1’s depósito moved between the store phase and the queue ⇒ 0 sends for C1 (ONE WARNING), C2 unaffected; after the release ONE full run is enqueued', async () => {
    const db = emFila([
      { c: 0, i: '10', p: 'p10', d: 5 },
      { c: 1, i: '30', p: 'p30', d: 5 },
    ]);
    seedContaComDeposito(db, 'C1', refDeposito('dep-9'), { nome: 'a' });
    const m = mundo();
    const r = await encadear(db, m);
    expect(r.at(-1)).toEqual({ kind: 'encerrado' });
    expect(m.estoque.enviadas.map((e) => (e.tarefa as TarefaEstoqueLi).produtoId)).toEqual(['p30']);
    expect(
      m.log.linhas.filter((l) => l.nivel === 'warn' && l.meta.motivo === 'deposito-mudou'),
    ).toHaveLength(1);
    // The depósito re-run: one seq-0 task of a new run, after the release.
    const novas = m.fila.enfileirados.filter((e) => e.execucaoId !== RUN_A);
    expect(novas).toHaveLength(1);
    expect(novas[0]?.execucaoId).toMatch(/^estoque-reconcile-redeposito-\d+$/);
    expect(novas[0]).toMatchObject({ seq: 0, atrasoS: 0 });
  });

  it('⚠️ NEAR-MISS: the depósito stored in the OTHER form (documents/depositos/dep-2 for depositos/dep-2) is the SAME depósito — sent, no re-run', async () => {
    const db = emFila([{ c: 1, i: '30', p: 'p30', d: 5 }]);
    seedContaComDeposito(db, 'C2', refDeposito('dep-2'), { nome: 'b' });
    const m = mundo();
    await encadear(db, m);
    expect(m.estoque.enviadas.map((e) => (e.tarefa as TarefaEstoqueLi).produtoId)).toEqual(['p30']);
    expect(m.fila.enfileirados.filter((e) => e.execucaoId !== RUN_A)).toEqual([]);
  });

  it('⚠️ DRY-RUN ENQUEUES NOTHING: no send, no slot write, one summary line per conta, the list cleared — the gate still logs', async () => {
    const db = emFila(
      [
        { c: 0, i: '10', p: 'p10', d: 5 },
        { c: 1, i: '30', p: 'p30', d: -1 },
      ],
      { contadores: { c1Avaliados: 10, c1ZeroPorDeposito: 9 } },
    );
    const m = mundo({ modo: 'dry-run' });
    const r = await encadear(db, m);
    expect(r.at(-1)).toEqual({ kind: 'encerrado' });
    expect(m.estoque.tentativas).toEqual([]);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.proximoSlotMs ?? null).toBeNull();
    expect(
      db.escritas.filter((e) => Object.keys(e.dados ?? {}).join() === 'proximoSlotMs'),
    ).toEqual([]);
    const resumos = m.log.linhas.filter((l) => l.msg.endsWith('fila da conta'));
    expect(
      resumos.map((l) => [l.meta.contaId, l.meta.candidatos, l.meta.acima, l.meta.demais]),
    ).toEqual([
      ['C1', 1, 1, 0],
      ['C2', 1, 0, 1],
    ]);
    expect(
      m.log.linhas.filter((l) => l.nivel === 'error' && l.meta.motivo === 'deposito-sem-registros'),
    ).toHaveLength(1);
    // …and the end phase, with no aviso under dry-run, says it as ONE info line (count, sample).
    expect(
      m.log.linhas.filter((l) => l.nivel === 'info' && l.meta.motivo === 'deposito-sem-registros'),
    ).toHaveLength(1);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.candidatos).toEqual([]);
    // ⚠️ The valve itself decides, before any per-target filter: a dry-run never reaches the
    // canary (the send run's `decidirAlvo` would only dry-run them too — a second layer, not the
    // rule), so nothing is counted out of the canary and no queue-phase re-read is made.
    const contadores = db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores ?? {};
    expect(contadores).not.toHaveProperty('c0ForaDoCanario');
    expect(contadores).not.toHaveProperty('c1ForaDoCanario');
    expect(resumos.map((l) => l.meta.foraDoCanario)).toEqual([0, 0]);
  });
});

describe('the queue phase’s failures', () => {
  it('a transient Cloud Tasks failure: the batch finishes, the slice checkpoints what landed at the SAME seq, then rethrows; the retry sends only the rest', async () => {
    let falhar = true;
    const estoque = filaEstoqueGravadora({
      falhar: (t) =>
        falhar && (t as TarefaEstoqueLi).produtoId === 'p11'
          ? falhaDoFunctions('unknown-error')
          : null,
    });
    const db = emFila([
      { c: 0, i: '10', p: 'p10', d: 5 },
      { c: 0, i: '11', p: 'p11', d: 4 },
    ]);
    const m = mundo({ estoque });
    await expect(despacharReconcileEstoqueLi(asDb(db), tarefa(5), m.deps())).rejects.toBeInstanceOf(
      Error,
    );
    const run = db.ler(CAMINHO_RUN_RECONCILE_LI);
    expect(run?.seq).toBe(5);
    expect(run?.candidatos).toEqual([{ c: 0, i: '11', p: 'p11', d: 4 }]);
    falhar = false;
    const r = await encadear(db, m, 5);
    expect(r.at(-1)).toEqual({ kind: 'encerrado' });
    expect(estoque.enviadas.map((e) => (e.tarefa as TarefaEstoqueLi).produtoId)).toEqual([
      'p10',
      'p11',
    ]);
  });

  it(`on the queue’s LAST attempt a transient failure ends the queue phase: the rest counted naoEnfileirados (one ERROR), the run goes to its end`, async () => {
    const estoque = filaEstoqueGravadora({ falhar: () => falhaDoFunctions('unknown-error') });
    const db = emFila([{ c: 0, i: '10', p: 'p10', d: 5 }]);
    const m = mundo({ estoque, tentativa: TASK_MAX_ATTEMPTS - 1 });
    const r = await encadear(db, m);
    expect(r.at(-1)).toEqual({ kind: 'encerrado' });
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({ c0NaoEnfileirados: 1 });
    expect(
      m.log.linhas.filter((l) => l.nivel === 'error' && l.meta.motivo === 'tentativas-esgotadas'),
    ).toHaveLength(1);
  });

  it('the sweep-only valve closed ⇒ ONE WARNING, nothing sent, the list dropped and counted; the run ends', async () => {
    const estoque = filaEstoqueGravadora({ desligado: true });
    const db = emFila([
      { c: 0, i: '10', p: 'p10', d: 5 },
      { c: 1, i: '30', p: 'p30', d: 5 },
    ]);
    const m = mundo({ estoque });
    const r = await encadear(db, m);
    expect(r.at(-1)).toEqual({ kind: 'encerrado' });
    expect(estoque.enviadas).toEqual([]);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({
      c0NaoEnfileirados: 1,
      c1NaoEnfileirados: 1,
    });
  });

  it('⚠️ the kit fan-out moves the slot under the slice (between its reservation and its checkpoint): the checkpoint re-applies, the slot keeps BOTH reservations', async () => {
    const db = emFila([{ c: 0, i: '10', p: 'p10', d: 5 }]);
    const m = mundo();
    // 1st write of the run document: the queue phase's own reservation — let it land.
    db.antesDaProximaEscrita(CAMINHO_RUN_RECONCILE_LI, () => undefined);
    // 2nd: the slice's checkpoint — the fan-out's writer lands first, on the same document.
    db.antesDaProximaEscrita(CAMINHO_RUN_RECONCILE_LI, async () => {
      await reservarSlotGlobalEstoqueLi(asDb(db), {
        quantidade: 1,
        agoraMs: () => AGORA_RECONCILE_MS,
      });
    });

    const r = await despacharReconcileEstoqueLi(asDb(db), tarefa(5), m.deps());

    expect(r).toEqual({ kind: 'encerrado' });
    const piso = pisoDoSlotEstoqueLi(AGORA_RECONCILE_MS);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)).toMatchObject({
      proximoSlotMs: piso + 2 * I,
      seq: 6,
      emExecucaoAteMs: 0,
      candidatos: [],
    });
  });
});
