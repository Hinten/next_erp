import { format, inspect } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AmazonHttpError,
  type ContextoRequisicaoAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  ESTADO_VEZ_FEED_AMAZON,
  FASE_EXECUCAO_PRECO_AMAZON,
  FLUXO_FEED_AMAZON,
  INTEGRACAO_TIPO,
  STATUS_REGISTRO_FEED_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  idRegistroFeedAmazon,
  idVezFeedAmazon,
} from '@delfrance/schemas';

import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import {
  type FilaLotesAmazon,
  criarAgendadorLotesAmazon,
} from '../../lib/amazon/feeds/agendadorLotes';
import { dataSaoPauloAmazon } from '../../lib/amazon/feeds/resultadoFeed';
import { type TarefaLoteAmazon, nomeConsultaFeed } from '../../lib/amazon/feeds/tarefaLote';
import { FalhaTarefaAmazonError } from '../../lib/amazon/notificacoes/notificacao';
import { FakeDb, asDb } from '../../lib/amazon/testing/fakeDb';
import { falhaDeTarefaJaExistente } from '../../lib/amazon/testing/falhaDeEnfileiramento';
import { caminhoConta, espiarStdout } from '../../lib/amazon/testing/fixtures';

/**
 * The DAILY root (`reconcileAmazonStock`) and its PRICE step (step 13, PR
 * 13-f): the root runs the stock step, then the price step, WHATEVER the
 * other's outcome, and rethrows the first failure only after both finished.
 * The stock step's own cases stay in `reconciliacaoEstoque.test.ts`, which
 * this PR leaves untouched; the price step's own branches in
 * `lib/amazon/preco/backstopPreco.test.ts`; the declared options in
 * `index.test.ts`.
 *
 * Everything runs REAL against the fake Firestore (both bodies wrapped in
 * spies that call the real ones unless a case says otherwise); the jobs
 * producer is the REAL one over a RECORDING queue. No network: the global
 * `fetch` refuses and records.
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
vi.mock('../../lib/amazon/preco/backstopPreco', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/amazon/preco/backstopPreco')>();
  return {
    ...real,
    executarBackstopDiarioPrecoAmazon: vi.fn(real.executarBackstopDiarioPrecoAmazon),
  };
});

const { depsDoBackstopDiarioPrecoAmazon, reconcileAmazonStock } =
  await import('./reconciliacaoEstoque');
const estoque = await import('../../lib/amazon/estoque/reconciliacaoEstoque');
const preco = await import('../../lib/amazon/preco/backstopPreco');

function rodar(): Promise<void> {
  return (reconcileAmazonStock as unknown as { run(evento: unknown): Promise<void> }).run({});
}

const CONTA = 'conta-amz-diario-raiz';
const DEPOSITO = 'documents/depositos/dep-diario-raiz-1';
const FEED = '50001112223';
const MIN = 60_000;
const HORA = 60 * MIN;
const VEZ_PRECO = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.preco, CONTA)}`;
const REG = `feedsAmazon/${idRegistroFeedAmazon(CONTA, FEED)}`;
const RUN_PRECO = `precosAmazon/${CONTA}`;
const MENSAGEM_ESTOQUE = '[amazon/estoque] reconciliação diária de estoque';
const MENSAGEM_PRECO = '[amazon/preco] passo diário de preço';

let fake: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
let idsDeLote: Set<string>;
let lotes: { tarefa: TarefaLoteAmazon; id: string | null }[];
const chamadasDeRede: string[] = [];

function agendadorGravador() {
  return criarAgendadorLotesAmazon({
    desligado: false,
    fila: (): FilaLotesAmazon => ({
      enqueue: (tarefa, extras) => {
        const id = extras?.id;
        if (id !== undefined && idsDeLote.has(id)) {
          return Promise.reject(falhaDeTarefaJaExistente(id));
        }
        if (id !== undefined) idsDeLote.add(id);
        lotes.push({ tarefa, id: id ?? null });
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
  vi.stubEnv('AMAZON_MODO_PRECO', undefined);
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

function linhas(): Record<string, unknown>[] {
  return stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
}

const precoLinhas = () => linhas().filter((l) => l.evento === 'preco');

function conta(): void {
  fake.seed(caminhoConta(CONTA), {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: `Conta ${CONTA}`,
    ativo: true,
    padrao: false,
    selling_partner_id: null,
    depositoOuterRef: DEPOSITO,
  });
}

/** A stuck PRICE feed: its lease `enviado`, its record still for 7 h. */
function feedPrecoParado(agoraMs: number): void {
  const antes = agoraMs - 8 * HORA;
  fake.seed(VEZ_PRECO, {
    estado: ESTADO_VEZ_FEED_AMAZON.enviado,
    execucaoId: 'exec-feed-preco-raiz',
    feedId: FEED,
    snapshotEmMs: antes - MIN,
    antesDoEnvioMs: antes,
    mensagens: 40,
    bytes: 4_000,
    ateMs: antes + 49 * HORA,
    atualizadoEmMs: antes,
    origem: 'execucao-preco',
    tipoLote: TIPO_LOTE_FEED_AMAZON.blocos,
  });
  fake.seed(REG, {
    contaId: CONTA,
    feedId: FEED,
    fluxo: 'preco',
    execucaoId: 'exec-feed-preco-raiz',
    origem: 'execucao-preco',
    tipoLote: TIPO_LOTE_FEED_AMAZON.blocos,
    janela: null,
    snapshotEmMs: antes - MIN,
    antesDoEnvioMs: antes,
    mensagens: 40,
    bytes: 4_000,
    status: STATUS_REGISTRO_FEED_AMAZON.processando,
    criadoEmMs: antes,
    atualizadoEmMs: agoraMs - 7 * HORA,
    prazoEmMs: agoraMs + 4 * HORA,
    rodadas: 3,
    expiraEm: new Date(agoraMs + 180 * 86_400_000),
  });
}

