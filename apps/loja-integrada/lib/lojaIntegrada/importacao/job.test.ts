/**
 * The product import's job lifecycle (master plan step 9) on the fake Firestore: the reads, the
 * `seq` decision, the chained checkpoints, the terminal stamps and the cancel — each write under
 * its root-rule-7 guard, each race landed with `antesDaProximaEscrita` exactly in the window a
 * concurrent writer lands in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { Timestamp } from 'firebase-admin/firestore';
import {
  CAMINHO_DO_COMPLETAR_LI,
  FASE_IMPORTACAO_LI,
  LIMITE_IMPORTACOES_LISTADAS_LI,
  LIMITE_ITENS_IMPORTACAO_LI,
  MOTIVO_FALHA_IMPORTACAO_LI,
  STATUS_IMPORTACAO_LI,
  type StatusImportacaoLi,
  importacaoLojaIntegradaSchema,
  progressoDaFamiliaLiSchema,
  respostaImportacaoLiSchema,
} from '@delfrance/schemas';

import { importacaoLojaIntegradaCollection } from '@delfrance/data/admin/collections';

import { type CarimboFake, FakeDb, asDb } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import { caminhoItemLi, caminhoJobLi, jobLi, seedItemLi, seedJobLi } from '../testing/importacaoLi';
import {
  DECISAO_DESPACHO_LI,
  LiCancelamentoEmConflitoError,
  LiImportacaoConcorrenteError,
  MAX_TENTATIVAS_ESCRITA_JOB_LI,
  type ProgressoImportacaoLi,
  cancelarImportacaoLi,
  decidirDespachoLi,
  ehCursorDeItensLi,
  encerrarImportacaoLi,
  gravarCheckpointDaUnidadeLi,
  gravarCheckpointDoFimDoDespachoLi,
  jobEmCursoDaContaLi,
  lerItensDaImportacaoLi,
  lerJobDaContaLi,
  lerJobLi,
  listarImportacoesDaContaLi,
  projetarImportacaoLi,
} from './job';

// D17, per file: nothing here may reach the global `fetch`.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('job.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const CONTA = 'conta-li-job';
const OUTRA = 'conta-li-outra';
const JOB = 'jobImportacaoA1';

/** The fake's stamp as the SDK type the lifecycle takes. */
const v = (c: CarimboFake | undefined): Timestamp => {
  if (c === undefined) throw new Error('fixture: no stamp');
  return c as unknown as Timestamp;
};

/**
 * A running dispatch that checkpoints right before each of the next `vezes` writes on the job (the
 * window a concurrent writer lands in), setting `pausas429` to 1, 2, …. Each hook is installed only
 * after the previous one's own write landed, so no hook fires inside another's write.
 */
function checkpointAntesDeCadaEscrita(db: FakeDb, vezes: number): void {
  let feitas = 0;
  const instalar = (): void => {
    db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
      const lido = await lerJobLi(asDb(db), JOB);
      if (lido === null) throw new Error('fixture: job gone');
      feitas += 1;
      await gravarCheckpointDaUnidadeLi(
        asDb(db),
        { jobId: JOB, seq: lido.job.seq, versao: lido.versao },
        { pausas429: feitas },
        AGORA_MS,
      );
      if (feitas < vezes) instalar();
    });
  };
  instalar();
}

