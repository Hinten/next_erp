/**
 * `reconcileManualLi.ts` (master plan step 12, PR 12-h): the operator's reconcile — the masked
 * lease read, the 409-or-enqueue choice and the run's id. Against `testing/fakeDb.ts` and a
 * recording reads-queue producer; `fetch` throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FASE_RECONCILE_ESTOQUE_LI,
  ID_EXECUCAO_ESTOQUE_LI_REGEX,
  idTarefaReconcileEstoqueLi,
  tarefaReconcileEstoqueLiSchema,
} from '@delfrance/schemas';

import { FakeDb, asDb } from '../../testing/fakeDb';
import { falhaDoFunctions } from '../../testing/falhaDeEnfileiramento';
import {
  AGORA_RECONCILE_MS,
  CAMINHO_RUN_RECONCILE_LI,
  RUN_A,
  agendadorGravador,
} from '../../testing/reconcileEstoqueLi';
import {
  type FilaReconcileEstoqueLi,
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  criarAgendadorReconcileEstoqueLi,
} from './agendadorReconcile';
import { idDaExecucaoAgendadaLi } from './agendamentoReconcile';
import { idExecucaoRedepositoLi } from './contasReconcile';
import {
  ABANDONO_RECONCILE_ESTOQUE_LI_MS,
  LEASE_RECONCILE_ESTOQUE_LI_MS,
} from './execucaoReconcile';
import { idExecucaoDoDepositoLi } from './gatilhoDepositoLi';
import {
  PREFIXO_EXECUCAO_MANUAL_LI,
  idExecucaoManualLi,
  iniciarReconcileManualLi,
} from './reconcileManualLi';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('reconcileManualLi.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const MINUTO = Math.floor(AGORA_RECONCILE_MS / 60_000) * 60_000;
const ID_DO_MINUTO = `estoque-reconcile-manual-${String(MINUTO)}`;

function seedRun(db: FakeDb, over: Record<string, unknown> = {}): void {
  db.seed(CAMINHO_RUN_RECONCILE_LI, {
    execucaoId: RUN_A,
    iniciadoEmMs: AGORA_RECONCILE_MS - 3_600_000,
    emExecucaoAteMs: AGORA_RECONCILE_MS + LEASE_RECONCILE_ESTOQUE_LI_MS,
    seq: 3,
    fase: FASE_RECONCILE_ESTOQUE_LI.li,
    contas: ['C1'],
    idxConta: 0,
    walk: null,
    candidatos: [{ c: 0, i: '7', p: 'p1', d: 3 }],
    proximoSlotMs: null,
    contadores: {},
    ...over,
  });
}

async function iniciar(db: FakeDb, agoraMs = AGORA_RECONCILE_MS) {
  const g = agendadorGravador();
  const r = await iniciarReconcileManualLi({ db: asDb(db), agendador: () => g.agendador, agoraMs });
  return { r, g };
}

describe('idExecucaoManualLi', () => {
  it('estoque-reconcile-manual-<ms of the minute>: inside the run grammar, the same for every ms of one minute', () => {
    expect(idExecucaoManualLi(AGORA_RECONCILE_MS + 59_999)).toBe(ID_DO_MINUTO);
    expect(idExecucaoManualLi(MINUTO)).toBe(ID_DO_MINUTO);
    expect(ID_EXECUCAO_ESTOQUE_LI_REGEX.test(ID_DO_MINUTO)).toBe(true);
    expect(ID_DO_MINUTO).toHaveLength(38);
    expect(idExecucaoManualLi(MINUTO + 60_000)).not.toBe(ID_DO_MINUTO);
    expect(idExecucaoManualLi(MINUTO - 1)).not.toBe(ID_DO_MINUTO);
  });

  it('⚠️ NEAR-MISS: never the id of a nightly run, a depósito arm’s or a release’s re-run', () => {
    expect(ID_DO_MINUTO.startsWith(`${PREFIXO_EXECUCAO_MANUAL_LI}-`)).toBe(true);
    // The nightly id is digits only after the shared prefix; the other two have their own words.
    expect(idDaExecucaoAgendadaLi(AGORA_RECONCILE_MS)).toMatch(/^estoque-reconcile-\d{8}$/);
    for (const outro of [
      idDaExecucaoAgendadaLi(MINUTO),
      idExecucaoDoDepositoLi(MINUTO * 1000),
      idExecucaoRedepositoLi(MINUTO * 1000),
    ]) {
      expect(outro.startsWith(`${PREFIXO_EXECUCAO_MANUAL_LI}-`), outro).toBe(false);
      expect(outro).not.toBe(ID_DO_MINUTO);
    }
  });
});

describe('iniciarReconcileManualLi', () => {
  it('a run HOLDING the lease ⇒ em-andamento with ITS id; one masked read, nothing enqueued', async () => {
    const db = new FakeDb();
    seedRun(db);
    const getAll = vi.spyOn(db, 'getAll');

    const { r, g } = await iniciar(db);

    expect(r).toEqual({ tipo: 'em-andamento', execucaoId: RUN_A });
    expect(g.enfileirados).toEqual([]);
    expect(db.leituras).toEqual([CAMINHO_RUN_RECONCILE_LI]);
    expect(getAll.mock.calls[0]?.at(-1)).toEqual({
      fieldMask: ['execucaoId', 'seq', 'emExecucaoAteMs', 'iniciadoEmMs'],
    });
    expect(db.escritas).toEqual([]);
  });

  it('⚠️ a run that took the lease THIS minute is running, never deferred: 409, not a new run (the decision would say adiar)', async () => {
    const db = new FakeDb();
    seedRun(db, { iniciadoEmMs: MINUTO + 1 });
    const { r, g } = await iniciar(db);
    expect(r).toEqual({ tipo: 'em-andamento', execucaoId: RUN_A });
    expect(g.enfileirados).toEqual([]);
  });

  it.each([
    ['no document', null],
    ['a free lease', { emExecucaoAteMs: 0 }],
    ['an expired lease', { emExecucaoAteMs: AGORA_RECONCILE_MS - 1 }],
    [
      'a run started more than 48 h ago',
      { iniciadoEmMs: AGORA_RECONCILE_MS - ABANDONO_RECONCILE_ESTOQUE_LI_MS - 1 },
    ],
    [
      'a run released this minute (the slice will adiar, the queue retries)',
      { emExecucaoAteMs: 0, iniciadoEmMs: MINUTO },
    ],
    ['a document off its schema', { seq: -1 }],
  ])('%s ⇒ ONE enqueue: the minute’s run, seq 0, at once', async (_caso, over) => {
    const db = new FakeDb();
    if (over !== null) seedRun(db, over);

    const { r, g } = await iniciar(db);

    expect(r).toEqual({ tipo: 'enfileirado', execucaoId: ID_DO_MINUTO });
    expect(g.enfileirados).toEqual([{ execucaoId: ID_DO_MINUTO, seq: 0, atrasoS: 0 }]);
    expect(db.leituras).toEqual([CAMINHO_RUN_RECONCILE_LI]);
    expect(db.escritas).toEqual([]);
  });

  it('through the REAL producer: the payload, the task id li-<execucaoId>-0, no delay; a repeat in the same minute meets it (already-exists = the same answer)', async () => {
    const db = new FakeDb();
    const nomes = new Set<string>();
    const enviados: { tarefa: unknown; opcoes: unknown }[] = [];
    const fila: FilaReconcileEstoqueLi = {
      async enqueue(tarefa, opcoes) {
        await Promise.resolve();
        if (nomes.has(opcoes.id)) throw falhaDoFunctions('task-already-exists', 409);
        nomes.add(opcoes.id);
        enviados.push({ tarefa, opcoes });
      },
    };
    const agendador = criarAgendadorReconcileEstoqueLi({ fila: () => fila, desligado: false });
    const pedir = (agoraMs: number) =>
      iniciarReconcileManualLi({ db: asDb(db), agendador: () => agendador, agoraMs });

    expect(await pedir(AGORA_RECONCILE_MS)).toEqual({
      tipo: 'enfileirado',
      execucaoId: ID_DO_MINUTO,
    });
    expect(await pedir(AGORA_RECONCILE_MS + 30_000)).toEqual({
      tipo: 'enfileirado',
      execucaoId: ID_DO_MINUTO,
    });
    expect(enviados).toEqual([
      {
        tarefa: tarefaReconcileEstoqueLiSchema.parse({
          tipo: 'estoque-reconcile',
          execucaoId: ID_DO_MINUTO,
          seq: 0,
        }),
        opcoes: { id: idTarefaReconcileEstoqueLi(ID_DO_MINUTO, 0) },
      },
    ]);
    expect(idTarefaReconcileEstoqueLi(ID_DO_MINUTO, 0)).toBe(`li-${ID_DO_MINUTO}-0`);
    // The next minute is another run.
    await pedir(MINUTO + 60_000);
    expect(enviados).toHaveLength(2);
  });

  it('the closed valve ⇒ tarefas-desligadas; a transient Cloud Tasks failure is RETHROWN (unknown outcome)', async () => {
    const db = new FakeDb();
    const fechado = await iniciarReconcileManualLi({
      db: asDb(db),
      agendador: () =>
        criarAgendadorReconcileEstoqueLi({
          fila: () => {
            throw new Error('nunca');
          },
          desligado: true,
        }),
      agoraMs: AGORA_RECONCILE_MS,
    });
    expect(fechado).toEqual({ tipo: 'tarefas-desligadas', execucaoId: ID_DO_MINUTO });

    const g = agendadorGravador(
      () =>
        new LiTarefasTransitoriasError('FirebaseFunctionsError', 'functions/unknown-error', 503),
    );
    await expect(
      iniciarReconcileManualLi({
        db: asDb(db),
        agendador: () => g.agendador,
        agoraMs: AGORA_RECONCILE_MS,
      }),
    ).rejects.toBeInstanceOf(LiTarefasTransitoriasError);
    // NEAR-MISS: a raw valve error from a hand-built producer is the same answer as the real one.
    const g2 = agendadorGravador(() => new LiTarefasDesligadasError());
    expect(
      (
        await iniciarReconcileManualLi({
          db: asDb(db),
          agendador: () => g2.agendador,
          agoraMs: AGORA_RECONCILE_MS,
        })
      ).tipo,
    ).toBe('tarefas-desligadas');
  });
});
