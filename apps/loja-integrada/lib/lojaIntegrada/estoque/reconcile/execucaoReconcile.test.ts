/**
 * `execucaoReconcile.ts` (master plan step 12, PR 12-g): which slice runs, the lease's take, and
 * every write of the run riding the run document's chained precondition — against
 * `testing/fakeDb.ts`, whose batch and lost-reply models the interleavings are written with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  sincEstoqueLojaIntegradaCollection,
  snapshotEstoqueLiCollection,
} from '@delfrance/data/admin/collections';
import { FASE_RECONCILE_ESTOQUE_LI, reconcileEstoqueLojaIntegradaSchema } from '@delfrance/schemas';

import { FakeDb, asDb, grpc } from '../../testing/fakeDb';
import { AGORA_RECONCILE_MS, RUN_A, RUN_B } from '../../testing/reconcileEstoqueLi';
import {
  ABANDONO_RECONCILE_ESTOQUE_LI_MS,
  CAMPOS_LEASE_RECONCILE_LI,
  type EstadoEscritaReconcileLi,
  LEASE_RECONCILE_ESTOQUE_LI_MS,
  LiReconcileEstoqueConcorrenteError,
  MAX_TENTATIVAS_ESCRITA_RECONCILE_LI,
  type RunLidoLi,
  assumirLeaseReconcileLi,
  decidirSliceReconcileLi,
  gravarLoteReconcileLi,
  leaseReconcileVivoLi,
  lerLeaseRunReconcileLi,
  lerRunReconcileLi,
  refRunReconcileLi,
} from './execucaoReconcile';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('execucaoReconcile.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const RUN_PATH = 'reconcileEstoqueLojaIntegrada/atual';

/** A run document (refined) holding the lease. */
function runEmCurso(over: Record<string, unknown> = {}) {
  return reconcileEstoqueLojaIntegradaSchema.parse({
    execucaoId: RUN_A,
    iniciadoEmMs: AGORA_RECONCILE_MS - 3_600_000,
    emExecucaoAteMs: AGORA_RECONCILE_MS + 1_000,
    seq: 4,
    fase: FASE_RECONCILE_ESTOQUE_LI.erp,
    contas: ['C1'],
    ...over,
  });
}

const lido = (run: ReturnType<typeof runEmCurso> | null, existe = true) => ({ existe, run });

describe('decidirSliceReconcileLi — the SAME run', () => {
  it('executar: the stored seq, the lease held — even expired (expiry only lets ANOTHER run take it)', () => {
    expect(
      decidirSliceReconcileLi(
        lido(runEmCurso()),
        { execucaoId: RUN_A, seq: 4 },
        AGORA_RECONCILE_MS,
      ),
    ).toEqual({
      tipo: 'executar',
    });
    const vencido = runEmCurso({ emExecucaoAteMs: AGORA_RECONCILE_MS - 1 });
    expect(
      decidirSliceReconcileLi(lido(vencido), { execucaoId: RUN_A, seq: 4 }, AGORA_RECONCILE_MS),
    ).toEqual({
      tipo: 'executar',
    });
  });

  it('continuacao: ONE seq behind with the lease held — the repair re-enqueues the stored seq', () => {
    expect(
      decidirSliceReconcileLi(
        lido(runEmCurso()),
        { execucaoId: RUN_A, seq: 3 },
        AGORA_RECONCILE_MS,
      ),
    ).toEqual({
      tipo: 'continuacao',
      seq: 4,
    });
  });

  it('⚠️ NEAR-MISS: two behind, one ahead ⇒ nada; ONE behind a RELEASED run ⇒ revisao (its release may have landed behind an error), any other seq of it ⇒ nada', () => {
    const d = (seq: number, run = runEmCurso()) =>
      decidirSliceReconcileLi(lido(run), { execucaoId: RUN_A, seq }, AGORA_RECONCILE_MS).tipo;
    expect(d(2)).toBe('nada');
    expect(d(5)).toBe('nada');
    const liberado = runEmCurso({
      emExecucaoAteMs: 0,
      seq: 5,
      fase: FASE_RECONCILE_ESTOQUE_LI.fim,
    });
    expect(d(4, liberado)).toBe('revisao');
    expect(d(3, liberado)).toBe('nada');
    expect(d(5, liberado)).toBe('nada');
  });
});