describe('the reads', () => {
  it('lerJobLi: absent ⇒ null; present ⇒ the parsed job and its stamp', async () => {
    const db = new FakeDb();
    expect(await lerJobLi(asDb(db), JOB)).toBeNull();
    const carimbo = seedJobLi(db, JOB, CONTA, { seq: 4 });
    const lido = await lerJobLi(asDb(db), JOB);
    expect(lido?.jobId).toBe(JOB);
    expect(lido?.job).toMatchObject({ integracaoId: CONTA, seq: 4, status: 'executando' });
    expect(lido?.versao.isEqual(v(carimbo))).toBe(true);
  });

  it('a stored job that does not parse is corruption: ZodError, never a tolerated shape', async () => {
    const db = new FakeDb();
    db.seed(caminhoJobLi(JOB), { integracaoId: CONTA, status: 'rodando', iniciadoEmMs: 1 });
    await expect(lerJobLi(asDb(db), JOB)).rejects.toBeInstanceOf(ZodError);
  });

  it('EQUAL: lerJobDaContaLi returns the conta’s own job; ⚠️ NEAR-MISS: another conta’s reads as absent', async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA);
    expect((await lerJobDaContaLi(asDb(db), CONTA, JOB))?.jobId).toBe(JOB);
    expect(await lerJobDaContaLi(asDb(db), OUTRA, JOB)).toBeNull();
    expect(await lerJobDaContaLi(asDb(db), CONTA, 'outroJob')).toBeNull();
  });

  it('the conta’s jobs are ONE query: integracaoId ==, orderBy iniciadoEmMs desc, limit 10 (the declared index)', async () => {
    const db = new FakeDb();
    await jobEmCursoDaContaLi(asDb(db), CONTA);
    await listarImportacoesDaContaLi(asDb(db), CONTA);
    const esperada = {
      colecao: 'importacoesLojaIntegrada',
      filtros: [['integracaoId', '==', CONTA]],
      ordens: [['iniciadoEmMs', 'desc']],
      limite: LIMITE_IMPORTACOES_LISTADAS_LI,
      apos: null,
    };
    expect(db.consultas).toEqual([esperada, esperada]);
    expect(LIMITE_IMPORTACOES_LISTADAS_LI).toBe(10);
  });

  it.each<[StatusImportacaoLi, boolean]>([
    ['pendente', true],
    ['executando', true],
    ['concluido', false],
    ['falhou', false],
    ['cancelado', false],
  ])('the guard: a %s job blocks a start = %s', async (status, bloqueia) => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA, { status });
    expect(await jobEmCursoDaContaLi(asDb(db), CONTA)).toBe(bloqueia ? JOB : null);
  });

  it('the guard reads the status RAW: a running job whose other fields no longer parse still blocks', async () => {
    const db = new FakeDb();
    db.seed(caminhoJobLi(JOB), {
      integracaoId: CONTA,
      iniciadoEmMs: AGORA_MS,
      status: 'executando',
      seq: 'não é número',
    });
    expect(await jobEmCursoDaContaLi(asDb(db), CONTA)).toBe(JOB);
  });

  it('⚠️ NEAR-MISS: another conta’s running job never blocks this conta', async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, OUTRA, { status: 'executando' });
    seedJobLi(db, 'jobAntigo', CONTA, { status: 'concluido', iniciadoEmMs: AGORA_MS - 1000 });
    expect(await jobEmCursoDaContaLi(asDb(db), CONTA)).toBeNull();
  });

  it('the list: newest first, at most 10, each projected — never seq, cursors or selected ids', async () => {
    const db = new FakeDb();
    for (let i = 0; i < 12; i += 1) {
      seedJobLi(db, `job${String(i).padStart(2, '0')}`, CONTA, {
        status: 'concluido',
        iniciadoEmMs: AGORA_MS + i,
        seq: i,
      });
    }
    seedJobLi(db, 'jobDeOutra', OUTRA, { iniciadoEmMs: AGORA_MS + 100 });
    const lista = await listarImportacoesDaContaLi(asDb(db), CONTA);
    expect(lista.map((j) => j.jobId)).toEqual([
      'job11',
      'job10',
      'job09',
      'job08',
      'job07',
      'job06',
      'job05',
      'job04',
      'job03',
      'job02',
    ]);
    for (const j of lista) {
      expect(j).not.toHaveProperty('seq');
      expect(j).not.toHaveProperty('catalogo');
      expect(j).not.toHaveProperty('mapaCategorias');
    }
  });

  it('the projection: the selection as a COUNT, the listing’s totals, and nothing it does not name', () => {
    const job = jobLi(CONTA, {
      alvo: 'selecionados',
      selecionados: [182904918, 182904919],
      seq: 9,
      listagem: {
        proximoOffset: 300,
        paginas: 3,
        linhas: 250,
        limiteLido: 100,
        totalLi: 251,
        divergente: true,
      },
      marcas: [{ id: 1, nome: 'x', ativo: true }],
    });
    const resposta = projetarImportacaoLi(JOB, job);
    expect(respostaImportacaoLiSchema.parse(resposta)).toEqual(resposta);
    expect(resposta).toMatchObject({
      jobId: JOB,
      integracaoId: CONTA,
      alvo: 'selecionados',
      selecionados: 2,
      listagem: { paginas: 3, linhas: 250, totalLi: 251, divergente: true },
    });
    expect(Object.keys(resposta.listagem).sort()).toEqual([
      'divergente',
      'linhas',
      'paginas',
      'totalLi',
    ]);
    expect(JSON.stringify(resposta)).not.toContain('182904918');
    expect(resposta).not.toHaveProperty('seq');
    expect(resposta).not.toHaveProperty('marcas');
  });
});

