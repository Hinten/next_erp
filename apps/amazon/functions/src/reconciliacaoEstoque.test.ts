import { format, inspect } from 'node:util';

import { FieldValue } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AmazonHttpError,
  type ContextoRequisicaoAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  ESTADO_VEZ_FEED_AMAZON,
  FLUXO_FEED_AMAZON,
  ID_LOTE_FEED_AMAZON_REGEX,
  INTEGRACAO_TIPO,
  STATUS_REGISTRO_FEED_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  idRegistroFeedAmazon,
  idVezFeedAmazon,
} from '@delfrance/schemas';

import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import {
  type DepsReconciliacaoDiariaEstoqueAmazon,
  type ResultadoReconciliacaoDiaria,
  executarReconciliacaoDiariaEstoqueAmazon,
  resumirReconciliacaoDiariaEstoqueAmazon,
} from '../../lib/amazon/estoque/reconciliacaoEstoque';
import {
  AmazonLotesTarefasDesligadasError,
  type FilaLotesAmazon,
  criarAgendadorLotesAmazon,
} from '../../lib/amazon/feeds/agendadorLotes';
import {
  type TarefaLoteAmazon,
  nomeConsultaFeed,
  nomePaginaReconciliacao,
  nomeRetomadaReconciliacao,
} from '../../lib/amazon/feeds/tarefaLote';
import { FalhaTarefaAmazonError } from '../../lib/amazon/notificacoes/notificacao';
import { FakeDb, asDb, grpc, increment } from '../../lib/amazon/testing/fakeDb';
import { falhaDeTarefaJaExistente } from '../../lib/amazon/testing/falhaDeEnfileiramento';
import { caminhoConta, espiarStdout, loggerEspiao } from '../../lib/amazon/testing/fixtures';

/**
 * The DAILY stock reconcile (`reconcileAmazonStock`, step 12 PR 12-f): its
 * composition root — what it binds, its ONE summary line (none on a gated
 * run), the sanitizing boundary — and the body it runs
 * (`executarReconciliacaoDiariaEstoqueAmazon`): the two gates with ZERO
 * Firestore operations, the feed backstop and Start per active conta, and the
 * per-conta containment. The declared options are pinned with every other
 * trigger's in `index.test.ts`; Start, the pages, the decide and the close in
 * `lib/amazon/estoque/reconciliacaoEstoque.test.ts`; the backstop's own rule
 * in `lib/amazon/feeds/resultadoFeed.test.ts`.
 *
 * Everything runs REAL against the fake Firestore; the jobs producer is the
 * REAL one over a RECORDING queue (it refuses a held name, as Cloud Tasks
 * does). No network is reachable: the global `fetch` refuses and records (the
 * daily run makes no Amazon call).
 *
 * PLACEHOLDERS ONLY (public repository).
 */
const h = vi.hoisted(() => ({
  db: null as unknown,
  agendador: null as unknown,
  criarAgendador: vi.fn(),
}));
vi.mock('./lib/admin', () => ({
  getDb: () => h.db,
  getAdminApp: () => {
    throw new Error('teste: nenhum app Admin real');
  },
}));
vi.mock('./agendadorEstoque', () => ({
  criarAgendadorLotesAmazonDoAmbiente: () => {
    h.criarAgendador();
    return h.agendador;
  },
}));
vi.mock('../../lib/amazon/estoque/reconciliacaoEstoque', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../lib/amazon/estoque/reconciliacaoEstoque')>();
  return {
    ...real,
    executarReconciliacaoDiariaEstoqueAmazon: vi.fn(real.executarReconciliacaoDiariaEstoqueAmazon),
  };
});

const { depsDaReconciliacaoDiariaEstoqueAmazon, reconcileAmazonStock } =
  await import('./reconciliacaoEstoque');
const corpo = await import('../../lib/amazon/estoque/reconciliacaoEstoque');

function rodar(): Promise<void> {
  return (reconcileAmazonStock as unknown as { run(evento: unknown): Promise<void> }).run({});
}

const CONTA = 'conta-amz-rec-diaria';
const OUTRA = 'conta-amz-rec-diaria-b';
const DEPOSITO = 'documents/depositos/dep-rec-diaria-1';
const FEED = '50001234567';
const MIN = 60_000;
const HORA = 60 * MIN;
/** 03:44 in São Paulo (06:44 UTC): the scheduler's own instant. */
const MADRUGADA = Date.UTC(2027, 0, 15, 6, 44);
const RUN = (id = CONTA) => `reconciliacaoEstoqueAmazon/${id}`;
const VEZ = (id = CONTA) => `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, id)}`;
const REG = (id = CONTA) => `feedsAmazon/${idRegistroFeedAmazon(id, FEED)}`;

