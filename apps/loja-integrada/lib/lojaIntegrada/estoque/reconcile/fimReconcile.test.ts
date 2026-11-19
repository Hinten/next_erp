/**
 * `fimReconcile.ts` (master plan step 12, PR 12-g): the daily reconcile's END phase inside the slice
 * machine — the avisos raised or resolved ONCE per conta per run, only under `on` and for a conta
 * the valve is live for, clocked by the run's start; a dry-run reads and writes no aviso and says
 * the counts as info lines; `sem-linha-na-loja` decided only after a whole list and a full
 * confirmation; `ultimoReconcile` with the conta's counters; a gone conta gets nothing; the lease
 * released; the end spread over two slices under the budget; and the release's ONE question — does
 * a depósito change ask for a new full run? — asked of the contas LISTED again, the run enqueued
 * only AFTER the release lands, and repaired when the release landed behind an error. Against
 * `testing/fakeDb.ts`. No Loja Integrada call: `fetch` throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import {
  MOTIVO_ESTOQUE_VINCULO_LI,
  TIPO_AVISO,
  TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  chaveDeAviso,
} from '@delfrance/schemas';

import { relogioDoDocumentoUs, relogioDoEnvioDeEstoqueUs } from '../../avisos/avisos';
import { CANARIO_ENV_LI, VALVULA_ENV_LI } from '../../core/valvulas';
import { FakeDb, asDb, grpc } from '../../testing/fakeDb';
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
import { CONTADOR_DEPOSITO_MUDOU_LI, idExecucaoRedepositoLi } from './contasReconcile';
import { type DepsReconcileEstoqueLi, despacharReconcileEstoqueLi } from './despachoReconcile';
import { MOTIVO_RESOLUCAO_RECONCILE_LI, casosDoFimLi, contadoresDaContaLi } from './fimReconcile';

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

interface OpcoesMundoFim {
  readonly modo?: string;
  readonly canario?: string;
  /** Called at each reads-queue enqueue (`agendadorGravador`'s probe). */
  readonly sonda?: () => unknown;
}

function deps(o: OpcoesMundoFim = {}): ReturnType<typeof montar> {
  return montar(o);
}

function montar(o: OpcoesMundoFim) {
  const log = loggerGravador();
  const fila = agendadorGravador(undefined, o.sonda);
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

  it('a conta deactivated after the store phase gets its ultimoReconcile but NO aviso, and asks for no re-run', async () => {
    const db = emFim({ c0Retidos: 1 });
    seedContaComDeposito(db, 'C1', refDeposito('dep-1'), { nome: 'Loja Um', ativo: false });
    const { d, fila } = deps();
    expect(await despacharReconcileEstoqueLi(asDb(db), tarefa(5), d)).toEqual({
      kind: 'encerrado',
    });
    expect(avisosLidos(db).some((l) => l.includes(':C1'))).toBe(false);
    expect(db.ler('sincEstoqueLojaIntegrada/C1')?.ultimoReconcile).toMatchObject({
      execucaoId: RUN_A,
    });
    expect(fila.enfileirados).toEqual([]);
  });
});

/** µs of the stored conta's last write: what names the depósito re-run. */
const versaoDaConta = (db: FakeDb, contaId: string): number => {
  const carimbo = db.carimboDe(`integracao/${contaId}`);
  if (carimbo === undefined) throw new Error(`integracao/${contaId} ausente`);
  return relogioDoDocumentoUs(carimbo);
};