describe('decidirDespachoLi — the seq check and the continuation check', () => {
  it.each<[StatusImportacaoLi, number, number, string]>([
    ['pendente', 0, 0, DECISAO_DESPACHO_LI.executar],
    ['executando', 3, 3, DECISAO_DESPACHO_LI.executar],
    // The stored seq − 1 while executando: this task already checkpointed; only hand off.
    ['executando', 4, 3, DECISAO_DESPACHO_LI.continuacao],
    // ⚠️ NEAR-MISSES: anything else does nothing.
    ['pendente', 4, 3, DECISAO_DESPACHO_LI.nada],
    ['executando', 4, 2, DECISAO_DESPACHO_LI.nada],
    ['executando', 4, 5, DECISAO_DESPACHO_LI.nada],
    ['concluido', 3, 3, DECISAO_DESPACHO_LI.nada],
    ['falhou', 3, 3, DECISAO_DESPACHO_LI.nada],
    ['cancelado', 3, 3, DECISAO_DESPACHO_LI.nada],
    ['cancelado', 4, 3, DECISAO_DESPACHO_LI.nada],
    ['concluido', 4, 3, DECISAO_DESPACHO_LI.nada],
  ])('a %s job at stored seq %d, payload seq %d ⇒ %s', (status, armazenado, seq, esperado) => {
    expect(decidirDespachoLi({ status, seq: armazenado }, seq)).toBe(esperado);
  });
});

