/**
 * The DAILY price step (`executarBackstopDiarioPrecoAmazon`, step 13, PR 13-f)
 * against the counting fake Firestore: the two SILENT gates, the step's own
 * conta enumeration, the REAL feed backstop (`adotarFeedParadoAmazon`) bound
 * to the price fluxo over the REAL jobs producer on a recording queue, the
 * per-conta containment, and what it never does — read, re-kick or start a
 * price run. No network: the global `fetch` refuses and records.
 *
 * PLACEHOLDERS ONLY (public repository).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import {
  AmazonLotesTarefasDesligadasError,
  type FilaLotesAmazon,
  criarAgendadorLotesAmazon,
} from '../feeds/agendadorLotes';
import { ADOCAO_FEED_PARADO_MS, dataSaoPauloAmazon } from '../feeds/resultadoFeed';
import { type TarefaLoteAmazon, nomeConsultaFeed } from '../feeds/tarefaLote';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import { AGORA_MS, caminhoConta, loggerEspiao } from '../testing/fixtures';
import {
  DESFECHO_BACKSTOP_DIARIO_PRECO,
  type DepsBackstopDiarioPrecoAmazon,
  PORTAO_BACKSTOP_DIARIO_PRECO,
  executarBackstopDiarioPrecoAmazon,
  resumirBackstopDiarioPrecoAmazon,
} from './backstopPreco';
import { RETOMADA_EXECUCAO_PRECO_MS, retomadaExecucaoPrecoAmazon } from './inicioExecucaoPreco';

const CONTA = 'conta-amz-diario-preco';
const OUTRA = 'conta-amz-diario-preco-b';
const FEED = '50009876543';
const MIN = 60_000;
const HORA = 60 * MIN;
const VEZ = (id = CONTA, fluxo: 'estoque' | 'preco' = FLUXO_FEED_AMAZON.preco) =>
  `feedsAmazonEmCurso/${idVezFeedAmazon(fluxo, id)}`;
const REG = (id = CONTA) => `feedsAmazon/${idRegistroFeedAmazon(id, FEED)}`;
const RUN = (id = CONTA) => `precosAmazon/${id}`;
const PORTAO = PORTAO_BACKSTOP_DIARIO_PRECO;

const chamadasDeRede: string[] = [];

function mundo() {
  const fake = new FakeDb();
  const log = loggerEspiao();
  const nomes = new Set<string>();
  const m = {
    fake,
    log,
    lotes: [] as { tarefa: TarefaLoteAmazon; nome: string | null; atrasoS: number }[],
    construidos: 0,
    desligado: false,
    ambiente: {
      AMAZON_CHAMADAS: 'on',
      AMAZON_MODO_PRECO: 'dry-run',
    } as Record<string, string | undefined>,
    deps(over: Partial<DepsBackstopDiarioPrecoAmazon> = {}): DepsBackstopDiarioPrecoAmazon {
      return {
        db: asDb(fake),
        ambiente: m.ambiente,
        agora: () => AGORA_MS,
        logger: log.logger,
        agendador: () => {
          m.construidos += 1;
          return criarAgendadorLotesAmazon({
            desligado: m.desligado,
            fila: (): FilaLotesAmazon => ({
              enqueue: (tarefa, opcoes) => {
                const id = opcoes?.id;
                if (id !== undefined && nomes.has(id)) {
                  return Promise.reject(falhaDeTarefaJaExistente(id));
                }
                if (id !== undefined) nomes.add(id);
                m.lotes.push({
                  tarefa,
                  nome: id ?? null,
                  atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
                });
                return Promise.resolve();
              },
            }),
          });
        },
        ...over,
      };
    },
    rodar: (over: Partial<DepsBackstopDiarioPrecoAmazon> = {}) =>
      executarBackstopDiarioPrecoAmazon(m.deps(over)),
    linhas: () => log.linhas.filter((l) => l.meta?.fase === 'diario'),
  };
  return m;
}
type Mundo = ReturnType<typeof mundo>;

/** An active Amazon conta (or not). */
function conta(m: Mundo, id = CONTA, over: Record<string, unknown> = {}): void {
  m.fake.seed(caminhoConta(id), {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: `Conta ${id}`,
    ativo: true,
    padrao: false,
    selling_partner_id: null,
    ...over,
  });
}