describe('decidirSliceReconcileLi — ANOTHER run', () => {
  const t0 = { execucaoId: RUN_B, seq: 0 };

  it('only a first slice may start one: a later seq of a run that holds nothing ⇒ nada', () => {
    expect(
      decidirSliceReconcileLi(lido(null, false), { execucaoId: RUN_B, seq: 1 }, AGORA_RECONCILE_MS)
        .tipo,
    ).toBe('nada');
    expect(
      decidirSliceReconcileLi(lido(runEmCurso()), { execucaoId: RUN_B, seq: 3 }, AGORA_RECONCILE_MS)
        .tipo,
    ).toBe('nada');
  });

  it('assumir: no document; a document the kit fan-out created for its slot alone; a free lease', () => {
    expect(decidirSliceReconcileLi(lido(null, false), t0, AGORA_RECONCILE_MS)).toEqual({
      tipo: 'assumir',
      abandonada: null,
    });
    const soSlot = reconcileEstoqueLojaIntegradaSchema.parse({ proximoSlotMs: AGORA_RECONCILE_MS });
    expect(decidirSliceReconcileLi(lido(soSlot), t0, AGORA_RECONCILE_MS)).toEqual({
      tipo: 'assumir',
      abandonada: null,
    });
    const livre = runEmCurso({ emExecucaoAteMs: 0, iniciadoEmMs: AGORA_RECONCILE_MS - 86_400_000 });
    expect(decidirSliceReconcileLi(lido(livre), t0, AGORA_RECONCILE_MS)).toEqual({
      tipo: 'assumir',
      abandonada: null,
    });
  });

  it('a document off its schema is abandoned (the take rewrites every reconcile field)', () => {
    expect(decidirSliceReconcileLi(lido(null, true), t0, AGORA_RECONCILE_MS)).toEqual({
      tipo: 'assumir',
      abandonada: 'fora-do-formato',
    });
  });

  it('an expired lease is abandoned; the lease at exactly now is still held (near-miss)', () => {
    const d = (emExecucaoAteMs: number) =>
      decidirSliceReconcileLi(lido(runEmCurso({ emExecucaoAteMs })), t0, AGORA_RECONCILE_MS);
    expect(d(AGORA_RECONCILE_MS - 1)).toEqual({ tipo: 'assumir', abandonada: 'lease-vencido' });
    expect(d(AGORA_RECONCILE_MS)).toEqual({ tipo: 'ocupado' });
  });

  it(`⚠️ NEAR-MISS: a live chain started 48 h + 1 ms ago is abandoned; 48 h − 1 ms and exactly 48 h win`, () => {
    const d = (idadeMs: number) =>
      decidirSliceReconcileLi(
        lido(
          runEmCurso({
            iniciadoEmMs: AGORA_RECONCILE_MS - idadeMs,
            emExecucaoAteMs: AGORA_RECONCILE_MS + 60_000,
          }),
        ),
        t0,
        AGORA_RECONCILE_MS,
      );
    expect(d(ABANDONO_RECONCILE_ESTOQUE_LI_MS + 1)).toEqual({
      tipo: 'assumir',
      abandonada: 'mais-de-48h',
    });
    expect(d(ABANDONO_RECONCILE_ESTOQUE_LI_MS - 1)).toEqual({ tipo: 'ocupado' });
    expect(d(ABANDONO_RECONCILE_ESTOQUE_LI_MS)).toEqual({ tipo: 'ocupado' });
  });

  it('⚠️ NEAR-MISS: a stored run that STARTED in this minute window ⇒ adiar; the next window ⇒ not', () => {
    const inicio = Math.floor(AGORA_RECONCILE_MS / 60_000) * 60_000;
    const liberado = runEmCurso({ emExecucaoAteMs: 0, iniciadoEmMs: inicio });
    expect(decidirSliceReconcileLi(lido(liberado), t0, inicio + 59_999)).toEqual({ tipo: 'adiar' });
    expect(decidirSliceReconcileLi(lido(liberado), t0, inicio + 60_000)).toEqual({
      tipo: 'assumir',
      abandonada: null,
    });
  });

  it('the same-run checks come FIRST: our own run started this minute still executes', () => {
    const run = runEmCurso({
      iniciadoEmMs: AGORA_RECONCILE_MS,
      emExecucaoAteMs: AGORA_RECONCILE_MS + 60_000,
      seq: 0,
    });
    expect(
      decidirSliceReconcileLi(lido(run), { execucaoId: RUN_A, seq: 0 }, AGORA_RECONCILE_MS).tipo,
    ).toBe('executar');
  });
});