describe('the checkpoints: tier 1, chained from each write’s writeTime', () => {
  const progresso: ProgressoImportacaoLi = {
    fase: FASE_IMPORTACAO_LI.listagem,
    listagem: {
      proximoOffset: 100,
      paginas: 1,
      linhas: 100,
      limiteLido: 100,
      totalLi: 250,
      divergente: false,
    },
  };

  it('a unit checkpoint writes the progress, status executando and the stamp — and keeps seq', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { status: 'pendente', seq: 0 });
    const r = await gravarCheckpointDaUnidadeLi(
      asDb(db),
      { jobId: JOB, seq: 0, versao: v(carimbo) },
      progresso,
      AGORA_MS + 5,
    );
    expect(r.tipo).toBe('gravado');
    const gravado = db.ler(caminhoJobLi(JOB));
    expect(gravado).toMatchObject({
      status: 'executando',
      fase: 'listagem',
      seq: 0,
      atualizadoEmMs: AGORA_MS + 5,
      listagem: progresso.listagem,
    });
    const [escrita] = db.escritasEm(caminhoJobLi(JOB));
    expect(escrita?.verbo).toBe('update');
    expect(Object.keys(escrita?.dados ?? {}).sort()).toEqual([
      'atualizadoEmMs',
      'fase',
      'listagem',
      'status',
    ]);
  });

  it('a checkpoint writes a family’s progress in its own field, whole, and clears it with null', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { status: 'executando', seq: 0 });
    const emCurso = progressoDaFamiliaLiSchema.parse({
      raizLiId: 20,
      caminho: CAMINHO_DO_COMPLETAR_LI.existente,
      erpRaizId: 'caneca',
      categoria: { erpId: null, criadaPelaImportacao: false },
      criacaoAplicada: false,
      completado: false,
      campos: [],
      pendencias: [],
      categoriasCriadas: [900],
      criados: 0,
      completados: 0,
      vinculados: 0,
      sumidos: [],
      alvos: [{ produtoId: 'caneca', liId: null }],
      fotos: null,
      resultadoFotos: null,
    });
    const r = await gravarCheckpointDaUnidadeLi(
      asDb(db),
      { jobId: JOB, seq: 0, versao: v(carimbo) },
      { progressoDaFamilia: emCurso },
      AGORA_MS + 5,
    );
    if (r.tipo !== 'gravado') throw new Error('checkpoint perdido');
    expect(
      importacaoLojaIntegradaSchema.parse(db.ler(caminhoJobLi(JOB))).progressoDaFamilia,
    ).toEqual(emCurso);
    // Only its own field: the phase's cursor is not touched by a family's units.
    expect(Object.keys(db.escritasEm(caminhoJobLi(JOB))[0]?.dados ?? {}).sort()).toEqual([
      'atualizadoEmMs',
      'progressoDaFamilia',
      'status',
    ]);
    await gravarCheckpointDaUnidadeLi(
      asDb(db),
      { jobId: JOB, seq: 0, versao: r.versao },
      { progressoDaFamilia: null },
      AGORA_MS + 6,
    );
    expect(db.ler(caminhoJobLi(JOB))?.progressoDaFamilia).toBeNull();
  });

  it('the chain: each checkpoint’s versao is the next one’s precondition; a stale one is refused', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { seq: 2 });
    const r1 = await gravarCheckpointDaUnidadeLi(
      asDb(db),
      { jobId: JOB, seq: 2, versao: v(carimbo) },
      { fase: FASE_IMPORTACAO_LI.catalogo },
      AGORA_MS,
    );
    if (r1.tipo !== 'gravado') throw new Error('first checkpoint lost');
    const r2 = await gravarCheckpointDaUnidadeLi(
      asDb(db),
      { jobId: JOB, seq: 2, versao: r1.versao },
      { fase: FASE_IMPORTACAO_LI.listagem },
      AGORA_MS,
    );
    expect(r2.tipo).toBe('gravado');
    // Re-using the FIRST stamp now is a stale precondition: the job is re-read, still runs at
    // this seq ⇒ another dispatch of the same seq ⇒ the concurrent error, and nothing written.
    await expect(
      gravarCheckpointDaUnidadeLi(
        asDb(db),
        { jobId: JOB, seq: 2, versao: r1.versao },
        { fase: FASE_IMPORTACAO_LI.familias },
        AGORA_MS,
      ),
    ).rejects.toBeInstanceOf(LiImportacaoConcorrenteError);
    expect(db.ler(caminhoJobLi(JOB))?.fase).toBe('listagem');
  });

  it('the end-of-dispatch checkpoint is the ONLY one that bumps seq (seq + 1)', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { seq: 6 });
    const r1 = await gravarCheckpointDaUnidadeLi(
      asDb(db),
      { jobId: JOB, seq: 6, versao: v(carimbo) },
      progresso,
      AGORA_MS,
    );
    expect(db.ler(caminhoJobLi(JOB))?.seq).toBe(6);
    if (r1.tipo !== 'gravado') throw new Error('lost');
    const r2 = await gravarCheckpointDoFimDoDespachoLi(
      asDb(db),
      { jobId: JOB, seq: 6, versao: r1.versao },
      { pausas429: 1 },
      AGORA_MS,
    );
    expect(r2.tipo).toBe('gravado');
    expect(db.ler(caminhoJobLi(JOB))).toMatchObject({ seq: 7, pausas429: 1, status: 'executando' });
  });

  it('a CANCEL landing between two units: the checkpoint loses, re-reads, STOPS — and never re-applies its patch', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { seq: 1 });
    db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
      const r = await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS + 1);
      expect(r.tipo).toBe('cancelado');
    });
    const r = await gravarCheckpointDaUnidadeLi(
      asDb(db),
      { jobId: JOB, seq: 1, versao: v(carimbo) },
      progresso,
      AGORA_MS + 2,
    );
    expect(r).toMatchObject({ tipo: 'parar', job: { status: 'cancelado' } });
    const gravado = db.ler(caminhoJobLi(JOB));
    expect(gravado).toMatchObject({ status: 'cancelado', fase: 'catalogo' });
    // Only the cancel's write landed.
    expect(db.escritasEm(caminhoJobLi(JOB))).toHaveLength(1);
  });

  it('the job’s seq moved on (another dispatch ended this one): STOP, nothing written', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { seq: 1 });
    db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
      await gravarCheckpointDoFimDoDespachoLi(
        asDb(db),
        { jobId: JOB, seq: 1, versao: v(carimbo) },
        {},
        AGORA_MS,
      );
    });
    const r = await gravarCheckpointDaUnidadeLi(
      asDb(db),
      { jobId: JOB, seq: 1, versao: v(carimbo) },
      progresso,
      AGORA_MS,
    );
    expect(r).toMatchObject({ tipo: 'parar', job: { seq: 2 } });
    expect(db.ler(caminhoJobLi(JOB))?.fase).toBe('catalogo');
  });

  it('⚠️ EQUAL: a unit checkpoint whose REPLY was lost (the SDK’s retry met its own write) is recognised as written — the stored stamp, nothing written twice', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { seq: 1 });
    db.respostaPerdidaNaProximaEscrita(caminhoJobLi(JOB));
    const r = await gravarCheckpointDaUnidadeLi(
      asDb(db),
      { jobId: JOB, seq: 1, versao: v(carimbo) },
      progresso,
      AGORA_MS + 4,
    );
    expect(r).toEqual({ tipo: 'gravado', versao: db.carimboDe(caminhoJobLi(JOB)) });
    expect(db.escritasEm(caminhoJobLi(JOB))).toHaveLength(1);
    if (r.tipo !== 'gravado') throw new Error('lost');
    // The chain goes on from the stored stamp.
    const r2 = await gravarCheckpointDaUnidadeLi(
      asDb(db),
      { jobId: JOB, seq: 1, versao: r.versao },
      { fase: FASE_IMPORTACAO_LI.familias },
      AGORA_MS + 5,
    );
    expect(r2.tipo).toBe('gravado');
  });

  it('⚠️ NEAR-MISS: another write of the same seq that differs from ours in ONE field (its stamp, 1 ms apart) is NOT ours — the concurrent error, never adopted', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { seq: 1 });
    db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
      await gravarCheckpointDaUnidadeLi(
        asDb(db),
        { jobId: JOB, seq: 1, versao: v(carimbo) },
        progresso,
        AGORA_MS + 3,
      );
    });
    await expect(
      gravarCheckpointDaUnidadeLi(
        asDb(db),
        { jobId: JOB, seq: 1, versao: v(carimbo) },
        progresso,
        AGORA_MS + 4,
      ),
    ).rejects.toBeInstanceOf(LiImportacaoConcorrenteError);
    expect(db.ler(caminhoJobLi(JOB))?.atualizadoEmMs).toBe(AGORA_MS + 3);
  });

  it('⚠️ the END-of-dispatch checkpoint whose reply was lost is recognised as written: gravado at seq + 1, never a stop with nothing queued', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { seq: 4 });
    db.respostaPerdidaNaProximaEscrita(caminhoJobLi(JOB));
    const r = await gravarCheckpointDoFimDoDespachoLi(
      asDb(db),
      { jobId: JOB, seq: 4, versao: v(carimbo) },
      { pausas429: 1 },
      AGORA_MS,
    );
    expect(r).toEqual({ tipo: 'gravado', versao: db.carimboDe(caminhoJobLi(JOB)) });
    expect(db.ler(caminhoJobLi(JOB))).toMatchObject({ seq: 5, pausas429: 1 });
    expect(db.escritasEm(caminhoJobLi(JOB))).toHaveLength(1);
  });

  it('the job is gone: STOP with no job (the stamp fails with 9, as on the server)', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA);
    db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
      await importacaoLojaIntegradaCollection.docRef(asDb(db), {}, JOB).delete();
    });
    const r = await gravarCheckpointDaUnidadeLi(
      asDb(db),
      { jobId: JOB, seq: 0, versao: v(carimbo) },
      progresso,
      AGORA_MS,
    );
    expect(r).toEqual({ tipo: 'parar', job: null, versao: null });
    expect(db.ler(caminhoJobLi(JOB))).toBeUndefined();
  });

  it('a Firestore failure that is not a lost precondition is rethrown untouched', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA);
    const falha = Object.assign(new Error('UNAVAILABLE'), { code: 14 });
    db.falharEscrita(caminhoJobLi(JOB), falha);
    await expect(
      gravarCheckpointDaUnidadeLi(
        asDb(db),
        { jobId: JOB, seq: 0, versao: v(carimbo) },
        progresso,
        AGORA_MS,
      ),
    ).rejects.toBe(falha);
  });

  it.each(['seq', 'status', 'motivo', 'concluidoEmMs', 'integracaoId', 'modo', 'selecionados'])(
    'a checkpoint never writes `%s` (each has its own writer): TypeError, nothing written',
    async (campo) => {
      const db = new FakeDb();
      const carimbo = seedJobLi(db, JOB, CONTA);
      await expect(
        gravarCheckpointDaUnidadeLi(
          asDb(db),
          { jobId: JOB, seq: 0, versao: v(carimbo) },
          { [campo]: 1 } as ProgressoImportacaoLi,
          AGORA_MS,
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(db.escritas).toEqual([]);
    },
  );
});