/** The `fluxo` feed lease naming a submitted feed, sent `idadeMs` before {@link AGORA_MS}. */
function vezEnviada(
  m: Mundo,
  o: { readonly id?: string; readonly fluxo?: 'estoque' | 'preco'; readonly idadeMs?: number } = {},
): void {
  const antes = AGORA_MS - (o.idadeMs ?? 8 * HORA);
  m.fake.seed(VEZ(o.id, o.fluxo), {
    estado: ESTADO_VEZ_FEED_AMAZON.enviado,
    execucaoId: 'exec-feed-preco-1',
    feedId: FEED,
    snapshotEmMs: antes - MIN,
    antesDoEnvioMs: antes,
    mensagens: 31,
    bytes: 3_100,
    ateMs: antes + 49 * HORA,
    atualizadoEmMs: antes,
    origem: 'execucao-preco',
    tipoLote: TIPO_LOTE_FEED_AMAZON.blocos,
  });
}

/** The feed's record, last moved `paradoHaMs` before {@link AGORA_MS}. */
function registro(m: Mundo, paradoHaMs: number, id = CONTA): void {
  m.fake.seed(REG(id), {
    contaId: id,
    feedId: FEED,
    fluxo: 'preco',
    execucaoId: 'exec-feed-preco-1',
    origem: 'execucao-preco',
    tipoLote: TIPO_LOTE_FEED_AMAZON.blocos,
    janela: null,
    snapshotEmMs: AGORA_MS - 8 * HORA - MIN,
    antesDoEnvioMs: AGORA_MS - 8 * HORA,
    mensagens: 31,
    bytes: 3_100,
    status: STATUS_REGISTRO_FEED_AMAZON.processando,
    criadoEmMs: AGORA_MS - 8 * HORA,
    atualizadoEmMs: AGORA_MS - paradoHaMs,
    prazoEmMs: AGORA_MS + 4 * HORA,
    rodadas: 3,
    expiraEm: new Date(AGORA_MS + 180 * 86_400_000),
  });
}