/** A run document in the fake, and the slice's write state from its read. */
async function comRun(
  db: FakeDb,
  over: Record<string, unknown> = {},
): Promise<EstadoEscritaReconcileLi> {
  db.seed(RUN_PATH, {
    execucaoId: RUN_A,
    iniciadoEmMs: AGORA_RECONCILE_MS,
    emExecucaoAteMs: AGORA_RECONCILE_MS + LEASE_RECONCILE_ESTOQUE_LI_MS,
    seq: 2,
    fase: FASE_RECONCILE_ESTOQUE_LI.erp,
    contas: ['C1'],
    idxConta: 0,
    walk: null,
    candidatos: [],
    proximoSlotMs: AGORA_RECONCILE_MS + 5_000,
    contadores: {},
    ...over,
  });
  const r: RunLidoLi = await lerRunReconcileLi(asDb(db));
  if (r.versao === null) throw new Error('fixture: run ausente');
  return { execucaoId: RUN_A, seq: 2, versaoRun: r.versao, runEsperado: r.dados };
}

const baldePath = (id: string) => `sincEstoqueLojaIntegrada/C1/snapshot/${id}`;

function escritaDoBalde(db: FakeDb) {
  return {
    tipo: 'gravar' as const,
    ref: snapshotEstoqueLiCollection.docRef(asDb(db), { integracaoId: 'C1' }, '05'),
    dados: { execucaoId: RUN_A, e: { '5': { p: 'p1', s: 3, f: 'v' } } },
    versao: null,
  };
}