describe('the terminal stamps', () => {
  it('concluido on the chain: status, both stamps, motivo null', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { seq: 3 });
    const r = await encerrarImportacaoLi(
      asDb(db),
      { jobId: JOB, seq: 3, versao: v(carimbo) },
      { status: STATUS_IMPORTACAO_LI.concluido },
      AGORA_MS + 9,
    );
    expect(r.tipo).toBe('encerrado');
    expect(db.ler(caminhoJobLi(JOB))).toMatchObject({
      status: 'concluido',
      motivo: null,
      concluidoEmMs: AGORA_MS + 9,
      atualizadoEmMs: AGORA_MS + 9,
      seq: 3,
    });
  });

  it('falhou with its closed motivo, with NO versao (the trigger’s case): reads, decides, stamps a pendente job', async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA, { status: 'pendente', seq: 0 });
    const r = await encerrarImportacaoLi(
      asDb(db),
      { jobId: JOB, seq: 0, versao: null },
      { status: STATUS_IMPORTACAO_LI.falhou, motivo: MOTIVO_FALHA_IMPORTACAO_LI.tarefasDesligadas },
      AGORA_MS,
    );
    expect(r.tipo).toBe('encerrado');
    expect(db.ler(caminhoJobLi(JOB))).toMatchObject({
      status: 'falhou',
      motivo: 'tarefas-desligadas',
    });
  });

  it.each<[string, Partial<{ status: StatusImportacaoLi; seq: number }>]>([
    ['a cancelled job', { status: STATUS_IMPORTACAO_LI.cancelado, seq: 0 }],
    ['a job already concluido', { status: STATUS_IMPORTACAO_LI.concluido, seq: 0 }],
    ['a job at another seq', { status: STATUS_IMPORTACAO_LI.executando, seq: 1 }],
  ])('⚠️ %s is never stamped: ja-encerrado, nothing written', async (_caso, over) => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA, over);
    const r = await encerrarImportacaoLi(
      asDb(db),
      { jobId: JOB, seq: 0, versao: null },
      {
        status: STATUS_IMPORTACAO_LI.falhou,
        motivo: MOTIVO_FALHA_IMPORTACAO_LI.chamadasDesligadas,
      },
      AGORA_MS,
    );
    expect(r.tipo).toBe('ja-encerrado');
    expect(db.escritas).toEqual([]);
  });

  it('a cancel that won the race is never overwritten: the chained stamp loses, re-reads, writes nothing', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { seq: 2 });
    db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
      await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS);
    });
    const r = await encerrarImportacaoLi(
      asDb(db),
      { jobId: JOB, seq: 2, versao: v(carimbo) },
      { status: STATUS_IMPORTACAO_LI.concluido },
      AGORA_MS,
    );
    expect(r).toMatchObject({ tipo: 'ja-encerrado', job: { status: 'cancelado' } });
    expect(db.ler(caminhoJobLi(JOB))?.status).toBe('cancelado');
  });

  it('a stamp whose REPLY was lost is recognised as written: encerrado, never ja-encerrado', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { seq: 3 });
    db.respostaPerdidaNaProximaEscrita(caminhoJobLi(JOB));
    const r = await encerrarImportacaoLi(
      asDb(db),
      { jobId: JOB, seq: 3, versao: v(carimbo) },
      { status: STATUS_IMPORTACAO_LI.concluido },
      AGORA_MS + 9,
    );
    expect(r).toEqual({ tipo: 'encerrado', versao: db.carimboDe(caminhoJobLi(JOB)) });
    expect(db.escritasEm(caminhoJobLi(JOB))).toHaveLength(1);
  });

  it('a write of the same seq landing first: the stamp re-reads and lands on the fresh read', async () => {
    const db = new FakeDb();
    const carimbo = seedJobLi(db, JOB, CONTA, { seq: 2 });
    db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
      await gravarCheckpointDaUnidadeLi(
        asDb(db),
        { jobId: JOB, seq: 2, versao: v(carimbo) },
        { fase: FASE_IMPORTACAO_LI.familias },
        AGORA_MS,
      );
    });
    const r = await encerrarImportacaoLi(
      asDb(db),
      { jobId: JOB, seq: 2, versao: v(carimbo) },
      {
        status: STATUS_IMPORTACAO_LI.falhou,
        motivo: MOTIVO_FALHA_IMPORTACAO_LI.tentativasEsgotadas,
      },
      AGORA_MS,
    );
    expect(r.tipo).toBe('encerrado');
    expect(db.ler(caminhoJobLi(JOB))).toMatchObject({
      status: 'falhou',
      motivo: 'tentativas-esgotadas',
      fase: 'familias',
    });
  });

  it(`after ${String(MAX_TENTATIVAS_ESCRITA_JOB_LI)} lost preconditions in a row: LiImportacaoConcorrenteError, nothing stamped`, async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA, { seq: 0 });
    checkpointAntesDeCadaEscrita(db, MAX_TENTATIVAS_ESCRITA_JOB_LI);
    await expect(
      encerrarImportacaoLi(
        asDb(db),
        { jobId: JOB, seq: 0, versao: null },
        { status: STATUS_IMPORTACAO_LI.concluido },
        AGORA_MS,
      ),
    ).rejects.toBeInstanceOf(LiImportacaoConcorrenteError);
    // Every attempt lost to a checkpoint, and none of them stamped anything.
    expect(db.ler(caminhoJobLi(JOB))).toMatchObject({
      status: 'executando',
      pausas429: MAX_TENTATIVAS_ESCRITA_JOB_LI,
    });
  });

  it('⚠️ NEAR-MISS: one lost precondition fewer, and the stamp lands on the last fresh read', async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA, { seq: 0 });
    checkpointAntesDeCadaEscrita(db, MAX_TENTATIVAS_ESCRITA_JOB_LI - 1);
    const r = await encerrarImportacaoLi(
      asDb(db),
      { jobId: JOB, seq: 0, versao: null },
      { status: STATUS_IMPORTACAO_LI.concluido },
      AGORA_MS,
    );
    expect(r.tipo).toBe('encerrado');
    expect(db.ler(caminhoJobLi(JOB))).toMatchObject({
      status: 'concluido',
      pausas429: MAX_TENTATIVAS_ESCRITA_JOB_LI - 1,
    });
  });
});

