/**
 * `fimReconcile.ts` (master plan step 12, PR 12-g): the daily reconcile's END phase inside the slice
 * machine — the avisos raised or resolved ONCE per conta per run, only under `on` and for a conta
 * the valve is live for, clocked by the run's start; a dry-run reads and writes no aviso and says
 * the counts as info lines; `sem-linha-na-loja` decided only after a whole list and a full
 * confirmation; `ultimoReconcile` with the conta's counters; a gone conta gets nothing; the lease
 * released. Against `testing/fakeDb.ts`. No Loja Integrada call: `fetch` throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOTIVO_ESTOQUE_VINCULO_LI,
  TIPO_AVISO,
  TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  chaveDeAviso,
} from '@delfrance/schemas';

import { relogioDoEnvioDeEstoqueUs } from '../../avisos/avisos';
import { CANARIO_ENV_LI, VALVULA_ENV_LI } from '../../core/valvulas';
import { FakeDb, asDb } from '../../testing/fakeDb';
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
import { type DepsReconcileEstoqueLi, despacharReconcileEstoqueLi } from './despachoReconcile';
import {
  MOTIVO_RESOLUCAO_RECONCILE_LI,
  casosDoFimLi,
  contadoresDaContaLi,
  idExecucaoRedepositoLi,
} from './fimReconcile';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('fimReconcile.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const tarefa = (seq: number) => ({
  tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  execucaoId: RUN_A,
  seq,
});
const chaveSemErp = (conta: string) =>
  chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaEstoqueSemErp, conta });
const chaveVinculo = (conta: string, motivo: string) =>
  chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaEstoqueVinculo, conta, entidade: motivo });

/** C1 (dep-1) and C2 (dep-2) at the END phase, with counters and the root's samples. */
function emFim(
  contadores: Readonly<Record<string, number>>,
  amostras: Readonly<Record<string, readonly string[]>> = {},
) {
  const db = new FakeDb();
  seedContaComDeposito(db, 'C1', refDeposito('dep-1'), { nome: 'Loja Um' });
  seedContaComDeposito(db, 'C2', refDeposito('dep-2'), { nome: 'Loja Dois' });
  seedRunNaFaseLi(
    db,
    [
      { contaId: 'C1', depositoId: 'dep-1', raiz: { execucao: { amostras } } },
      { contaId: 'C2', depositoId: 'dep-2' },
    ],
    { fase: 'fim', idxConta: 0, contadores: { ...contadores } },
  );
  return db;
}

function deps(
  o: { readonly modo?: string; readonly canario?: string } = {},
): ReturnType<typeof montar> {
  return montar(o);
}

function montar(o: { readonly modo?: string; readonly canario?: string }) {
  const log = loggerGravador();
  const fila = agendadorGravador();
  const d: DepsReconcileEstoqueLi = {
    ambiente: {
      [VALVULA_ENV_LI.estoque]: o.modo ?? 'on',
      [CANARIO_ENV_LI.estoque]: o.canario ?? '*',
    },
    agoraMs: () => AGORA_RECONCILE_MS,
    inicioMs: AGORA_RECONCILE_MS,
    tentativa: 0,
    idTarefa: null,
    esperar: () => Promise.resolve(),
    increment: (by) => ({ __increment: by }),
    agendador: () => fila.agendador,
    agendadorEstoque: () => filaEstoqueGravadora().agendador,
    logger: log.logger,
    escrever: () => undefined,
  };
  return { d, log, fila };
}

const avisosLidos = (db: FakeDb) => db.leituras.filter((l) => l.startsWith('avisos/'));
const avisosGravados = (db: FakeDb) => db.escritas.filter((e) => e.caminho.startsWith('avisos/'));