const leituraDoLeasePreco = () => fake.leituras.filter((l) => l === VEZ_PRECO);

describe('the daily root runs BOTH steps', () => {
  it('★ the price valve unset ⇒ ZERO reads and ZERO lines for price: a run with the stock step on writes only the stock lines and its summary', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    vi.stubEnv('AMAZON_MODO_ESTOQUE', 'dry-run');
    conta();
    await rodar();
    expect(precoLinhas()).toEqual([]);
    expect(leituraDoLeasePreco()).toEqual([]);
    expect(fake.consultas.filter((q) => q.colecao === 'integracao')).toHaveLength(1);
    expect(linhas().filter((l) => l.message === MENSAGEM_ESTOQUE)).toHaveLength(1);
    expect(vi.mocked(preco.executarBackstopDiarioPrecoAmazon)).toHaveBeenCalledTimes(1);
  });

  it('★ NEAR-MISS: the stock valve off with the price valve on ⇒ the price step RUNS — its own conta query, its own per-conta line and its summary — beside the stock gate’s one line', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    vi.stubEnv('AMAZON_MODO_PRECO', 'on');
    conta();
    await rodar();
    expect(linhas()).toEqual([
      expect.objectContaining({ evento: 'estoque', portao: 'valvula-desligada' }),
      expect.objectContaining({
        evento: 'preco',
        fase: 'diario',
        conta: CONTA,
        desfecho: 'feito',
        adocao: 'sem-feed',
      }),
      expect.objectContaining({
        evento: 'preco',
        fluxo: 'preco',
        message: MENSAGEM_PRECO,
        fase: 'diario',
        portao: null,
        contas: 1,
        desfecho_feito: 1,
        adotadas: 0,
        severity: 'INFO',
      }),
    ]);
    // The stock gate enumerated nothing: the ONE conta query is the price step's.
    expect(fake.consultas.filter((q) => q.colecao === 'integracao')).toHaveLength(1);
    expect(leituraDoLeasePreco()).toHaveLength(1);
  });

  it('★ a stuck price lease ⇒ adopted by the daily root (ONE named rung on the jobs queue), the producer built only then', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    vi.stubEnv('AMAZON_MODO_PRECO', 'dry-run');
    conta();
    const agora = Date.now();
    feedPrecoParado(agora);
    await rodar();
    const rung = lotes.filter((l) => l.tarefa.tipo === 'feed-resultado');
    expect(rung).toHaveLength(1);
    expect([
      nomeConsultaFeed(CONTA, FEED, `adocao:${dataSaoPauloAmazon(agora)}`),
      nomeConsultaFeed(CONTA, FEED, `adocao:${dataSaoPauloAmazon(Date.now())}`),
    ]).toContain(rung[0]?.id);
    expect(h.criarAgendador).toHaveBeenCalledTimes(1);
    expect(linhas().find((l) => l.message === MENSAGEM_PRECO)).toMatchObject({ adotadas: 1 });
  });

  it('★ under the click-only re-kick rule: a price run stalled 16 min ⇒ NOTHING — no read of the run, no page, no write', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    vi.stubEnv('AMAZON_MODO_PRECO', 'on');
    conta();
    fake.seed(RUN_PRECO, {
      execucaoId: 'exec-preco-parada-raiz',
      fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
      baixarPreco: false,
      solicitadaPor: 'operador-teste',
      proximaPagina: 2,
      iniciadaEmMs: Date.now() - 2 * HORA,
      progressoEmMs: Date.now() - 16 * MIN,
    });
    await rodar();
    expect(fake.leituras.filter((l) => l.startsWith('precosAmazon/'))).toEqual([]);
    expect(fake.escritas.filter((e) => e.caminho.startsWith('precosAmazon/'))).toEqual([]);
    expect(lotes).toEqual([]);
    expect(h.criarAgendador).not.toHaveBeenCalled();
  });

  it('★ the stock step THROWING ⇒ the price step still runs, and the root rethrows the STOCK failure after it, sanitized (NEAR-MISS: both clean ⇒ no throw)', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    vi.stubEnv('AMAZON_MODO_PRECO', 'on');
    conta();
    const ctx: ContextoRequisicaoAmazon = {
      destino: 'sp-api',
      operacao: 'getFeed',
      metodo: 'GET',
      caminho: '/feeds/2021-06-30/feeds/SENTINELA-CAMINHO-1234',
      correlationId: 'corr-1',
      requestIdAmazon: null,
      refCredencial: 'ref-SENTINELA-abcabc',
    };
    vi.mocked(estoque.executarReconciliacaoDiariaEstoqueAmazon).mockRejectedValueOnce(
      new AmazonHttpError({ ...ctx, status: 400 }),
    );
    const err = await rodar().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FalhaTarefaAmazonError);
    for (const texto of [format(err), inspect(err, { showHidden: true, depth: 5 })]) {
      expect(texto).not.toContain('SENTINELA');
    }
    // The price step ran AFTER the stock failure: its lease read, its summary.
    expect(vi.mocked(preco.executarBackstopDiarioPrecoAmazon)).toHaveBeenCalledTimes(1);
    expect(leituraDoLeasePreco()).toHaveLength(1);
    expect(linhas().filter((l) => l.message === MENSAGEM_PRECO)).toHaveLength(1);
    expect(linhas().filter((l) => l.message === MENSAGEM_ESTOQUE)).toEqual([]);

    // NEAR-MISS: both clean ⇒ the run resolves.
    await expect(rodar()).resolves.toBeUndefined();
  });

  it('★ a gated stock run (the read switch on, the stock valve off) no longer ends the root: the price step runs', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    vi.stubEnv('AMAZON_MODO_PRECO', 'dry-run');
    conta();
    await rodar();
    expect(vi.mocked(estoque.executarReconciliacaoDiariaEstoqueAmazon)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(preco.executarBackstopDiarioPrecoAmazon)).toHaveBeenCalledTimes(1);
    expect(precoLinhas().length).toBeGreaterThan(0);
  });

  it('the price step throwing ⇒ the stock summary is already written, then the root rethrows the PRICE failure (a bug as the same object)', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    vi.stubEnv('AMAZON_MODO_ESTOQUE', 'dry-run');
    vi.stubEnv('AMAZON_MODO_PRECO', 'on');
    conta();
    const bug = new RangeError('bug');
    vi.mocked(preco.executarBackstopDiarioPrecoAmazon).mockRejectedValueOnce(bug);
    await expect(rodar()).rejects.toBe(bug);
    expect(linhas().filter((l) => l.message === MENSAGEM_ESTOQUE)).toHaveLength(1);
    expect(linhas().filter((l) => l.message === MENSAGEM_PRECO)).toEqual([]);
  });

  it('both steps throwing ⇒ the FIRST failure (the stock step’s) is rethrown, after the price step ran', async () => {
    const primeira = new RangeError('primeira');
    const segunda = new RangeError('segunda');
    vi.mocked(estoque.executarReconciliacaoDiariaEstoqueAmazon).mockRejectedValueOnce(primeira);
    vi.mocked(preco.executarBackstopDiarioPrecoAmazon).mockRejectedValueOnce(segunda);
    await expect(rodar()).rejects.toBe(primeira);
    expect(vi.mocked(preco.executarBackstopDiarioPrecoAmazon)).toHaveBeenCalledTimes(1);
  });

  it('a price step whose BINDING throws synchronously is settled like any failure: the stock summary stands, its error rethrown', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    vi.stubEnv('AMAZON_MODO_ESTOQUE', 'dry-run');
    conta();
    const bug = new TypeError('vínculo');
    vi.mocked(preco.executarBackstopDiarioPrecoAmazon).mockImplementationOnce(() => {
      throw bug;
    });
    await expect(rodar()).rejects.toBe(bug);
    expect(linhas().filter((l) => l.message === MENSAGEM_ESTOQUE)).toHaveLength(1);
  });

  it('★ the STOCK step throwing synchronously (its binding, before any promise) still lets the price step run, then is rethrown', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    vi.stubEnv('AMAZON_MODO_PRECO', 'on');
    conta();
    const bug = new TypeError('vínculo do estoque');
    vi.mocked(estoque.executarReconciliacaoDiariaEstoqueAmazon).mockImplementationOnce(() => {
      throw bug;
    });
    await expect(rodar()).rejects.toBe(bug);
    expect(vi.mocked(preco.executarBackstopDiarioPrecoAmazon)).toHaveBeenCalledTimes(1);
    expect(linhas().filter((l) => l.message === MENSAGEM_PRECO)).toHaveLength(1);
  });

  it('★ both steps throwing ⇒ the OTHER failure leaves ONE ERROR line of its own — its class, never its message — before the first is rethrown (NEAR-MISS: one failing step writes no such line)', async () => {
    const falhaDoPasso = (fluxo: string) =>
      linhas().filter(
        (l) => l.evento === fluxo && l.severity === 'ERROR' && l.message !== MENSAGEM_PRECO,
      );
    const primeira = new RangeError('SENTINELA-primeira');
    const segunda = new TypeError('SENTINELA-segunda');
    vi.mocked(estoque.executarReconciliacaoDiariaEstoqueAmazon).mockRejectedValueOnce(primeira);
    vi.mocked(preco.executarBackstopDiarioPrecoAmazon).mockRejectedValueOnce(segunda);
    await expect(rodar()).rejects.toBe(primeira);
    const [linha, ...demais] = falhaDoPasso('preco');
    expect(demais).toEqual([]);
    expect(linha).toMatchObject({ fluxo: 'preco', fase: 'diario', erro: 'TypeError' });
    expect(falhaDoPasso('estoque')).toEqual([]);
    expect(JSON.stringify(linhas())).not.toContain('SENTINELA');

    // NEAR-MISS: the stock step alone failing ⇒ no line of the price step's failure.
    stdout.restaurar();
    stdout = espiarStdout();
    vi.mocked(estoque.executarReconciliacaoDiariaEstoqueAmazon).mockRejectedValueOnce(primeira);
    await expect(rodar()).rejects.toBe(primeira);
    expect(falhaDoPasso('preco')).toEqual([]);
    expect(falhaDoPasso('estoque')).toEqual([]);
  });

  it('the price step runs AFTER the stock step (its first read follows the stock step’s)', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    vi.stubEnv('AMAZON_MODO_ESTOQUE', 'dry-run');
    vi.stubEnv('AMAZON_MODO_PRECO', 'on');
    conta();
    await rodar();
    const ordem = vi.mocked(estoque.executarReconciliacaoDiariaEstoqueAmazon).mock
      .invocationCallOrder[0];
    const depois = vi.mocked(preco.executarBackstopDiarioPrecoAmazon).mock.invocationCallOrder[0];
    expect(ordem).toBeLessThan(depois ?? 0);
    const estoqueEm = linhas().findIndex((l) => l.message === MENSAGEM_ESTOQUE);
    const precoEm = linhas().findIndex((l) => l.message === MENSAGEM_PRECO);
    expect(estoqueEm).toBeGreaterThan(-1);
    expect(precoEm).toBeGreaterThan(estoqueEm);
  });
});

describe('depsDoBackstopDiarioPrecoAmazon — what the root binds for price', () => {
  it('the codebase’s db, the environment whole and live, the app logger, the real clock; the JOBS producer a THUNK (binding builds none)', () => {
    const d = depsDoBackstopDiarioPrecoAmazon();
    expect(d.db).toBe(h.db);
    expect(d.ambiente).toBe(process.env);
    expect(d.logger).toBe(LOGGER_STDOUT_AMAZON);
    const antes = Date.now();
    expect(d.agora()).toBeGreaterThanOrEqual(antes);
    expect(h.criarAgendador).not.toHaveBeenCalled();
    expect(d.agendador()).toBe(h.agendador);
    expect(h.criarAgendador).toHaveBeenCalledTimes(1);
  });
});