describe('the cancel: tier 1 on the route’s own read', () => {
  it.each<StatusImportacaoLi>([STATUS_IMPORTACAO_LI.pendente, STATUS_IMPORTACAO_LI.executando])(
    'a %s job is stamped cancelado; the answer is the job as written',
    async (status) => {
      const db = new FakeDb();
      seedJobLi(db, JOB, CONTA, { status });
      const r = await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS + 3);
      expect(r).toMatchObject({
        tipo: 'cancelado',
        resposta: { jobId: JOB, status: 'cancelado', concluidoEmMs: AGORA_MS + 3 },
      });
      expect(db.ler(caminhoJobLi(JOB))).toMatchObject({
        status: 'cancelado',
        concluidoEmMs: AGORA_MS + 3,
        atualizadoEmMs: AGORA_MS + 3,
      });
      // ONE guarded update, nothing else.
      expect(db.escritas.map((e) => e.verbo)).toEqual(['update']);
    },
  );

  it.each<StatusImportacaoLi>([
    STATUS_IMPORTACAO_LI.concluido,
    STATUS_IMPORTACAO_LI.falhou,
    STATUS_IMPORTACAO_LI.cancelado,
  ])('⚠️ a %s job is never relabelled: encerrada, nothing written', async (status) => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA, { status });
    expect(await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS)).toEqual({
      tipo: 'encerrada',
    });
    expect(db.escritas).toEqual([]);
  });

  it('a missing job and another conta’s job are the same answer, and nothing is written', async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, OUTRA);
    expect(await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS)).toEqual({
      tipo: 'nao-encontrada',
    });
    expect(await cancelarImportacaoLi(asDb(db), CONTA, 'semJob', AGORA_MS)).toEqual({
      tipo: 'nao-encontrada',
    });
    expect(db.escritas).toEqual([]);
  });

  it('a checkpoint landing between the read and the write: re-read, re-decided, cancelled on the 2nd attempt', async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA, { seq: 0 });
    db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
      const lido = await lerJobLi(asDb(db), JOB);
      await gravarCheckpointDaUnidadeLi(
        asDb(db),
        { jobId: JOB, seq: 0, versao: lido!.versao },
        { fase: FASE_IMPORTACAO_LI.listagem },
        AGORA_MS,
      );
    });
    const r = await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS + 1);
    expect(r.tipo).toBe('cancelado');
    expect(db.ler(caminhoJobLi(JOB))).toMatchObject({ status: 'cancelado', fase: 'listagem' });
  });

  it('⚠️ a cancel whose REPLY was lost is recognised as written: cancelado, never encerrada for a cancel that landed', async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA, { status: 'executando', seq: 2 });
    db.respostaPerdidaNaProximaEscrita(caminhoJobLi(JOB));
    const r = await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS + 7);
    expect(r).toMatchObject({
      tipo: 'cancelado',
      resposta: { jobId: JOB, status: 'cancelado', concluidoEmMs: AGORA_MS + 7 },
    });
    expect(db.escritasEm(caminhoJobLi(JOB))).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: a cancel by ANOTHER request landing first (its own instant) is not ours — encerrada', async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA, { status: 'executando', seq: 2 });
    db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
      await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS + 6);
    });
    expect(await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS + 7)).toEqual({
      tipo: 'encerrada',
    });
    expect(db.ler(caminhoJobLi(JOB))?.concluidoEmMs).toBe(AGORA_MS + 6);
  });

  it('the job ENDING between the read and the write: re-read ⇒ encerrada, never relabelled', async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA, { seq: 0 });
    db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
      await encerrarImportacaoLi(
        asDb(db),
        { jobId: JOB, seq: 0, versao: null },
        { status: STATUS_IMPORTACAO_LI.concluido },
        AGORA_MS,
      );
    });
    expect(await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS)).toEqual({
      tipo: 'encerrada',
    });
    expect(db.ler(caminhoJobLi(JOB))?.status).toBe('concluido');
  });

  it(`${String(MAX_TENTATIVAS_ESCRITA_JOB_LI)} lost preconditions in a row: LiCancelamentoEmConflitoError, nothing written by the cancel`, async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA, { seq: 0 });
    checkpointAntesDeCadaEscrita(db, MAX_TENTATIVAS_ESCRITA_JOB_LI);
    await expect(cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS)).rejects.toBeInstanceOf(
      LiCancelamentoEmConflitoError,
    );
    expect(db.ler(caminhoJobLi(JOB))).toMatchObject({
      status: 'executando',
      pausas429: MAX_TENTATIVAS_ESCRITA_JOB_LI,
    });
  });

  it('⚠️ NEAR-MISS: one lost precondition fewer, and the cancel lands on its last read', async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA, { seq: 0 });
    checkpointAntesDeCadaEscrita(db, MAX_TENTATIVAS_ESCRITA_JOB_LI - 1);
    const r = await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS);
    expect(r.tipo).toBe('cancelado');
    expect(db.ler(caminhoJobLi(JOB))).toMatchObject({
      status: 'cancelado',
      pausas429: MAX_TENTATIVAS_ESCRITA_JOB_LI - 1,
    });
  });
});