describe('the pure pieces', () => {
  it('a conta’s counters, the prefix taken off; ⚠️ NEAR-MISS: c1 never takes c10’s', () => {
    expect(
      contadoresDaContaLi({ c1Validos: 3, c10Validos: 9, c1X: 1, c1: 4, paginasErp: 2 }, 1),
    ).toEqual({ validos: 3, x: 1 });
    expect(contadoresDaContaLi({ c1Validos: 3, c10Validos: 9 }, 10)).toEqual({ validos: 9 });
  });

  it('the gate’s row counts zeroPorDeposito ONLY when the gate tripped; sem-linha resolves only after a whole list AND a full confirmation', () => {
    const porMotivo = (c: Record<string, number>) =>
      Object.fromEntries(casosDoFimLi(c).map((k) => [k.motivo ?? 'semErp', k]));
    expect(
      porMotivo({ zeroPorDeposito: 7 })[MOTIVO_ESTOQUE_VINCULO_LI.depositoSemRegistros]?.produtos,
    ).toBe(0);
    expect(
      porMotivo({ zeroPorDeposito: 7, bloqueadoDeposito: 1 })[
        MOTIVO_ESTOQUE_VINCULO_LI.depositoSemRegistros
      ]?.produtos,
    ).toBe(7);
    const semLinha = (c: Record<string, number>) =>
      porMotivo(c)[MOTIVO_ESTOQUE_VINCULO_LI.semLinhaNaLoja]?.resolvivel;
    expect(semLinha({ listaCompleta: 1, verificacaoFeita: 1 })).toBe(true);
    expect(semLinha({ listaCompleta: 1 })).toBe(false);
    expect(semLinha({ verificacaoFeita: 1 })).toBe(false);
    expect(casosDoFimLi({})).toHaveLength(7);
  });

  it('the depósito re-run is named by the conta document’s update time: the same read, the same name', () => {
    expect(idExecucaoRedepositoLi(1_768_000_000_123_456)).toBe(
      'estoque-reconcile-redeposito-1768000000123456',
    );
    expect(idExecucaoRedepositoLi(5)).toBe(idExecucaoRedepositoLi(5));
  });
});