let fake: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
let idsDeLote: Set<string>;
let lotes: { tarefa: TarefaLoteAmazon; id: string | null; atrasoS: number }[];
const chamadasDeRede: string[] = [];

/** The REAL jobs producer over a recording queue. */
function agendadorGravador(opcoes: { readonly desligado?: boolean } = {}) {
  return criarAgendadorLotesAmazon({
    desligado: opcoes.desligado ?? false,
    fila: (): FilaLotesAmazon => ({
      enqueue: (tarefa, extras) => {
        const id = extras?.id;
        if (id !== undefined && idsDeLote.has(id)) {
          return Promise.reject(falhaDeTarefaJaExistente(id));
        }
        if (id !== undefined) idsDeLote.add(id);
        lotes.push({ tarefa, id: id ?? null, atrasoS: extras?.scheduleDelaySeconds ?? 0 });
        return Promise.resolve();
      },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stdout = espiarStdout();
  fake = new FakeDb();
  h.db = asDb(fake);
  idsDeLote = new Set();
  lotes = [];
  h.agendador = agendadorGravador();
  vi.stubEnv('AMAZON_CHAMADAS', undefined);
  vi.stubEnv('AMAZON_MODO_ESTOQUE', undefined);
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  stdout.restaurar();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/** Every JSON line the app's logger wrote to stdout, parsed. */
function linhas(): Record<string, unknown>[] {
  return stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The root's own summary line(s). */
function resumos(): Record<string, unknown>[] {
  return linhas().filter((l) => l.message === '[amazon/estoque] reconciliação diária de estoque');
}

/** An Amazon conta with its depósito (or none). */
function conta(id = CONTA, over: Record<string, unknown> = {}): void {
  fake.seed(caminhoConta(id), {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: `Conta ${id}`,
    ativo: true,
    padrao: false,
    selling_partner_id: null,
    depositoOuterRef: DEPOSITO,
    ...over,
  });
}

/** The stock feed lease naming a submitted feed, sent `idadeMs` before {@link MADRUGADA}. */
function vezEnviada(id = CONTA, idadeMs = 8 * HORA): void {
  const antes = MADRUGADA - idadeMs;
  fake.seed(VEZ(id), {
    estado: ESTADO_VEZ_FEED_AMAZON.enviado,
    execucaoId: 'exec-feed-1',
    feedId: FEED,
    snapshotEmMs: antes - MIN,
    antesDoEnvioMs: antes,
    mensagens: 31,
    bytes: 3_100,
    ateMs: antes + 49 * HORA,
    atualizadoEmMs: antes,
    origem: 'delta',
    tipoLote: TIPO_LOTE_FEED_AMAZON.blocos,
  });
}

/** The body's deps, the clock and the producer the case gives. */
function deps(
  over: Partial<DepsReconciliacaoDiariaEstoqueAmazon> = {},
): DepsReconciliacaoDiariaEstoqueAmazon & { linhas: ReturnType<typeof loggerEspiao>['linhas'] } {
  const espiao = loggerEspiao();
  let n = 0;
  return {
    db: asDb(fake),
    ambiente: { AMAZON_CHAMADAS: 'on', AMAZON_MODO_ESTOQUE: 'dry-run' },
    agora: () => MADRUGADA,
    logger: espiao.logger,
    increment,
    agendador: () => h.agendador as ReturnType<typeof agendadorGravador>,
    gerarExecucaoId: () => {
      n += 1;
      return `run-diaria-${String(n)}`;
    },
    linhas: espiao.linhas,
    ...over,
  };
}

const doTipo = (tipo: TarefaLoteAmazon['tipo']) => lotes.filter((l) => l.tarefa.tipo === tipo);

describe('reconcileAmazonStock — the gates the body applies to what the root binds', () => {
  it('★ with the read switch unset the run does ZERO Firestore operations, and writes ONE line: the body’s, never a summary', async () => {
    conta();

    await rodar();

    expect(fake.operacoes).toBe(0);
    expect(h.criarAgendador).not.toHaveBeenCalled();
    expect(linhas()).toEqual([
      expect.objectContaining({
        evento: 'estoque',
        fase: 'reconciliacao',
        etapa: 'agenda',
        portao: 'chamadas-desligadas',
        severity: 'INFO',
      }),
    ]);
    expect(resumos()).toEqual([]);
  });

  it('with the switch on and the stock valve unset (off), the same: zero operations, the body’s one line', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    conta();

    await rodar();

    expect(fake.operacoes).toBe(0);
    expect(linhas()).toEqual([
      expect.objectContaining({ portao: 'valvula-desligada', valvula: 'off', severity: 'INFO' }),
    ]);
  });

  it('switch on, valve dry-run: per active conta the backstop and Start — a run claimed, its page 0 named — and the root writes ONE flat summary', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    vi.stubEnv('AMAZON_MODO_ESTOQUE', 'dry-run');
    conta();

    await rodar();

    const run = fake.ler(RUN()) as { execucaoId: string };
    expect(run).toMatchObject({ fase: 'varrendo', depositoOuterRef: DEPOSITO, proximaPagina: 0 });
    expect(run.execucaoId).toMatch(ID_LOTE_FEED_AMAZON_REGEX);
    expect(lotes).toEqual([
      {
        tarefa: {
          v: 1,
          tipo: 'reconciliacao',
          contaId: CONTA,
          execucaoId: run.execucaoId,
          pagina: 0,
        },
        id: nomePaginaReconciliacao(CONTA, run.execucaoId, 0),
        atrasoS: 0,
      },
    ]);
    expect(linhas().filter((l) => l.etapa === 'agenda' && l.conta === CONTA)).toEqual([
      expect.objectContaining({
        desfecho: 'feito',
        adocao: 'sem-feed',
        registro: null,
        inicio: 'iniciada',
        severity: 'INFO',
      }),
    ]);
    expect(resumos()).toEqual([
      {
        fase: 'reconciliacao',
        etapa: 'agenda',
        portao: null,
        contas: 1,
        desfecho_feito: 1,
        iniciadas: 1,
        adotadas: 0,
        evento: 'estoque',
        fluxo: 'estoque',
        severity: 'INFO',
        message: '[amazon/estoque] reconciliação diária de estoque',
      },
    ]);
  });

  it('a run whose body answered a gate writes no summary even when handed back by a spy', async () => {
    const fechado: ResultadoReconciliacaoDiaria = { portao: 'valvula-desligada', contas: [] };
    vi.mocked(corpo.executarReconciliacaoDiariaEstoqueAmazon).mockResolvedValueOnce(fechado);

    await rodar();

    expect(resumos()).toEqual([]);
  });
});

describe('reconcileAmazonStock — the sanitizing boundary', () => {
  const SENTINELAS = {
    ref: 'ref-SENTINELA-0f0f0f',
    caminho: 'SENTINELA-CAMINHO-7777',
  } as const;
  const CTX_SUJO: ContextoRequisicaoAmazon = {
    destino: 'sp-api',
    operacao: 'getFeed',
    metodo: 'GET',
    caminho: `/feeds/2021-06-30/feeds/${SENTINELAS.caminho}`,
    correlationId: 'corr-1',
    requestIdAmazon: null,
    refCredencial: SENTINELAS.ref,
  };
  const vazamentos = (texto: string) => Object.values(SENTINELAS).filter((s) => texto.includes(s));

  it('★ a package error escaping the run leaves as a FalhaTarefaAmazonError with no ref or path — and no summary line', async () => {
    const original = new AmazonHttpError({ ...CTX_SUJO, status: 400 });
    expect(vazamentos(inspect(original, { showHidden: true, depth: 5 })).length).toBeGreaterThan(0);
    vi.mocked(corpo.executarReconciliacaoDiariaEstoqueAmazon).mockRejectedValueOnce(original);

    const err = await rodar().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FalhaTarefaAmazonError);
    const e = err as FalhaTarefaAmazonError;
    for (const texto of [format(e), inspect(e, { showHidden: true, depth: 5 }), e.message]) {
      expect(vazamentos(texto), texto).toEqual([]);
    }
    expect(resumos()).toEqual([]);
  });

  it('near-miss: anything else (a bug) is rethrown as the SAME object (rule 6)', async () => {
    const bug = new RangeError('bug');
    vi.mocked(corpo.executarReconciliacaoDiariaEstoqueAmazon).mockRejectedValueOnce(bug);
    await expect(rodar()).rejects.toBe(bug);
  });
});

describe('depsDaReconciliacaoDiariaEstoqueAmazon — what the root binds', () => {
  it('the codebase’s db, the environment whole and live, a tier-0 increment, the app logger, the real clock', () => {
    const d = depsDaReconciliacaoDiariaEstoqueAmazon();
    expect(d.db).toBe(h.db);
    expect(d.ambiente).toBe(process.env);
    const incremento = d.increment(2);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(2))).toBe(true);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(1))).toBe(false);
    expect(d.logger).toBe(LOGGER_STDOUT_AMAZON);
    const antes = Date.now();
    const agora = d.agora();
    expect(agora).toBeGreaterThanOrEqual(antes);
    expect(agora).toBeLessThanOrEqual(Date.now());
  });

  it('the JOBS producer is the stock root’s, as a THUNK: binding builds none, each call builds one', () => {
    const d = depsDaReconciliacaoDiariaEstoqueAmazon();
    expect(h.criarAgendador).not.toHaveBeenCalled();
    expect(d.agendador()).toBe(h.agendador);
    expect(h.criarAgendador).toHaveBeenCalledTimes(1);
  });

  it('a fresh run id per call, in the stock documents’ id grammar', () => {
    const d = depsDaReconciliacaoDiariaEstoqueAmazon();
    const a = d.gerarExecucaoId();
    expect(a).not.toBe(d.gerarExecucaoId());
    expect(a).toMatch(ID_LOTE_FEED_AMAZON_REGEX);
  });
});