describe('the release asks for ONE new full run when a depósito change needs it', () => {
  it('⚠️ a conta re-pointed while the run held the lease: no aviso; the contas LISTED again at the release; ONE run named by THAT conta’s update time, enqueued only AFTER the release landed', async () => {
    const db = emFim({ c0Retidos: 1 });
    seedContaComDeposito(db, 'C1', refDeposito('dep-9'), { nome: 'Loja Um' });
    const { d, fila } = deps({ sonda: () => db.ler(CAMINHO_RUN_RECONCILE_LI)?.emExecucaoAteMs });
    const r = await despacharReconcileEstoqueLi(asDb(db), tarefa(5), d);
    expect(r).toEqual({ kind: 'encerrado' });
    expect(db.ler(`avisos/${chaveSemErp('C1')}`)).toBeUndefined();
    const versao = versaoDaConta(db, 'C1');
    expect(fila.enfileirados).toEqual([
      { execucaoId: idExecucaoRedepositoLi(versao), seq: 0, atrasoS: 0 },
    ]);
    // Enqueued with the lease ALREADY released: its first slice never meets this run's lease.
    expect(fila.sondados).toEqual([0]);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).toMatchObject({
      [CONTADOR_DEPOSITO_MUDOU_LI]: versao,
    });
    // ONE listing of the contas (the take's own query) — the release's only extra query.
    expect(db.consultas.filter((c) => c.colecao === 'integracao')).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: a depósito REMOVED (D1 → none) asks for nothing — the arm’s own rule: nothing to send to; the other spelling of one depósito is no change either', async () => {
    const db = emFim({});
    seedContaComDeposito(db, 'C1', null, { nome: 'Loja Um' });
    seedContaComDeposito(db, 'C2', 'depositos/dep-2', { nome: 'Loja Dois' });
    const { d, fila } = deps();
    expect(await despacharReconcileEstoqueLi(asDb(db), tarefa(5), d)).toEqual({
      kind: 'encerrado',
    });
    expect(fila.enfileirados).toEqual([]);
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)?.contadores).not.toHaveProperty(
      CONTADOR_DEPOSITO_MUDOU_LI,
    );
  });

  it('⚠️ a conta the run did NOT take (no depósito at the take) given one meanwhile asks for the run too; an inactive one does not', async () => {
    const db = emFim({});
    seedContaComDeposito(db, 'C3', refDeposito('dep-3'), { nome: 'Loja Tres' });
    seedContaComDeposito(db, 'C5', refDeposito('dep-5'), { nome: 'Loja Cinco', ativo: false });
    const { d, fila } = deps();
    await despacharReconcileEstoqueLi(asDb(db), tarefa(5), d);
    expect(fila.enfileirados).toEqual([
      { execucaoId: idExecucaoRedepositoLi(versaoDaConta(db, 'C3')), seq: 0, atrasoS: 0 },
    ]);
    // Only the suspect is read again by id (its stamps), never the inactive one.
    expect(db.leituras.filter((l) => l === 'integracao/C5')).toEqual([]);
  });

  it('⚠️ NEAR-MISS: a conta CREATED during the run with a depósito and never written since asks for nothing (the arm never fires on a create); one written after its create does', async () => {
    const db = new FakeDb();
    // The run started before every stamp this fake issues.
    const inicio = Math.floor(relogioDoDocumentoUs(db.seed('marco/inicio', {})) / 1000);
    seedContaComDeposito(db, 'C1', refDeposito('dep-1'), { nome: 'Loja Um' });
    seedContaComDeposito(db, 'C2', refDeposito('dep-2'), { nome: 'Loja Dois' });
    seedRunNaFaseLi(
      db,
      [
        { contaId: 'C1', depositoId: 'dep-1' },
        { contaId: 'C2', depositoId: 'dep-2' },
      ],
      { fase: 'fim', idxConta: 0, iniciadoEmMs: inicio },
    );
    seedContaComDeposito(db, 'C3', refDeposito('dep-3'), { nome: 'Nova' });
    const { d, fila } = deps();
    await despacharReconcileEstoqueLi(asDb(db), tarefa(5), d);
    expect(fila.enfileirados).toEqual([]);

    const db2 = new FakeDb();
    const inicio2 = Math.floor(relogioDoDocumentoUs(db2.seed('marco/inicio', {})) / 1000);
    seedContaComDeposito(db2, 'C1', refDeposito('dep-1'), { nome: 'Loja Um' });
    seedContaComDeposito(db2, 'C2', refDeposito('dep-2'), { nome: 'Loja Dois' });
    seedRunNaFaseLi(
      db2,
      [
        { contaId: 'C1', depositoId: 'dep-1' },
        { contaId: 'C2', depositoId: 'dep-2' },
      ],
      { fase: 'fim', idxConta: 0, iniciadoEmMs: inicio2 },
    );
    seedContaComDeposito(db2, 'C3', null, { nome: 'Nova' });
    seedContaComDeposito(db2, 'C3', refDeposito('dep-3'), { nome: 'Nova' });
    const m2 = deps();
    await despacharReconcileEstoqueLi(asDb(db2), tarefa(5), m2.d);
    expect(m2.fila.enfileirados).toEqual([
      { execucaoId: idExecucaoRedepositoLi(versaoDaConta(db2, 'C3')), seq: 0, atrasoS: 0 },
    ]);
  });

  it('⚠️ the end spread over TWO slices: the budget stops after C1; C1 is re-pointed between the slices and the arm’s own run is refused (ocupado); the release still asks for ONE run, named by C1’s update time', async () => {
    const db = emFim({ c0Retidos: 1, c1Retidos: 1 });
    const relogio = { agora: AGORA_RECONCILE_MS };
    const base = deps({ modo: 'dry-run' });
    // C1's end logs its one line; then the clock is past the end unit's budget (50 000 ms).
    const logger = {
      ...base.log.logger,
      info: (msg: string, meta?: Record<string, unknown>) => {
        base.log.logger.info(msg, meta);
        if (msg.endsWith('achado da conta (sem aviso)') && meta?.contaId === 'C1') {
          relogio.agora += 50_001;
        }
      },
    };
    const d = (): DepsReconcileEstoqueLi => ({
      ...base.d,
      agoraMs: () => relogio.agora,
      inicioMs: relogio.agora,
      logger,
    });

    const r1 = await despacharReconcileEstoqueLi(asDb(db), tarefa(5), d());
    expect(r1).toEqual({ kind: 'continua', fase: 'fim', seq: 6 });
    expect(db.ler(CAMINHO_RUN_RECONCILE_LI)).toMatchObject({ fase: 'fim', idxConta: 1, seq: 6 });
    expect(db.ler('sincEstoqueLojaIntegrada/C1')?.ultimoReconcile).toMatchObject({
      execucaoId: RUN_A,
    });
    expect(db.ler('sincEstoqueLojaIntegrada/C2')?.ultimoReconcile).toBeNull();

    seedContaComDeposito(db, 'C1', refDeposito('dep-9'), { nome: 'Loja Um' });
    relogio.agora += 2_000;
    expect(
      await despacharReconcileEstoqueLi(
        asDb(db),
        {
          tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
          execucaoId: 'estoque-reconcile-deposito-1',
          seq: 0,
        },
        d(),
      ),
    ).toEqual({ kind: 'ocupado' });

    expect(await despacharReconcileEstoqueLi(asDb(db), tarefa(6), d())).toEqual({
      kind: 'encerrado',
    });
    expect(base.fila.enfileirados).toEqual([
      { execucaoId: RUN_A, seq: 6, atrasoS: 2 },
      { execucaoId: idExecucaoRedepositoLi(versaoDaConta(db, 'C1')), seq: 0, atrasoS: 0 },
    ]);
  });

  it('⚠️ a release that LANDED behind a DEADLINE_EXCEEDED: the retry asks again (revisao) — on the queue’s last attempt too', async () => {
    for (const ultima of [false, true]) {
      const db = emFim({});
      seedContaComDeposito(db, 'C1', refDeposito('dep-9'), { nome: 'Loja Um' });
      const { d, fila } = deps();
      db.respostaPerdidaNaProximaEscrita(CAMINHO_RUN_RECONCILE_LI, grpc(4, 'DEADLINE_EXCEEDED'));
      const esperado = [
        { execucaoId: idExecucaoRedepositoLi(versaoDaConta(db, 'C1')), seq: 0, atrasoS: 0 },
      ];
      if (ultima) {
        expect(
          await despacharReconcileEstoqueLi(asDb(db), tarefa(5), {
            ...d,
            tentativa: TASK_MAX_ATTEMPTS - 1,
          }),
        ).toEqual({ kind: 'revisao' });
        expect(fila.enfileirados).toEqual(esperado);
        continue;
      }
      await expect(despacharReconcileEstoqueLi(asDb(db), tarefa(5), d)).rejects.toMatchObject({
        code: 4,
      });
      expect(db.ler(CAMINHO_RUN_RECONCILE_LI)).toMatchObject({ emExecucaoAteMs: 0, seq: 6 });
      expect(fila.enfileirados).toEqual([]);
      expect(
        await despacharReconcileEstoqueLi(asDb(db), tarefa(5), { ...d, tentativa: 1 }),
      ).toEqual({ kind: 'revisao' });
      expect(fila.enfileirados).toEqual(esperado);
    }
  });
});