describe('the end phase under on', () => {
  it('raises the held aviso (count, the sample sorted) and a duplicate one, clocked by the RUN’s start; writes ultimoReconcile; releases the lease', async () => {
    const db = emFim(
      { c0Retidos: 3, c0Duplicados: 2, c0Validos: 5, c1Validos: 1 },
      { retido: ['pc', 'pa', 'pb'], duplicado: ['d2', 'd1'] },
    );
    const { d } = deps();

    const r = await despacharReconcileEstoqueLi(asDb(db), tarefa(5), d);

    expect(r).toEqual({ kind: 'encerrado' });
    const semErp = db.ler(`avisos/${chaveSemErp('C1')}`);
    expect(semErp).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaEstoqueSemErp,
      params: { loja: 'Loja Um', produtos: 3, amostra: 'pa, pb, pc' },
      relogioEvento: relogioDoEnvioDeEstoqueUs(INICIO_RUN_RECONCILE_MS),
      resolvidoEm: null,
    });
    expect(db.ler(`avisos/${chaveVinculo('C1', 'duplicado')}`)).toMatchObject({
      motivo: 'duplicado',
      params: { loja: 'Loja Um', motivo: 'duplicado', produtos: 2, amostra: 'd1, d2' },
    });
    // Nothing open anywhere else: no row seeded resolved.
    expect(
      avisosGravados(db)
        .map((e) => e.caminho)
        .sort(),
    ).toEqual([`avisos/${chaveSemErp('C1')}`, `avisos/${chaveVinculo('C1', 'duplicado')}`].sort());
    expect(db.ler('sincEstoqueLojaIntegrada/C1')).toMatchObject({
      reconcile: null,
      ultimoReconcile: {
        execucaoId: RUN_A,
        iniciadoEmMs: INICIO_RUN_RECONCILE_MS,
        concluidoEmMs: AGORA_RECONCILE_MS,
        contadores: { retidos: 3, duplicados: 2, validos: 5 },
      },
    });
    expect(db.ler('sincEstoqueLojaIntegrada/C2')?.ultimoReconcile).toMatchObject({
      contadores: { validos: 1 },
    });
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)).toMatchObject({ emExecucaoAteMs: 0, seq: 6 });
  });

  it('a later clean run RESOLVES an open row (once); a conta with no open row costs one read per row and NO aviso write', async () => {
    const db = emFim({ c0Retidos: 1 }, { retido: ['p1'] });
    await despacharReconcileEstoqueLi(asDb(db), tarefa(5), deps().d);
    expect(db.ler(`avisos/${chaveSemErp('C1')}`)?.resolvidoEm).toBeNull();

    // The next run: nothing held any more. Its start is later.
    const db2 = new FakeDb();
    for (const [caminho, dados] of [
      [`avisos/${chaveSemErp('C1')}`, db.ler(`avisos/${chaveSemErp('C1')}`)],
    ] as const) {
      if (dados !== undefined) db2.seed(caminho, dados);
    }
    seedContaComDeposito(db2, 'C1', refDeposito('dep-1'), { nome: 'Loja Um' });
    seedContaComDeposito(db2, 'C2', refDeposito('dep-2'), { nome: 'Loja Dois' });
    seedRunNaFaseLi(
      db2,
      [
        { contaId: 'C1', depositoId: 'dep-1' },
        { contaId: 'C2', depositoId: 'dep-2' },
      ],
      {
        fase: 'fim',
        idxConta: 0,
        contadores: {},
        iniciadoEmMs: INICIO_RUN_RECONCILE_MS + 86_400_000,
      },
    );
    const r2 = await despacharReconcileEstoqueLi(asDb(db2), tarefa(5), {
      ...deps().d,
      agoraMs: () => AGORA_RECONCILE_MS + 86_400_000,
      inicioMs: AGORA_RECONCILE_MS + 86_400_000,
    });
    expect(r2).toEqual({ kind: 'encerrado' });
    expect(db2.ler(`avisos/${chaveSemErp('C1')}`)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_RECONCILE_LI,
    });
    expect(db2.ler(`avisos/${chaveSemErp('C1')}`)?.resolvidoEm).not.toBeNull();
    // Only the one open row was written; every other row was read once and left absent.
    expect(avisosGravados(db2).map((e) => e.caminho)).toEqual([`avisos/${chaveSemErp('C1')}`]);
    // 6 decidable rows per conta, each read once (sem-linha-na-loja is not decidable: no list was
    // read), and C1's open row read again by the resolve itself.
    expect(avisosLidos(db2).length).toBe(6 * 2 + 1);
  });

  it('⚠️ sem-linha-na-loja: an open row is LEFT when the conta’s list was not read whole; resolved once it was and every unseen child was confirmed', async () => {
    const aberto = (db: FakeDb) => {
      db.seed(`avisos/${chaveVinculo('C1', 'sem-linha-na-loja')}`, {
        tipo: TIPO_AVISO.lojaIntegradaEstoqueVinculo,
        conta: 'C1',
        entidade: 'sem-linha-na-loja',
        severidade: 'atencao',
        canal: 'lojaIntegrada',
        params: { loja: 'Loja Um', motivo: 'sem-linha-na-loja', produtos: 1 },
        motivo: 'sem-linha-na-loja',
        destinatarioUid: null,
        urlInterna: null,
        urlExterna: null,
        prazo: null,
        relogioEvento: relogioDoEnvioDeEstoqueUs(INICIO_RUN_RECONCILE_MS - 86_400_000),
        criadoEm: 1,
        atualizadoEm: 1,
        ocorrencias: 1,
        resolvidoEm: null,
        resolucaoMotivo: null,
      });
    };
    const incompleta = emFim({ c0ChamadasDesligadas: 1 });
    aberto(incompleta);
    await despacharReconcileEstoqueLi(asDb(incompleta), tarefa(5), deps().d);
    expect(
      incompleta.ler(`avisos/${chaveVinculo('C1', 'sem-linha-na-loja')}`)?.resolvidoEm,
    ).toBeNull();

    const completa = emFim({ c0ListaCompleta: 1, c0VerificacaoFeita: 1 });
    aberto(completa);
    await despacharReconcileEstoqueLi(asDb(completa), tarefa(5), deps().d);
    expect(
      completa.ler(`avisos/${chaveVinculo('C1', 'sem-linha-na-loja')}`)?.resolvidoEm,
    ).not.toBeNull();
  });

  it('the safety gate’s aviso: bloqueadoDeposito ⇒ the deposito-sem-registros row with the gate’s count and sample', async () => {
    const db = emFim(
      { c0BloqueadoDeposito: 1, c0ZeroPorDeposito: 7, c0Avaliados: 20 },
      { 'deposito-sem-registros': ['z2', 'z1'] },
    );
    await despacharReconcileEstoqueLi(asDb(db), tarefa(5), deps().d);
    expect(db.ler(`avisos/${chaveVinculo('C1', 'deposito-sem-registros')}`)).toMatchObject({
      params: { motivo: 'deposito-sem-registros', produtos: 7, amostra: 'z1, z2' },
    });
  });

  it('a conta GONE by the end gets nothing: no root write, no aviso read or written', async () => {
    const db = emFim({ c0Retidos: 2 });
    db.seed('integracao/C1', { tipo: 99, nome: 'outra coisa' });
    await despacharReconcileEstoqueLi(asDb(db), tarefa(5), deps().d);
    expect(db.ler('sincEstoqueLojaIntegrada/C1')?.ultimoReconcile).toBeNull();
    expect(avisosLidos(db).some((l) => l.includes(':C1'))).toBe(false);
    expect(db.ler('sincEstoqueLojaIntegrada/C2')?.ultimoReconcile).toMatchObject({
      execucaoId: RUN_A,
    });
  });
});