describe('gravarLoteReconcileLi — every write rides the run document’s precondition', () => {
  it('ONE batch: the run patch and the per-conta documents under one stamp; the stamp chains', async () => {
    const db = new FakeDb();
    const estado = await comRun(db);
    const r1 = await gravarLoteReconcileLi(asDb(db), estado, { contadores: { a: 1 } }, [
      escritaDoBalde(db),
    ]);
    expect(r1.tipo).toBe('gravado');
    const lotes = new Set(db.escritas.map((e) => e.lote));
    expect(lotes.size).toBe(1);
    expect(db.ler(baldePath('05'))).toMatchObject({ execucaoId: RUN_A });
    // The chained stamp: a second write goes through with no read in between.
    const leituras = db.leituras.length;
    await gravarLoteReconcileLi(asDb(db), estado, { contadores: { a: 2 } });
    expect(db.leituras.length).toBe(leituras);
    expect(db.ler(RUN_PATH)).toMatchObject({
      contadores: { a: 2 },
      proximoSlotMs: AGORA_RECONCILE_MS + 5_000,
    });
  });

  it('⚠️ the kit fan-out moves ONLY the slot between read and write ⇒ the SAME batch is re-applied, and the slot is kept', async () => {
    const db = new FakeDb();
    const estado = await comRun(db);
    const run = db.ler(RUN_PATH);
    db.antesDaProximaEscrita(RUN_PATH, async () => {
      // The fan-out's own write: proximoSlotMs alone, on its own read.
      await refRunReconcileLi(asDb(db)).update(
        { proximoSlotMs: AGORA_RECONCILE_MS + 99_000 },
        { lastUpdateTime: db.carimboDe(RUN_PATH) as never },
      );
    });
    const r = await gravarLoteReconcileLi(
      asDb(db),
      estado,
      { walk: { ultimoDocPath: 'produtos/p1/produtolojaintegrada/l1', concluida: false }, seq: 3 },
      [escritaDoBalde(db)],
    );
    expect(r.tipo).toBe('gravado');
    expect(run).toBeDefined();
    expect(db.ler(RUN_PATH)).toMatchObject({
      proximoSlotMs: AGORA_RECONCILE_MS + 99_000,
      seq: 3,
      walk: { ultimoDocPath: 'produtos/p1/produtolojaintegrada/l1', concluida: false },
    });
    expect(db.ler(baldePath('05'))).toMatchObject({ execucaoId: RUN_A });
    expect(db.escritasEm(baldePath('05'))).toHaveLength(1);
  });

  it('⚠️ a LOST REPLY of our own batch is recognised — written once, never re-advanced', async () => {
    const db = new FakeDb();
    const estado = await comRun(db);
    db.respostaPerdidaNaProximaEscrita(RUN_PATH);
    const r = await gravarLoteReconcileLi(asDb(db), estado, { seq: 3 }, [escritaDoBalde(db)]);
    expect(r.tipo).toBe('gravado');
    expect(db.escritasEm(RUN_PATH)).toHaveLength(1);
    expect(db.ler(RUN_PATH)).toMatchObject({ seq: 3 });
    // The per-conta stamps were read again (the batch's commit time was lost with its reply).
    if (r.tipo === 'gravado') {
      expect(r.versoes.get(baldePath('05'))?.isEqual(db.carimboDe(baldePath('05')) as never)).toBe(
        true,
      );
    }
    expect(estado.versaoRun.isEqual(db.carimboDe(RUN_PATH) as never)).toBe(true);
  });

  it('another run took the lease between read and write ⇒ parar: nothing written, no throw', async () => {
    const db = new FakeDb();
    const estado = await comRun(db);
    db.antesDaProximaEscrita(RUN_PATH, async () => {
      await refRunReconcileLi(asDb(db)).update(
        { execucaoId: RUN_B, seq: 0 },
        { lastUpdateTime: db.carimboDe(RUN_PATH) as never },
      );
    });
    const r = await gravarLoteReconcileLi(asDb(db), estado, { seq: 3 }, [escritaDoBalde(db)]);
    expect(r.tipo).toBe('parar');
    expect(db.ler(baldePath('05'))).toBeUndefined();
    expect(db.ler(RUN_PATH)).toMatchObject({ execucaoId: RUN_B, seq: 0 });
  });

  it('⚠️ NEAR-MISS: the same slice’s run with ANOTHER field changed (another dispatch of this seq) ⇒ throws, nothing re-applied', async () => {
    const db = new FakeDb();
    const estado = await comRun(db);
    db.antesDaProximaEscrita(RUN_PATH, async () => {
      await refRunReconcileLi(asDb(db)).update(
        { contadores: { outro: 1 } },
        { lastUpdateTime: db.carimboDe(RUN_PATH) as never },
      );
    });
    await expect(
      gravarLoteReconcileLi(asDb(db), estado, { seq: 3 }, [escritaDoBalde(db)]),
    ).rejects.toBeInstanceOf(LiReconcileEstoqueConcorrenteError);
    expect(db.ler(RUN_PATH)).toMatchObject({ seq: 2, contadores: { outro: 1 } });
    expect(db.ler(baldePath('05'))).toBeUndefined();
  });

  it(`a slot that moves before EVERY attempt ⇒ ${String(MAX_TENTATIVAS_ESCRITA_RECONCILE_LI)} attempts, then throws`, async () => {
    const db = new FakeDb();
    const estado = await comRun(db);
    // One hook at a time, re-armed AFTER its own write (a hook's write would take the next one).
    let movidas = 0;
    const mover = async (): Promise<void> => {
      movidas += 1;
      await refRunReconcileLi(asDb(db)).update(
        { proximoSlotMs: AGORA_RECONCILE_MS + movidas },
        { lastUpdateTime: db.carimboDe(RUN_PATH) as never },
      );
      if (movidas < MAX_TENTATIVAS_ESCRITA_RECONCILE_LI) db.antesDaProximaEscrita(RUN_PATH, mover);
    };
    db.antesDaProximaEscrita(RUN_PATH, mover);
    await expect(gravarLoteReconcileLi(asDb(db), estado, { seq: 3 })).rejects.toBeInstanceOf(
      LiReconcileEstoqueConcorrenteError,
    );
    expect(db.ler(RUN_PATH)).toMatchObject({ seq: 2 });
    expect(movidas).toBe(MAX_TENTATIVAS_ESCRITA_RECONCILE_LI);
  });

  it('refuses before any write: a patch naming the slot, or one leaving the document off its invariants', async () => {
    const db = new FakeDb();
    const estado = await comRun(db);
    await expect(gravarLoteReconcileLi(asDb(db), estado, { proximoSlotMs: 1 })).rejects.toThrow(
      TypeError,
    );
    await expect(gravarLoteReconcileLi(asDb(db), estado, { idxConta: 2 })).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(db.escritas).toHaveLength(0);
  });

  it('a failure that is not a lost precondition propagates as thrown', async () => {
    const db = new FakeDb();
    const estado = await comRun(db);
    db.falharEscrita(RUN_PATH, grpc(14, 'UNAVAILABLE'));
    await expect(gravarLoteReconcileLi(asDb(db), estado, { seq: 3 })).rejects.toMatchObject({
      code: 14,
    });
  });
});