/** A price run `paginando` with no progress for `paradaHaMs`: the stall a click re-kicks. */
function runParada(m: Mundo, paradaHaMs: number): void {
  m.fake.seed(RUN(), {
    execucaoId: 'exec-preco-parada',
    fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
    baixarPreco: false,
    solicitadaPor: 'operador-teste',
    proximaPagina: 3,
    iniciadaEmMs: AGORA_MS - 2 * HORA,
    progressoEmMs: AGORA_MS - paradaHaMs,
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

describe('★ the gates: SILENT — zero Firestore operations, no line, no producer built', () => {
  it.each([
    ['the read switch unset', { AMAZON_CHAMADAS: undefined }, PORTAO.chamadasDesligadas],
    ['the read switch not exactly on', { AMAZON_CHAMADAS: 'ON' }, PORTAO.chamadasDesligadas],
    ['the price valve unset', { AMAZON_MODO_PRECO: undefined }, PORTAO.valvulaDesligada],
    ['the price valve off', { AMAZON_MODO_PRECO: 'off' }, PORTAO.valvulaDesligada],
    ['the price valve unrecognised', { AMAZON_MODO_PRECO: 'ligado' }, PORTAO.valvulaDesligada],
  ])('%s ⇒ %s, nothing read, nothing logged', async (_c, env, portao) => {
    const m = mundo();
    conta(m);
    vezEnviada(m);
    m.ambiente = { ...m.ambiente, ...env };
    const r = await m.rodar();
    expect(r).toEqual({ portao, contas: [] });
    expect(m.fake.operacoes).toBe(0);
    expect(m.log.linhas).toEqual([]);
    expect(m.construidos).toBe(0);
  });

  it('★ NEAR-MISS: the stock valve is NOT its gate — stock off with price dry-run or on, the step walks (its own conta query, its own line)', async () => {
    for (const modo of ['dry-run', 'on']) {
      const m = mundo();
      conta(m);
      m.ambiente = { ...m.ambiente, AMAZON_MODO_ESTOQUE: 'off', AMAZON_MODO_PRECO: modo };
      const r = await m.rodar();
      expect(r.portao, modo).toBeNull();
      expect(
        m.fake.consultas.filter((q) => q.colecao === 'integracao'),
        modo,
      ).toHaveLength(1);
      expect(m.linhas(), modo).toHaveLength(1);
    }
  });

  it('the preview flag never closes the gate: it never makes a valve off', async () => {
    const m = mundo();
    conta(m);
    m.ambiente = { ...m.ambiente, AMAZON_MODO_PRECO: 'on', AMAZON_PRECO_SO_VALIDACAO: '1' };
    expect((await m.rodar()).portao).toBeNull();
  });
});

describe('★ adoption only: per active conta, the PRICE feed’s daily backstop', () => {
  it('★ a stuck price lease (its record 7 h still) ⇒ ONE adoption rung, named by the São Paulo date', async () => {
    const m = mundo();
    conta(m);
    vezEnviada(m);
    registro(m, 7 * HORA);
    const r = await m.rodar();
    expect(r.contas).toEqual([
      {
        contaId: CONTA,
        desfecho: DESFECHO_BACKSTOP_DIARIO_PRECO.feito,
        adocao: 'adotada',
        registro: null,
        erro: null,
      },
    ]);
    expect(m.lotes).toEqual([
      {
        tarefa: {
          v: 1,
          tipo: 'feed-resultado',
          contaId: CONTA,
          feedId: FEED,
          rodada: 0,
          origem: 'adocao',
        },
        nome: nomeConsultaFeed(CONTA, FEED, `adocao:${dataSaoPauloAmazon(AGORA_MS)}`),
        atrasoS: 0,
      },
    ]);
    expect(m.linhas()).toEqual([
      expect.objectContaining({
        nivel: 'info',
        meta: expect.objectContaining({
          evento: 'preco',
          fluxo: 'preco',
          conta: CONTA,
          etapa: 'adocao',
          desfecho: 'feito',
          adocao: 'adotada',
        }),
      }),
    ]);
    expect(resumirBackstopDiarioPrecoAmazon(r)).toMatchObject({
      contas: 1,
      desfecho_feito: 1,
      adotadas: 1,
    });
  });

  it('NEAR-MISS: a record that moved within 6 h is alive (viva), nothing enqueued, no producer built', async () => {
    const m = mundo();
    conta(m);
    vezEnviada(m);
    registro(m, ADOCAO_FEED_PARADO_MS);
    const r = await m.rodar();
    expect(r.contas[0]).toMatchObject({ desfecho: 'feito', adocao: 'viva' });
    expect(m.lotes).toEqual([]);
    expect(m.construidos).toBe(0);
  });

  it('★ the price fluxo, never stock’s: a stuck STOCK lease is not this step’s (sem-feed), nothing adopted', async () => {
    const m = mundo();
    conta(m);
    vezEnviada(m, { fluxo: FLUXO_FEED_AMAZON.estoque });
    const r = await m.rodar();
    expect(r.contas[0]).toMatchObject({ desfecho: 'feito', adocao: 'sem-feed' });
    expect(m.lotes).toEqual([]);
    // It read the PRICE lease, and nothing of the stock one.
    expect(m.fake.leituras).toContain(VEZ(CONTA, FLUXO_FEED_AMAZON.preco));
    expect(m.fake.leituras).not.toContain(VEZ(CONTA, FLUXO_FEED_AMAZON.estoque));
  });

  it('a missing record of an enviado price lease is created from the lease first, then adopted', async () => {
    const m = mundo();
    conta(m);
    vezEnviada(m);
    const r = await m.rodar();
    expect(r.contas[0]).toMatchObject({ adocao: 'adotada', registro: 'criado' });
    expect(m.fake.ler(REG())).toMatchObject({ fluxo: 'preco', feedId: FEED });
  });

  it('a second run the same day finds today’s rung held (ja-adotada)', async () => {
    const m = mundo();
    conta(m);
    vezEnviada(m);
    registro(m, 7 * HORA);
    await m.rodar();
    expect((await m.rodar()).contas[0]).toMatchObject({ adocao: 'ja-adotada' });
    expect(m.lotes).toHaveLength(1);
  });
});

describe('★ never the run (one re-kick is the operator’s click)', () => {
  it('★ a price run stalled 16 min ⇒ NOTHING: no read of the run, no page enqueued, no write (NEAR-MISS: it IS the stall a click re-kicks)', async () => {
    const m = mundo();
    conta(m);
    runParada(m, RETOMADA_EXECUCAO_PRECO_MS + MIN);
    const escritas = m.fake.escritas.length;
    const r = await m.rodar();
    expect(r.contas[0]).toMatchObject({ desfecho: 'feito', adocao: 'sem-feed' });
    expect(m.fake.leituras.filter((l) => l.startsWith('precosAmazon/'))).toEqual([]);
    expect(m.fake.escritas).toHaveLength(escritas);
    expect(m.lotes).toEqual([]);
    expect(m.construidos).toBe(0);
    // NEAR-MISS: the very run the step left alone is a stall the claim would re-kick.
    expect(
      retomadaExecucaoPrecoAmazon(
        {
          execucaoId: 'exec-preco-parada',
          fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
          proximaPagina: 3,
          iniciadaEmMs: AGORA_MS - 2 * HORA,
          progressoEmMs: AGORA_MS - (RETOMADA_EXECUCAO_PRECO_MS + MIN),
        },
        AGORA_MS,
      ),
    ).not.toBeNull();
  });

  it('★ the step reads nothing of preco/ but the price lease: its only reads are the conta query, the lease and the record', async () => {
    const m = mundo();
    conta(m);
    vezEnviada(m);
    registro(m, 7 * HORA);
    runParada(m, 3 * HORA);
    await m.rodar();
    expect([...new Set(m.fake.leituras)].sort()).toEqual([REG(), VEZ()].sort());
    expect(m.fake.consultas.map((q) => q.colecao)).toEqual(['integracao']);
  });
});

describe('per conta: contained by class, one line each', () => {
  it.each([
    [
      'a Firestore status error on the lease',
      (m: Mundo) => m.fake.falharLeitura(VEZ(), grpc(14, 'UNAVAILABLE')),
      'Firestore/14',
    ],
    [
      'a price lease that no longer parses',
      (m: Mundo) => m.fake.seed(VEZ(), { estado: 'enviado' }),
      'AmazonVezFeedInvalidaError',
    ],
    [
      'the jobs queue’s valve closed',
      (m: Mundo) => {
        vezEnviada(m);
        registro(m, 7 * HORA);
        m.desligado = true;
      },
      new AmazonLotesTarefasDesligadasError().name,
    ],
  ])(
    '%s ⇒ falhou with the class, a WARNING; the other conta still runs',
    async (_c, falhar, erro) => {
      const m = mundo();
      conta(m);
      conta(m, OUTRA);
      falhar(m);
      const r = await m.rodar();
      const porConta = Object.fromEntries(r.contas.map((c) => [c.contaId, c]));
      expect(porConta[CONTA]).toEqual({
        contaId: CONTA,
        desfecho: DESFECHO_BACKSTOP_DIARIO_PRECO.falhou,
        adocao: null,
        registro: null,
        erro,
      });
      expect(porConta[OUTRA]).toMatchObject({ desfecho: 'feito', adocao: 'sem-feed' });
      expect(m.linhas().find((l) => l.meta?.conta === CONTA)?.nivel).toBe('warn');
      expect(m.linhas().find((l) => l.meta?.conta === OUTRA)?.nivel).toBe('info');
      // Never a message: the class only.
      expect(JSON.stringify(m.log.linhas)).not.toContain('UNAVAILABLE');
    },
  );

  it('NEAR-MISS: anything else (a bug) is not contained — the step rejects', async () => {
    const m = mundo();
    conta(m);
    m.fake.falharLeitura(VEZ(), new TypeError('bug'));
    await expect(m.rodar()).rejects.toBeInstanceOf(TypeError);
  });

  it('the conta listing’s own failure rejects the step (the root rethrows it after the stock step)', async () => {
    const m = mundo();
    conta(m);
    m.fake.falharConsulta('integracao', grpc(14, 'UNAVAILABLE'));
    await expect(m.rodar()).rejects.toMatchObject({ code: 14 });
  });

  it('an inactive conta is skipped with no line and nothing read; an id outside the grammar is a WARNING, nothing read for it', async () => {
    const m = mundo();
    conta(m);
    conta(m, 'conta.x');
    conta(m, OUTRA, { ativo: false });
    const r = await m.rodar();
    expect(Object.fromEntries(r.contas.map((c) => [c.contaId, c.desfecho]))).toEqual({
      [CONTA]: 'feito',
      'conta.x': DESFECHO_BACKSTOP_DIARIO_PRECO.idDeContaInvalido,
    });
    expect(m.fake.leituras.filter((c) => c.includes('conta.x') || c.includes(OUTRA))).toEqual([]);
    expect(m.linhas().map((l) => l.nivel)).toEqual(['info', 'warn']);
    expect(resumirBackstopDiarioPrecoAmazon(r)).toMatchObject({
      contas: 2,
      desfecho_feito: 1,
      'desfecho_id-de-conta-invalido': 1,
      adotadas: 0,
    });
  });
});