describe('no aviso unless the valve is live for the conta', () => {
  it('⚠️ DRY-RUN: zero aviso reads or writes; ONE info line per non-zero row (count and sample); ultimoReconcile still written', async () => {
    const db = emFim({ c0Retidos: 2, c0Ausentes: 1 }, { retido: ['b', 'a'], ausente: ['x'] });
    const { d, log } = deps({ modo: 'dry-run' });
    await despacharReconcileEstoqueLi(asDb(db), tarefa(5), d);
    expect(avisosLidos(db)).toEqual([]);
    expect(avisosGravados(db)).toEqual([]);
    const linhas = log.linhas.filter((l) => l.msg.endsWith('achado da conta (sem aviso)'));
    expect(
      linhas.map((l) => [l.meta.contaId, l.meta.motivo, l.meta.produtos, l.meta.amostra]),
    ).toEqual([
      ['C1', null, 2, ['a', 'b']],
      ['C1', 'ausente', 1, ['x']],
    ]);
    expect(db.ler('sincEstoqueLojaIntegrada/C1')?.ultimoReconcile).toMatchObject({
      execucaoId: RUN_A,
    });
  });

  it('⚠️ NEAR-MISS: under on with a canary list naming only C2, C1 gets no aviso (info lines) and C2 does', async () => {
    const db = emFim({ c0Retidos: 1, c1Retidos: 1 });
    await despacharReconcileEstoqueLi(asDb(db), tarefa(5), deps({ canario: 'C2:7' }).d);
    expect(db.ler(`avisos/${chaveSemErp('C1')}`)).toBeUndefined();
    expect(db.ler(`avisos/${chaveSemErp('C2')}`)).toMatchObject({ params: { produtos: 1 } });
  });

  it('a conta whose depósito moved gets no aviso, and after the release ONE full run is enqueued, named by the conta’s update time', async () => {
    const db = emFim({ c0Retidos: 1 });
    seedContaComDeposito(db, 'C1', refDeposito('dep-9'), { nome: 'Loja Um' });
    const { d, fila } = deps();
    const r = await despacharReconcileEstoqueLi(asDb(db), tarefa(5), d);
    expect(r).toEqual({ kind: 'encerrado' });
    expect(db.ler(`avisos/${chaveSemErp('C1')}`)).toBeUndefined();
    expect(fila.enfileirados).toHaveLength(1);
    expect(fila.enfileirados[0]?.execucaoId).toMatch(/^estoque-reconcile-redeposito-\d+$/);
  });
});