describe('assumirLeaseReconcileLi — the take', () => {
  const raiz = (db: FakeDb, contaId: string, depositoId: string) => ({
    contaId,
    depositoId,
    ref: sincEstoqueLojaIntegradaCollection.docRef(asDb(db), {}, contaId),
    versao: null,
  });

  it('no document ⇒ create: every reconcile field, the lease for an hour, the roots’ execucao — NEVER the slot', async () => {
    const db = new FakeDb();
    const r = await assumirLeaseReconcileLi(asDb(db), {
      lido: await lerRunReconcileLi(asDb(db)),
      tarefa: { execucaoId: RUN_A, seq: 0 },
      agoraMs: AGORA_RECONCILE_MS,
      raizes: [raiz(db, 'C1', 'dep-1'), raiz(db, 'C2', 'dep-2')],
    });
    expect(r.tipo).toBe('assumido');
    const run = db.ler(RUN_PATH) ?? {};
    expect(run).toEqual({
      execucaoId: RUN_A,
      iniciadoEmMs: AGORA_RECONCILE_MS,
      emExecucaoAteMs: AGORA_RECONCILE_MS + LEASE_RECONCILE_ESTOQUE_LI_MS,
      seq: 0,
      fase: 'erp',
      contas: ['C1', 'C2'],
      idxConta: 0,
      walk: null,
      candidatos: [],
      contadores: {},
    });
    expect(Object.hasOwn(run, 'proximoSlotMs')).toBe(false);
    expect(db.ler('sincEstoqueLojaIntegrada/C2')).toEqual({
      execucao: { execucaoId: RUN_A, depositoId: 'dep-2', vistos: [], amostras: {}, mapa: null },
    });
    expect(new Set(db.escritas.map((e) => e.lote)).size).toBe(1);
  });

  it('a document the fan-out created ⇒ update under its read, and the slot stays as it was', async () => {
    const db = new FakeDb();
    db.seed(RUN_PATH, { proximoSlotMs: AGORA_RECONCILE_MS + 7_000 });
    db.seed('sincEstoqueLojaIntegrada/C1', { ultimoReconcile: null });
    const versao = db.carimboDe('sincEstoqueLojaIntegrada/C1') ?? null;
    const r = await assumirLeaseReconcileLi(asDb(db), {
      lido: await lerRunReconcileLi(asDb(db)),
      tarefa: { execucaoId: RUN_A, seq: 0 },
      agoraMs: AGORA_RECONCILE_MS,
      raizes: [{ ...raiz(db, 'C1', 'dep-1'), versao: versao as never }],
    });
    expect(r.tipo).toBe('assumido');
    expect(db.ler(RUN_PATH)).toMatchObject({
      execucaoId: RUN_A,
      proximoSlotMs: AGORA_RECONCILE_MS + 7_000,
    });
    expect(db.ler('sincEstoqueLojaIntegrada/C1')).toMatchObject({
      ultimoReconcile: null,
      execucao: { depositoId: 'dep-1' },
    });
  });

  it('no conta ⇒ the run is released at once (fim, lease 0, seq 1), and no root is written', async () => {
    const db = new FakeDb();
    const r = await assumirLeaseReconcileLi(asDb(db), {
      lido: await lerRunReconcileLi(asDb(db)),
      tarefa: { execucaoId: RUN_A, seq: 0 },
      agoraMs: AGORA_RECONCILE_MS,
      raizes: [],
    });
    expect(r.tipo).toBe('assumido');
    expect(db.ler(RUN_PATH)).toMatchObject({ fase: 'fim', emExecucaoAteMs: 0, seq: 1, contas: [] });
    expect(db.escritas).toHaveLength(1);
  });

  it('⚠️ another writer moved the document between read and take ⇒ perdido, nothing of ours written', async () => {
    const db = new FakeDb();
    db.seed(RUN_PATH, { proximoSlotMs: 1 });
    const lidoAntes = await lerRunReconcileLi(asDb(db));
    db.antesDaProximaEscrita(RUN_PATH, async () => {
      await refRunReconcileLi(asDb(db)).update(
        { execucaoId: RUN_B, iniciadoEmMs: AGORA_RECONCILE_MS },
        { lastUpdateTime: db.carimboDe(RUN_PATH) as never },
      );
    });
    const r = await assumirLeaseReconcileLi(asDb(db), {
      lido: lidoAntes,
      tarefa: { execucaoId: RUN_A, seq: 0 },
      agoraMs: AGORA_RECONCILE_MS,
      raizes: [raiz(db, 'C1', 'dep-1')],
    });
    expect(r.tipo).toBe('perdido');
    expect(db.ler('sincEstoqueLojaIntegrada/C1')).toBeUndefined();
    expect(db.ler(RUN_PATH)).toMatchObject({ execucaoId: RUN_B });
  });

  it('a take whose reply was lost is recognised as ours (assumido), never a second take', async () => {
    const db = new FakeDb();
    db.seed(RUN_PATH, { proximoSlotMs: 1 });
    const lidoAntes = await lerRunReconcileLi(asDb(db));
    db.respostaPerdidaNaProximaEscrita(RUN_PATH);
    const r = await assumirLeaseReconcileLi(asDb(db), {
      lido: lidoAntes,
      tarefa: { execucaoId: RUN_A, seq: 0 },
      agoraMs: AGORA_RECONCILE_MS,
      raizes: [raiz(db, 'C1', 'dep-1')],
    });
    expect(r.tipo).toBe('assumido');
    expect(db.escritasEm(RUN_PATH)).toHaveLength(1);
  });
});