describe('the daily run, per conta: the feed backstop, then Start', () => {
  it('★ the feed backstop: an enviado lease whose record is 7 h stale ⇒ ONE adoption rung named by the São Paulo date, BEFORE Start', async () => {
    conta();
    vezEnviada();
    fake.seed(REG(), {
      contaId: CONTA,
      feedId: FEED,
      fluxo: 'estoque',
      execucaoId: 'exec-feed-1',
      origem: 'delta',
      tipoLote: TIPO_LOTE_FEED_AMAZON.blocos,
      janela: null,
      snapshotEmMs: MADRUGADA - 8 * HORA - MIN,
      antesDoEnvioMs: MADRUGADA - 8 * HORA,
      mensagens: 31,
      bytes: 3_100,
      status: STATUS_REGISTRO_FEED_AMAZON.processando,
      criadoEmMs: MADRUGADA - 8 * HORA,
      atualizadoEmMs: MADRUGADA - 7 * HORA,
      prazoEmMs: MADRUGADA + 4 * HORA,
      rodadas: 3,
      expiraEm: new Date(MADRUGADA + 180 * 86_400_000),
    });
    const d = deps();
    const r = await executarReconciliacaoDiariaEstoqueAmazon(d);
    expect(r.contas).toEqual([
      expect.objectContaining({
        contaId: CONTA,
        desfecho: 'feito',
        adocao: 'adotada',
        inicio: 'iniciada',
      }),
    ]);
    expect(lotes.map((l) => [l.tarefa.tipo, l.id])).toEqual([
      ['feed-resultado', nomeConsultaFeed(CONTA, FEED, 'adocao:2027-01-15')],
      ['reconciliacao', expect.any(String)],
    ]);
    expect(resumirReconciliacaoDiariaEstoqueAmazon(r)).toMatchObject({ adotadas: 1, iniciadas: 1 });
  });

  it('★ a missing record of an enviado lease is created from the lease first, then adopted', async () => {
    conta();
    vezEnviada();
    const r = await executarReconciliacaoDiariaEstoqueAmazon(deps());
    expect(r.contas[0]).toMatchObject({ adocao: 'adotada', registro: 'criado' });
    expect(fake.ler(REG())).toMatchObject({
      status: STATUS_REGISTRO_FEED_AMAZON.enviado,
      feedId: FEED,
    });
    expect(doTipo('feed-resultado')).toHaveLength(1);
  });

  it('a live run 16 min without progress is RE-KICKED by Start (no second run)', async () => {
    conta();
    fake.seed(RUN(), {
      execucaoId: 'run-velho',
      fase: 'varrendo',
      depositoOuterRef: DEPOSITO,
      proximaPagina: 3,
      paginas: 3,
      progressoEmMs: MADRUGADA - 16 * MIN,
      iniciadaEmMs: MADRUGADA - HORA,
    });
    const r = await executarReconciliacaoDiariaEstoqueAmazon(deps());
    expect(r.contas[0]).toMatchObject({ desfecho: 'feito', inicio: 'retomada' });
    expect(lotes.map((l) => l.id)).toEqual([
      nomeRetomadaReconciliacao(CONTA, 'run-velho', 3, MADRUGADA - 16 * MIN),
    ]);
    expect(fake.ler(RUN())).toMatchObject({ execucaoId: 'run-velho' });
  });

  it('“send all”: the job forced again after a run CONCLUDED claims a FRESH run (the walk re-reads every SKU)', async () => {
    conta();
    fake.seed(RUN(), {
      execucaoId: 'run-de-ontem',
      fase: 'concluida',
      depositoOuterRef: DEPOSITO,
      proximaPagina: 5,
      paginas: 5,
      progressoEmMs: MADRUGADA - 10 * MIN,
      iniciadaEmMs: MADRUGADA - HORA,
      concluidaEmMs: MADRUGADA - 10 * MIN,
    });
    const r = await executarReconciliacaoDiariaEstoqueAmazon(deps());
    expect(r.contas[0]).toMatchObject({ inicio: 'iniciada' });
    expect(fake.ler(RUN())).toMatchObject({
      execucaoId: 'run-diaria-1',
      fase: 'varrendo',
      paginas: 0,
    });
  });

  it('an inactive conta is skipped with no line and nothing read; an id outside the grammar is id-de-conta-invalido at WARNING, nothing read for it', async () => {
    conta();
    conta('conta.x');
    conta(OUTRA, { ativo: false });
    const d = deps();
    const r = await executarReconciliacaoDiariaEstoqueAmazon(d);
    expect(Object.fromEntries(r.contas.map((c) => [c.contaId, c.desfecho]))).toEqual({
      [CONTA]: 'feito',
      'conta.x': 'id-de-conta-invalido',
    });
    expect(fake.leituras.filter((c) => c.includes('conta.x') || c.includes(OUTRA))).toEqual([]);
    expect(d.linhas.filter((l) => l.meta?.etapa === 'agenda').map((l) => l.nivel)).toEqual([
      'info',
      'warn',
    ]);
  });

  it.each([
    // The BACKSTOP's own failures: contained on their own, so Start still runs
    // (NEAR-MISS: one try for both would cost the conta its reconcile that day).
    [
      'a Firestore status error in the feed backstop',
      () => fake.falharLeitura(VEZ(), grpc(14, 'UNAVAILABLE')),
      {
        desfecho: 'feito',
        adocao: 'falhou',
        codigoGrpcAdocao: 14,
        inicio: 'iniciada',
        erro: null,
      },
    ],
    [
      'a stock lease that no longer parses (the feed backstop)',
      () => fake.seed(VEZ(), { estado: 'enviado' }),
      {
        desfecho: 'feito',
        adocao: 'falhou',
        erroAdocao: 'AmazonVezFeedInvalidaError',
        codigoGrpcAdocao: null,
        inicio: 'iniciada',
        erro: null,
      },
    ],
    [
      'a reconcile run that no longer parses',
      () =>
        fake.seed(RUN(), {
          execucaoId: 'x',
          fase: 'outra',
          depositoOuterRef: DEPOSITO,
          iniciadaEmMs: 1,
        }),
      { desfecho: 'documento-invalido', erro: 'ReconciliacaoEstoqueDocumentoInvalidoError' },
    ],
  ])(
    '%s on one conta ⇒ contained, named at WARNING; the other conta still runs',
    async (_c, falhar, esperado) => {
      conta();
      conta(OUTRA);
      falhar();
      const d = deps();
      const r = await executarReconciliacaoDiariaEstoqueAmazon(d);
      const porConta = Object.fromEntries(r.contas.map((c) => [c.contaId, c]));
      expect(porConta[CONTA]).toMatchObject(esperado);
      expect(porConta[OUTRA]).toMatchObject({ desfecho: 'feito', inicio: 'iniciada' });
      expect(
        d.linhas.find((l) => l.meta?.etapa === 'agenda' && l.meta.conta === CONTA)?.nivel,
      ).toBe('warn');
    },
  );

  it('the jobs queue’s valve closed ⇒ enfileiramento-falhou naming the class (the claimed run is the next Start’s or the tick’s to re-kick)', async () => {
    conta();
    h.agendador = agendadorGravador({ desligado: true });
    const r = await executarReconciliacaoDiariaEstoqueAmazon(deps());
    expect(r.contas[0]).toMatchObject({
      desfecho: 'enfileiramento-falhou',
      erro: new AmazonLotesTarefasDesligadasError().name,
      adocao: 'sem-feed',
      inicio: null,
    });
  });

  it('NEAR-MISS: anything else (a bug) is not contained — the run rejects', async () => {
    conta();
    fake.falharLeitura(VEZ(), new TypeError('bug'));
    await expect(executarReconciliacaoDiariaEstoqueAmazon(deps())).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});