describe('the report pages: document-key order after the cursor', () => {
  it('a page of 500, then the rest; proximo is the last id of a full page, null on the last', async () => {
    const db = new FakeDb();
    seedJobLi(db, JOB, CONTA);
    const ids = Array.from({ length: LIMITE_ITENS_IMPORTACAO_LI + 3 }, (_, i) => 100_000 + i);
    for (const id of ids) seedItemLi(db, JOB, id);
    seedItemLi(db, 'outroJob', 1);

    const p1 = await lerItensDaImportacaoLi(asDb(db), JOB, null);
    expect(p1.itens).toHaveLength(LIMITE_ITENS_IMPORTACAO_LI);
    expect(p1.itens[0]?.liId).toBe(100_000);
    expect(p1.proximo).toBe(String(100_000 + LIMITE_ITENS_IMPORTACAO_LI - 1));
    expect(db.consultas.at(-1)).toEqual({
      colecao: `${caminhoJobLi(JOB)}/itens`,
      filtros: [],
      ordens: [['__name__', 'asc']],
      limite: LIMITE_ITENS_IMPORTACAO_LI + 1,
      apos: null,
    });

    const p2 = await lerItensDaImportacaoLi(asDb(db), JOB, p1.proximo);
    expect(p2.itens.map((i) => i.liId)).toEqual(ids.slice(LIMITE_ITENS_IMPORTACAO_LI));
    expect(p2.proximo).toBeNull();
    expect(db.consultas.at(-1)?.apos).toBe(p1.proximo);
  });

  it('⚠️ NEAR-MISS: a page of EXACTLY 500 is the last one (the extra read finds nothing)', async () => {
    const db = new FakeDb();
    for (let i = 0; i < LIMITE_ITENS_IMPORTACAO_LI; i += 1) seedItemLi(db, JOB, 200_000 + i);
    const p = await lerItensDaImportacaoLi(asDb(db), JOB, null);
    expect(p.itens).toHaveLength(LIMITE_ITENS_IMPORTACAO_LI);
    expect(p.proximo).toBeNull();
  });

  it('key order is TEXT order, and an answer carries the pendência codes as plain strings', async () => {
    const db = new FakeDb();
    seedItemLi(db, JOB, 9, {
      pendencias: [{ codigo: 'sem-sku', acionavel: true }],
    });
    seedItemLi(db, JOB, 10);
    const p = await lerItensDaImportacaoLi(asDb(db), JOB, null);
    expect(p.itens.map((i) => i.liId)).toEqual([10, 9]);
    expect(p.itens[1]?.pendencias).toEqual([
      { codigo: 'sem-sku', acionavel: true, liId: null, referencias: [] },
    ]);
  });

  it('a stored item that does not parse is rethrown (ZodError), never dropped from the page', async () => {
    const db = new FakeDb();
    db.seed(caminhoItemLi(JOB, '1'), { liId: 'um' });
    await expect(lerItensDaImportacaoLi(asDb(db), JOB, null)).rejects.toBeInstanceOf(ZodError);
  });

  it.each([
    ['182904918', true],
    ['1', true],
    ['', false],
    ['-1', false],
    ['1.0', false],
    [' 1', false],
    ['a1', false],
    ['1/2', false],
    ['12345678901234567', false],
  ])('the cursor %j is usable = %s', (depois, ok) => {
    expect(ehCursorDeItensLi(depois)).toBe(ok);
  });
});