describe('leaseReconcileVivoLi and the MASKED lease read (PR 12-h: the operator reconcile route)', () => {
  const vivo = (over: Record<string, unknown>) =>
    leaseReconcileVivoLi(runEmCurso(over), AGORA_RECONCILE_MS);

  it('held, unexpired and at most 48 h old ⇒ alive; each edge on its own side (near-misses)', () => {
    expect(vivo({})).toBe(true);
    expect(vivo({ emExecucaoAteMs: AGORA_RECONCILE_MS })).toBe(true);
    expect(vivo({ emExecucaoAteMs: AGORA_RECONCILE_MS - 1 })).toBe(false);
    expect(vivo({ emExecucaoAteMs: 0 })).toBe(false);
    expect(vivo({ iniciadoEmMs: AGORA_RECONCILE_MS - ABANDONO_RECONCILE_ESTOQUE_LI_MS })).toBe(
      true,
    );
    expect(vivo({ iniciadoEmMs: AGORA_RECONCILE_MS - ABANDONO_RECONCILE_ESTOQUE_LI_MS - 1 })).toBe(
      false,
    );
    expect(vivo({ iniciadoEmMs: null })).toBe(false);
  });

  it('is EXACTLY the decision’s “ocupado”: across held, free, expired, > 48 h and the same minute, another run’s first slice is refused iff the lease is alive (and the minute does not defer it first)', () => {
    const inicioDoMinuto = Math.floor(AGORA_RECONCILE_MS / 60_000) * 60_000;
    const casos = [
      {},
      { emExecucaoAteMs: 0 },
      { emExecucaoAteMs: AGORA_RECONCILE_MS - 1 },
      { emExecucaoAteMs: AGORA_RECONCILE_MS },
      { iniciadoEmMs: AGORA_RECONCILE_MS - ABANDONO_RECONCILE_ESTOQUE_LI_MS - 1 },
      { iniciadoEmMs: AGORA_RECONCILE_MS - ABANDONO_RECONCILE_ESTOQUE_LI_MS },
      { iniciadoEmMs: null },
      { iniciadoEmMs: inicioDoMinuto },
      { iniciadoEmMs: inicioDoMinuto, emExecucaoAteMs: 0 },
    ];
    for (const over of casos) {
      const run = runEmCurso(over);
      const decisao = decidirSliceReconcileLi(
        lido(run),
        { execucaoId: RUN_B, seq: 0 },
        AGORA_RECONCILE_MS,
      );
      if (decisao.tipo === 'adiar') continue;
      expect(decisao.tipo === 'ocupado', JSON.stringify(over)).toBe(
        leaseReconcileVivoLi(run, AGORA_RECONCILE_MS),
      );
    }
    // ⚠️ The same minute is checked FIRST by the decision: a run that took the lease this minute
    // reads `adiar` there — which is why the route asks the lease rule itself, before the decision.
    const recente = runEmCurso({ iniciadoEmMs: inicioDoMinuto });
    expect(
      decidirSliceReconcileLi(lido(recente), { execucaoId: RUN_B, seq: 0 }, AGORA_RECONCILE_MS)
        .tipo,
    ).toBe('adiar');
    expect(leaseReconcileVivoLi(recente, AGORA_RECONCILE_MS)).toBe(true);
  });

  it('reads the run document ONCE, masked to the four lease fields — never the candidate list', async () => {
    const db = new FakeDb();
    const getAll = vi.spyOn(db, 'getAll');
    await comRun(db, {
      candidatos: [{ c: 0, i: '7', p: 'p1', d: 3 }],
      walk: { ultimoDocPath: null, concluida: true },
    });
    db.leituras.length = 0;

    const r = await lerLeaseRunReconcileLi(asDb(db));

    expect(getAll).toHaveBeenCalledTimes(1);
    const args = getAll.mock.calls[0] ?? [];
    expect(args.at(-1)).toEqual({ fieldMask: [...CAMPOS_LEASE_RECONCILE_LI] });
    expect(CAMPOS_LEASE_RECONCILE_LI).toEqual([
      'execucaoId',
      'seq',
      'emExecucaoAteMs',
      'iniciadoEmMs',
    ]);
    expect(db.leituras).toEqual([RUN_PATH]);
    expect(Object.keys(r.dados).sort()).toEqual([...CAMPOS_LEASE_RECONCILE_LI].sort());
    expect(r.run).toMatchObject({ execucaoId: RUN_A, seq: 2, candidatos: [], contas: [] });
  });

  it('PROPERTY: the decision on the masked read equals the decision on the full read, for every stored lease and every arriving slice', async () => {
    const inicioDoMinuto = Math.floor(AGORA_RECONCILE_MS / 60_000) * 60_000;
    const estados = [
      {},
      { emExecucaoAteMs: 0 },
      { emExecucaoAteMs: AGORA_RECONCILE_MS - 1 },
      { iniciadoEmMs: AGORA_RECONCILE_MS - ABANDONO_RECONCILE_ESTOQUE_LI_MS - 1 },
      { iniciadoEmMs: inicioDoMinuto },
      {
        execucaoId: null,
        emExecucaoAteMs: 0,
        iniciadoEmMs: null,
        fase: null,
        contas: [],
        candidatos: [],
      },
    ];
    const tarefas = [
      { execucaoId: RUN_A, seq: 2 },
      { execucaoId: RUN_A, seq: 1 },
      { execucaoId: RUN_B, seq: 0 },
      { execucaoId: RUN_B, seq: 1 },
    ];
    for (const over of estados) {
      const db = new FakeDb();
      await comRun(db, {
        candidatos: [{ c: 0, i: '7', p: 'p1', d: 3 }],
        ...over,
      });
      const cheio = await lerRunReconcileLi(asDb(db));
      const mascarado = await lerLeaseRunReconcileLi(asDb(db));
      expect(cheio.run, JSON.stringify(over)).not.toBeNull();
      for (const tarefa of tarefas) {
        expect(
          decidirSliceReconcileLi(mascarado, tarefa, AGORA_RECONCILE_MS),
          JSON.stringify({ over, tarefa }),
        ).toEqual(decidirSliceReconcileLi(cheio, tarefa, AGORA_RECONCILE_MS));
      }
    }
  });

  it('⚠️ the ONE divergence: a document malformed OUTSIDE the lease fields is a run to the mask and abandoned by the full read — the route answers 409 where the next slice would take over (the conservative side)', async () => {
    const db = new FakeDb();
    // A candidate naming a conta outside the list: the refined schema refuses the WHOLE document.
    await comRun(db, { contas: [], candidatos: [{ c: 0, i: '7', p: 'p1', d: 3 }] });
    expect((await lerRunReconcileLi(asDb(db))).run).toBeNull();
    const mascarado = await lerLeaseRunReconcileLi(asDb(db));
    expect(mascarado.run).not.toBeNull();
    expect(leaseReconcileVivoLi(mascarado.run ?? runEmCurso(), AGORA_RECONCILE_MS)).toBe(true);
  });

  it('no document ⇒ absent, run null; a lease field off its schema ⇒ run null (fail toward a take, as the full read)', async () => {
    const db = new FakeDb();
    expect(await lerLeaseRunReconcileLi(asDb(db))).toEqual({
      existe: false,
      dados: {},
      run: null,
      versao: null,
    });
    db.seed(RUN_PATH, { execucaoId: 'a b', emExecucaoAteMs: 1, seq: 0 });
    const r = await lerLeaseRunReconcileLi(asDb(db));
    expect([r.existe, r.run]).toEqual([true, null]);
  });
});
