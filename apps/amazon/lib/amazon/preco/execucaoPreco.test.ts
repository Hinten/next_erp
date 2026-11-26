/**
 * A price run's PAGES and its Decide (step 13, PR 13-e), end to end against
 * the counting fake Firestore: the REAL claim (`inicioExecucaoPreco.ts`), the
 * REAL run and parts I/O, the REAL context, the REAL shared walk, link reader,
 * live read and listing gate, the REAL page classification and Decide
 * (`paginaPreco.ts`), the REAL avisos seam, and the REAL page and price
 * producers over recording queues that keep every name (a held one refused
 * with the SDK's own 409). Amazon is a scripted `fetch` (a catalogue: a search
 * answers the listed SKUs it was asked for, a GET answers the listing or its
 * own 404) that REFUSES anything unscripted; the live read's pacing runs on
 * the world's fake clock.
 *
 * Pages are dispatched by draining the recorded page queue in order, one page
 * at a time, as the jobs queue's concurrency 1 would. A concurrent writer
 * lands through the fake's write hook, never a timer.
 *
 * ⚠️ D11: the global `fetch` refuses; the read switch is `on` only in the
 * object literal handed to the page. After EVERY test: no network call left
 * the scripted `fetch`, no LWA exchange ran, and nothing PATCHed or posted.
 * PLACEHOLDERS ONLY (public repository).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { CAMINHO_LISTINGS, MARKETPLACE_ID_BR } from '@delfrance/integrations-amazon-sp-api';
import {
  type ExecucaoPrecoAmazon,
  FASE_EXECUCAO_PRECO_AMAZON,
  type FaixaPrecoAmazon,
  INTEGRACAO_TIPO,
  type ItemDivergenciaPrecoAmazon,
  LIMIAR_FEED_PRECO_AMAZON,
  MAX_PARTES_EXECUCAO_PRECO_AMAZON,
  MOTIVO_CONTA_AMAZON,
  TIPO_OFERTA_PRECO_AMAZON,
  idDivergenciaPrecoAmazon,
} from '@delfrance/schemas';

import { chaveContaPrecisaAtencao, relogioDoDocumentoUs } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { loadAmazonContext } from '../core/contexto';
import { MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON } from '../feeds/tarefaLote';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoAviso,
  caminhoConta,
  loggerEspiao,
  respostaJson,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import { gravarParteDivergenciaPrecoAmazon } from './divergenciasPrecoFirestore';
import {
  ACAO_PAGINA_PRECO_AMAZON,
  CAMPOS_PAGINA_EXECUCAO_PRECO_AMAZON,
  type DepsPaginaPrecoAmazon,
  MOTIVO_FEED_NECESSARIO_PRECO_AMAZON,
  ORCAMENTO_PAGINA_PRECO_MS,
  type ResultadoPaginaPrecoAmazon,
  paginaPrecoAmazon,
  severidadePaginaPrecoAmazon,
} from './execucaoPreco';
import {
  ATRASO_PAUSA_PAGINA_PRECO_S,
  type FilaExecucaoPrecoAmazon,
  criarProdutorExecucaoPrecoAmazon,
  iniciarExecucaoPrecoAmazon,
} from './inicioExecucaoPreco';
import { type FilaPrecoAmazon, criarProdutorPrecoAmazon } from './produtorPreco';
import {
  type TarefaPaginaPrecoAmazon,
  type TarefaPrecoSkuAmazon,
  nomeDaTarefaPrecoAmazon,
  nomePaginaPrecoAmazon,
  tarefaPrecoSkuAmazonSchema,
} from './tarefaPreco';

const CONTA = 'conta-amz-execucao-preco';
const REF_CONTA = `documents/integracao/${CONTA}`;
const NORMAL = 'tab-normal';
const PROMO = 'tab-promo';
const RUN = `precosAmazon/${CONTA}`;
const CAMINHO_BUSCA = `${CAMINHO_LISTINGS}/${SPID_A}`;
const parteDe = (execucaoId: string, n: number) =>
  `${RUN}/divergenciasPrecoAmazon/${idDivergenciaPrecoAmazon(execucaoId, n)}`;
const MIN_MS = 60_000;

/* -------------------------------------------------------------------------- */
/*                                  the world                                 */
/* -------------------------------------------------------------------------- */

interface Enfileirada<T> {
  readonly tarefa: T;
  readonly nome: string | null;
  readonly atrasoS: number;
  /** The run's stored `decisao` the instant this enqueue was made. */
  readonly decisaoGuardada: unknown;
}

interface ChamadaAmazon {
  readonly tipo: 'busca' | 'get';
  readonly skus: readonly string[];
}

const mundos: { readonly lwa: readonly string[]; readonly patches: number }[] = [];
const rede: string[] = [];

/** Our offer element in the documented write shape (synthetic prices). */
function elemento(o: FaixaPrecoAmazon): Record<string, unknown> {
  return {
    marketplace_id: MARKETPLACE_ID_BR,
    currency: 'BRL',
    audience: 'ALL',
    our_price: [{ schedule: [{ value_with_tax: o.base }] }],
    minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: o.minimo }] }],
    maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: o.maximo }] }],
  };
}

interface OpcoesListing {
  readonly issues?: readonly unknown[];
}

/** A listing as the model shapes it: a BR summary, our offer, no issue unless told. */
function listing(sku: string, oferta: FaixaPrecoAmazon, o: OpcoesListing = {}) {
  return {
    sku,
    summaries: [
      {
        marketplaceId: MARKETPLACE_ID_BR,
        asin: 'B0EXECPREC1',
        productType: 'LUGGAGE',
        status: ['BUYABLE'],
      },
    ],
    attributes: { purchasable_offer: [elemento(oferta)] },
    issues: o.issues ?? [],
    relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
  };
}

function mundo() {
  const fake = new FakeDb();
  // A link doc, a produto, the run and its parts: no read of one may be unmasked.
  for (const colecao of ['prodAmazon', 'produtos', 'precosAmazon', 'divergenciasPrecoAmazon']) {
    fake.exigirMascaraEm(colecao);
  }
  fake.seed(caminhoConta(CONTA), {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta execução de preço',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
    tabelaNormalOuterRef: `documents/listaDePrecos/${NORMAL}`,
    tabelaPromocionalOuterRef: `documents/listaDePrecos/${PROMO}`,
  });
  // A token far from expiry: no LWA exchange.
  seedCredencial(fake, CONTA, { expirationDate: AGORA_MS + 365 * DIA_MS });
  const log = loggerEspiao();
  const idsPaginas = new Set<string>();
  const idsPreco = new Set<string>();
  let execucoes = 0;
  const m = {
    fake,
    log,
    relogio: AGORA_MS,
    amazon: new Map<string, Record<string, unknown>>(),
    chamadas: [] as ChamadaAmazon[],
    lwa: [] as string[],
    patches: 0,
    /** The `x-amzn-RateLimit-Limit` of every Amazon answer, when set. */
    taxa: null as string | null,
    paginas: [] as Enfileirada<TarefaPaginaPrecoAmazon>[],
    /** Every page name the queue refused because it already held it, in order. */
    paginasRecusadas: [] as string[],
    tarefas: [] as Enfileirada<TarefaPrecoSkuAmazon>[],
    despachadas: new Set<number>(),
    /** A failure for the next price-task enqueue, consumed once. */
    falhaPreco: null as Error | null,
    /** A 429 for the next search, consumed once. */
    limitarProximaBusca: false,
    /** Runs right before each search answer (a clock jump, a concurrent write). */
    antesDaBusca: null as (() => void) | null,
    soValidacao: false,
    ambiente: {
      ...AMBIENTE_LIGADO,
      AMAZON_MODO_PRECO: 'on',
      AMAZON_CANARIO_PRECO: '*',
    } as Record<string, string | undefined>,
    fetch: ((input, init) => {
      const url = new URL(String(input));
      const metodo = init?.method ?? 'GET';
      if (url.pathname === '/auth/o2/token') {
        m.lwa.push(metodo);
        return Promise.resolve(tokenDeAcesso());
      }
      if (metodo !== 'GET') {
        m.patches += 1;
        return Promise.reject(new TypeError(`sem rede: ${metodo} ${url.pathname}`));
      }
      const comTaxa = (r: Response) => {
        if (m.taxa !== null) r.headers.set('x-amzn-RateLimit-Limit', m.taxa);
        return r;
      };
      if (url.pathname === CAMINHO_BUSCA) {
        const pedidos = (url.searchParams.get('identifiers') ?? '').split(',');
        m.chamadas.push({ tipo: 'busca', skus: pedidos });
        const antes = m.antesDaBusca;
        m.antesDaBusca = null;
        antes?.();
        if (m.limitarProximaBusca) {
          m.limitarProximaBusca = false;
          return Promise.resolve(respostaJson(429, { errors: [{ code: 'QuotaExceeded' }] }));
        }
        const items = pedidos.filter((s) => m.amazon.has(s)).map((s) => m.amazon.get(s));
        return Promise.resolve(
          comTaxa(respostaJson(200, { numberOfResults: items.length, items })),
        );
      }
      if (url.pathname.startsWith(`${CAMINHO_BUSCA}/`)) {
        const sku = decodeURIComponent(url.pathname.slice(CAMINHO_BUSCA.length + 1));
        m.chamadas.push({ tipo: 'get', skus: [sku] });
        const corpo = m.amazon.get(sku);
        return Promise.resolve(
          comTaxa(
            corpo === undefined
              ? respostaJson(404, { errors: [{ code: 'NOT_FOUND' }] })
              : respostaJson(200, corpo),
          ),
        );
      }
      return Promise.reject(new TypeError(`sem rede: ${metodo} ${url.pathname} não roteirizado`));
    }) as typeof globalThis.fetch,
    produtorPaginas: () =>
      criarProdutorExecucaoPrecoAmazon({
        desligado: false,
        fila: (): FilaExecucaoPrecoAmazon => ({
          enqueue: (tarefa, opcoes) => {
            const id = opcoes?.id;
            if (id !== undefined) {
              if (idsPaginas.has(id)) {
                m.paginasRecusadas.push(id);
                return Promise.reject(falhaDeTarefaJaExistente(id));
              }
              idsPaginas.add(id);
            }
            m.paginas.push({
              tarefa,
              nome: id ?? null,
              atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
              decisaoGuardada: m.fake.ler(RUN)?.decisao,
            });
            return Promise.resolve();
          },
        }),
      }),
    deps(): DepsPaginaPrecoAmazon {
      return {
        ambiente: m.ambiente,
        agora: () => m.relogio,
        logger: log.logger,
        increment,
        registro: { tentativa: 0, idTarefa: 'tarefa-pagina-preco' },
        fetch: m.fetch,
        gerarCorrelationId: () => 'corr-execucao-preco',
        carregarContexto: loadAmazonContext,
        produtorPaginas: m.produtorPaginas,
        produtorPreco: () =>
          criarProdutorPrecoAmazon({
            desligado: false,
            fila: (): FilaPrecoAmazon => ({
              enqueue: (tarefa, opcoes) => {
                const falha = m.falhaPreco;
                if (falha !== null) {
                  m.falhaPreco = null;
                  return Promise.reject(falha);
                }
                const id = opcoes?.id;
                if (id !== undefined) {
                  if (idsPreco.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
                  idsPreco.add(id);
                }
                m.tarefas.push({
                  tarefa,
                  nome: id ?? null,
                  atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
                  decisaoGuardada: m.fake.ler(RUN)?.decisao,
                });
                return Promise.resolve();
              },
            }),
          }),
        soValidacao: m.soValidacao,
        esperar: (ms) => {
          m.relogio += ms;
          return Promise.resolve();
        },
      };
    },
    run: () => fake.ler(RUN) as (ExecucaoPrecoAmazon & Record<string, unknown>) | undefined,
    iniciar: (pedido: { baixarPreco?: boolean; confirmarReducaoEmMassa?: boolean } = {}) =>
      iniciarExecucaoPrecoAmazon(
        asDb(fake),
        CONTA,
        {
          baixarPreco: pedido.baixarPreco ?? false,
          confirmarReducaoEmMassa: pedido.confirmarReducaoEmMassa ?? false,
          solicitadaPor: 'operador-teste',
        },
        {
          filaDesligada: false,
          produtor: m.produtorPaginas,
          agora: () => m.relogio,
          gerarExecucaoId: () => {
            execucoes += 1;
            return `exec-preco-${String(execucoes)}`;
          },
          logger: log.logger,
        },
      ),
    pagina: (t: TarefaPaginaPrecoAmazon) => paginaPrecoAmazon(asDb(fake), t, m.deps()),
    /** Dispatch the pages not yet dispatched, in order, until none is left (60 at most). */
    drenar: async (quantas?: number): Promise<ResultadoPaginaPrecoAmazon[]> => {
      const saidas: ResultadoPaginaPrecoAmazon[] = [];
      for (let n = 0; n < (quantas ?? 60); n += 1) {
        const proxima = m.paginas.findIndex((_p, i) => !m.despachadas.has(i));
        if (proxima === -1) return saidas;
        m.despachadas.add(proxima);
        saidas.push(
          await m.pagina((m.paginas[proxima] as Enfileirada<TarefaPaginaPrecoAmazon>).tarefa),
        );
      }
      if (quantas !== undefined) return saidas;
      throw new Error('teste: a fila de páginas não esvaziou');
    },
    linhasPagina: () =>
      log.linhas.filter((l) => l.meta?.fase === 'execucao' && l.meta.etapa === 'pagina'),
  };
  mundos.push(m);
  return m;
}

type Mundo = ReturnType<typeof mundo>;

/* ------------------------------- the seeds -------------------------------- */

interface OpcoesSku {
  readonly produtoId?: string;
  /** The ERP's normal price (`null`: none). */
  readonly normal?: number | null;
  /** The ERP's promotional price (`null`: none). */
  readonly promo?: number | null;
  /** Amazon's live offer (`null`: Amazon does not list it). */
  readonly amazon?: FaixaPrecoAmazon | null;
  readonly issues?: readonly unknown[];
}

/** A simple produto linked to `s`: ERP normal 60 and Amazon 50 unless told (an increase). */
function sku(m: Mundo, s: string, o: OpcoesSku = {}): string {
  const produtoId = o.produtoId ?? `p-${s.replace(/[^A-Za-z0-9-]/g, '_')}`;
  const normal = o.normal === undefined ? 60 : o.normal;
  const promo = o.promo === undefined ? null : o.promo;
  m.fake.seed(`produtos/${produtoId}`, {
    nome: `Produto ${s}`,
    precos: {
      ...(normal === null ? {} : { [NORMAL]: { valor: normal } }),
      ...(promo === null ? {} : { [PROMO]: { valor: promo } }),
    },
  });
  m.fake.seed(`produtos/${produtoId}/prodAmazon/l1`, {
    contaAmazonOuterRef: REF_CONTA,
    sku: s,
    productDataJson: { pesado: 'x'.repeat(32) },
  });
  const amazon = o.amazon === undefined ? { base: 50, minimo: 50, maximo: 50 } : o.amazon;
  if (amazon !== null) m.amazon.set(s, listing(s, amazon, { issues: o.issues }));
  return s;
}

/** `n` sendable SKUs `<prefixo>-0001`… (an increase each, unless told). */
function varios(m: Mundo, n: number, prefixo: string, o: OpcoesSku = {}): string[] {
  return Array.from({ length: n }, (_v, i) =>
    sku(m, `${prefixo}-${String(i + 1).padStart(4, '0')}`, o),
  );
}

/** A link doc under a produto that does not exist (refused, never read on Amazon). */
function fantasma(m: Mundo, produtoId: string, s: string): void {
  m.fake.seed(`produtos/${produtoId}/prodAmazon/l1`, {
    contaAmazonOuterRef: REF_CONTA,
    sku: s,
    productDataJson: { pesado: 'x'.repeat(32) },
  });
}

/** One part member (a sendable SKU), for a run seeded straight into Decide. */
function membro(s: string, base = 60): ItemDivergenciaPrecoAmazon {
  return {
    sku: s,
    vinculo: `produtos/p-${s}/prodAmazon/l1`,
    unidadeId: `p-${s}`,
    oferta: { tipo: TIPO_OFERTA_PRECO_AMAZON.lida, base: 50, minimo: 50, maximo: 50 },
    faixa: { base, minimo: base, maximo: base },
    tipoProduto: 'LUGGAGE',
    lidoEmMs: AGORA_MS,
  };
}

const EXEC_SEMEADA = 'exec-preco-semeada';

/**
 * A run seeded straight into `decidindo` with `partes` parts (each SKU list
 * one part), its counts as the walk would have summed them.
 */
async function semearDecidindo(
  m: Mundo,
  partes: readonly (readonly string[])[],
  o: { readonly semCaminho?: number; readonly baixarPreco?: boolean } = {},
): Promise<TarefaPaginaPrecoAmazon> {
  for (const [n, skus] of partes.entries()) {
    await gravarParteDivergenciaPrecoAmazon(asDb(m.fake), {
      contaId: CONTA,
      execucaoId: EXEC_SEMEADA,
      parte: n,
      itens: skus.map((s) => membro(s)),
      agoraMs: AGORA_MS,
    });
  }
  const enviaveis = partes.reduce((s, p) => s + p.length, 0);
  m.fake.seed(RUN, {
    execucaoId: EXEC_SEMEADA,
    fase: FASE_EXECUCAO_PRECO_AMAZON.decidindo,
    motivo: null,
    baixarPreco: o.baixarPreco ?? false,
    confirmarReducaoEmMassa: false,
    solicitadaPor: 'operador-teste',
    cursores: {
      canonica: { ultimoCaminho: null, concluida: true },
      nua: { ultimoCaminho: null, concluida: true },
    },
    proximaPagina: 9,
    proximaParte: partes.length,
    itensPorParte: partes.map((p) => p.length),
    contagens: {
      lidos: enviaveis,
      iguais: 0,
      enviaveis,
      sobe: enviaveis,
      desce: 0,
      quedaExcessiva: 0,
      direcaoDesconhecida: 0,
      reducaoSemConsentimento: 0,
      precoAtualIlegivel: 0,
      faixaInvertida: 0,
      tipoProdutoIlegivel: 0,
      semPreco: 0,
      semCaminho: o.semCaminho ?? 0,
      temPrecoComDesconto: 0,
      temOfertaB2B: 0,
      fechada: 0,
      jaVisto: 0,
      naoConfirmados: 0,
      problemasDePreco: 0,
      limiteTaxa: null,
      porChave: {},
    },
    amostraReducoes: [],
    decisao: null,
    lotes: {},
    iniciadaEmMs: AGORA_MS - MIN_MS,
    progressoEmMs: AGORA_MS - MIN_MS,
    esperaLotesAteMs: null,
    relogioInicio: m.fake.carimboDe(caminhoConta(CONTA)) ?? null,
  });
  return { v: 1, tipo: 'preco-pagina', contaId: CONTA, execucaoId: EXEC_SEMEADA, pagina: 9 };
}

/** The claim, then every page. */
async function rodar(m: Mundo, pedido: Parameters<Mundo['iniciar']>[0] = {}) {
  const inicio = await m.iniciar(pedido);
  const paginas = await m.drenar();
  return { inicio, paginas, ultima: paginas.at(-1) };
}

function avisoDe(m: Mundo, motivo: Parameters<typeof chaveContaPrecisaAtencao>[1]) {
  return m.fake.ler(caminhoAviso(chaveContaPrecisaAtencao(CONTA, motivo)));
}

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubGlobal('fetch', (input: unknown) => {
    rede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  expect(rede).toEqual([]);
  rede.length = 0;
  for (const m of mundos) {
    expect(m.lwa).toEqual([]);
    expect(m.patches).toBe(0);
  }
  mundos.length = 0;
});

/* -------------------------------------------------------------------------- */
/*                          the run's pages, end to end                       */
/* -------------------------------------------------------------------------- */

describe('★ two pages, then Decide', () => {
  it('a 301-doc walk is two pages: page 1 holds the one sendable SKU, writes part 0, and Decide hands it to ONE task', async () => {
    const m = mundo();
    for (let i = 0; i < 300; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    const s = sku(m, 'SKU-ENVIA-1');
    const { inicio, paginas, ultima } = await rodar(m);
    expect(inicio.ok).toBe(true);
    expect(paginas.map((p) => p.acao)).toEqual([
      ACAO_PAGINA_PRECO_AMAZON.paginaConcluida,
      ACAO_PAGINA_PRECO_AMAZON.concluida,
    ]);
    // Page 0 counted 300 refusals and wrote NO part (dense parts); page 1 wrote part 0.
    expect(paginas[0]?.parte).toBeNull();
    expect(paginas[1]?.parte).toBe(0);
    expect(m.fake.ler(parteDe('exec-preco-1', 0))?.itens).toEqual([
      expect.objectContaining({ sku: s, faixa: { base: 60, minimo: 60, maximo: 60 } }),
    ]);
    expect(ultima?.decide).toMatchObject({ decisao: 'tarefas', tarefas: 1, planoGuardado: false });
    expect(m.tarefas.map((x) => x.tarefa)).toEqual([
      tarefaPrecoSkuAmazonSchema.parse({
        v: 1,
        tipo: 'preco-sku',
        contaId: CONTA,
        sku: s,
        origem: 'execucao',
        referencia: 'exec-preco-1',
        parte: 0,
        baixarPreco: false,
        solicitadoEmMs: m.relogio,
        codigosAntes: [],
      }),
    ]);
    const run = m.run();
    expect(run).toMatchObject({
      fase: 'concluida',
      decisao: 'tarefas',
      proximaPagina: 2,
      proximaParte: 1,
      itensPorParte: [1],
      lotes: {},
      esperaLotesAteMs: null,
    });
    expect(run?.contagens).toMatchObject({ lidos: 301, enviaveis: 1, sobe: 1, desce: 0 });
    expect(run?.contagens.porChave).toMatchObject({ 'produto-ausente': 300 });
    // The pages were enqueued NAMED (page 0 by the claim, page 1 by page 0), no delay.
    expect(m.paginas.map((p) => [p.tarefa.pagina, p.nome, p.atrasoS])).toEqual([
      [0, nomePaginaPrecoAmazon(CONTA, 'exec-preco-1', 0), 0],
      [1, nomePaginaPrecoAmazon(CONTA, 'exec-preco-1', 1), 0],
    ]);
    // Every task named by its own fields, no delay (no order race to wait out).
    for (const x of m.tarefas) {
      expect(x.nome).toBe(nomeDaTarefaPrecoAmazon(x.tarefa));
      expect(x.atrasoS).toBe(0);
    }
  });

  it('★ a stale page dispatch of an OLDER run writes nothing and enqueues nothing', async () => {
    const m = mundo();
    sku(m, 'SKU-VELHA-1');
    await rodar(m);
    const velha = m.paginas[0]?.tarefa as TarefaPaginaPrecoAmazon;
    m.relogio += MIN_MS;
    await m.iniciar();
    expect(m.run()?.execucaoId).toBe('exec-preco-2');
    const escritas = m.fake.escritas.length;
    const paginas = m.paginas.length;
    const tarefas = m.tarefas.length;
    const r = await m.pagina(velha);
    expect(r.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.naoEDono);
    expect(m.fake.escritas).toHaveLength(escritas);
    expect(m.paginas).toHaveLength(paginas);
    expect(m.tarefas).toHaveLength(tarefas);
    expect(m.chamadas).toHaveLength(1);
  });

  it('★ relogioInicio is PAGE 0’s step-0 read, and a later page keeps it (the clock of the run’s avisos)', async () => {
    const m = mundo();
    for (let i = 0; i < 300; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    sku(m, 'SKU-RELOGIO-1', { normal: 50, promo: 55 });
    await m.iniciar();
    const doClaim = m.fake.carimboDe(RUN);
    await m.drenar(1);
    const primeira = m.run()?.relogioInicio as { seconds: number; nanoseconds: number };
    // Page 0 read the run as the claim left it: that read's time, never null.
    expect(primeira).toMatchObject({
      seconds: doClaim?.seconds,
      nanoseconds: doClaim?.nanoseconds,
    });
    const [ultima] = await m.drenar();
    expect(ultima?.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.concluida);
    expect(m.run()?.relogioInicio).toMatchObject({
      seconds: primeira.seconds,
      nanoseconds: primeira.nanoseconds,
    });
    // The inverted faixa page 1 counted is raised on THAT clock.
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.precoFaixaInvertida)?.relogioEvento).toBe(
      relogioDoDocumentoUs(primeira),
    );
  });
});

describe('★ step 0', () => {
  it('a page BEHIND the next ⇒ page proximaPagina re-enqueued under ITS name, nothing walked', async () => {
    const m = mundo();
    for (let i = 0; i < 300; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    sku(m, 'SKU-ATRASO-1');
    await m.iniciar();
    await m.drenar(1);
    expect(m.run()?.proximaPagina).toBe(1);
    // The page-1 task is lost: its name is freed for this test, then page 0 runs again.
    m.paginas.splice(1, 1);
    const consultas = m.fake.consultas.length;
    const escritas = m.fake.escritas.length;
    const r = await m.pagina(m.paginas[0]?.tarefa as TarefaPaginaPrecoAmazon);
    expect(r.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.adiantada);
    expect(m.fake.consultas).toHaveLength(consultas);
    expect(m.fake.escritas).toHaveLength(escritas);
    // The name page 0 had already used for page 1 is held: the re-enqueue dedupes.
    expect(m.paginas).toHaveLength(1);
    // …and it WAS attempted, under page 1's own name (never page 0's).
    expect(m.paginasRecusadas).toEqual([nomePaginaPrecoAmazon(CONTA, 'exec-preco-1', 1)]);
  });

  it('NEAR-MISS: the healing re-enqueue is the NEXT page, named — a fresh name lands', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, [['SKU-A']]);
    m.fake.seed(RUN, { ...m.fake.ler(RUN), fase: 'paginando', proximaPagina: 5 });
    const r = await m.pagina({ ...t, pagina: 3 });
    expect(r.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.adiantada);
    expect(m.paginas.map((p) => [p.tarefa.pagina, p.nome])).toEqual([
      [5, nomePaginaPrecoAmazon(CONTA, EXEC_SEMEADA, 5)],
    ]);
  });

  it('★ decidindo ⇒ Decide from the STORED plan: the same task names, each held one counted', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, [['SKU-A', 'SKU-B']]);
    const primeiro = await m.pagina(t);
    expect(primeiro.decide).toMatchObject({ decisao: 'tarefas', tarefas: 2, jaEnfileiradas: 0 });
    // The run as a Decide that died after its enqueues left it: still deciding, plan stored.
    m.fake.seed(RUN, { ...m.fake.ler(RUN), fase: 'decidindo' });
    const segundo = await m.pagina(t);
    expect(segundo.decide).toMatchObject({
      decisao: 'tarefas',
      planoGuardado: true,
      tarefas: 0,
      jaEnfileiradas: 2,
    });
    expect(m.tarefas).toHaveLength(2);
    expect(m.run()?.fase).toBe('concluida');
  });

  it('NEAR-MISS: a stored plan is carried out under the valve as it stands — never re-planned', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, [['SKU-A', 'SKU-B']]);
    m.fake.seed(RUN, { ...m.fake.ler(RUN), decisao: 'tarefas' });
    // A re-plan under this list would be `canario`; the stored `tarefas` runs,
    // each SKU through the valve: the listed one sent, the other counted.
    m.ambiente.AMAZON_CANARIO_PRECO = `${CONTA}:SKU-A`;
    const r = await m.pagina(t);
    expect(r.decide).toMatchObject({
      decisao: 'tarefas',
      planoGuardado: true,
      tarefas: 1,
      simulados: 1,
    });
    expect(m.tarefas.map((x) => x.tarefa.sku)).toEqual(['SKU-A']);
    expect(m.run()?.decisao).toBe('tarefas');
  });

  it('★ a falhou run with proximaPagina 0 ⇒ page 0 STOPS (NEAR-MISS: the same run paginando walks)', async () => {
    for (const [fase, esperado] of [
      ['falhou', ACAO_PAGINA_PRECO_AMAZON.naoEDono],
      ['cancelada', ACAO_PAGINA_PRECO_AMAZON.naoEDono],
      ['truncada', ACAO_PAGINA_PRECO_AMAZON.naoEDono],
      ['concluida', ACAO_PAGINA_PRECO_AMAZON.naoEDono],
      ['paginando', ACAO_PAGINA_PRECO_AMAZON.concluida],
    ] as const) {
      const m = mundo();
      sku(m, 'SKU-FASE-1');
      await m.iniciar();
      m.fake.seed(RUN, { ...m.fake.ler(RUN), fase });
      const consultas = m.fake.consultas.length;
      const r = await m.pagina(m.paginas[0]?.tarefa as TarefaPaginaPrecoAmazon);
      expect(r.acao, fase).toBe(esperado);
      if (esperado === ACAO_PAGINA_PRECO_AMAZON.naoEDono) {
        expect(m.fake.consultas, fase).toHaveLength(consultas);
        expect(m.chamadas, fase).toEqual([]);
      }
    }
  });

  it('a page PAST proximaPagina, another run’s id, or no run at all ⇒ stop, nothing written', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, [['SKU-A']]);
    m.fake.seed(RUN, { ...m.fake.ler(RUN), fase: 'paginando' });
    const escritas = m.fake.escritas.length;
    expect((await m.pagina({ ...t, pagina: 10 })).acao).toBe(ACAO_PAGINA_PRECO_AMAZON.naoEDono);
    expect((await m.pagina({ ...t, execucaoId: 'outra-execucao' })).acao).toBe(
      ACAO_PAGINA_PRECO_AMAZON.naoEDono,
    );
    m.fake.apagar(RUN);
    expect((await m.pagina(t)).acao).toBe(ACAO_PAGINA_PRECO_AMAZON.naoEDono);
    expect(m.fake.escritas).toHaveLength(escritas);
    expect(m.paginas).toEqual([]);
  });

  it('the conta naming no normal tabela ⇒ the run closed falhou (sem-tabela-normal), nothing walked', async () => {
    const m = mundo();
    sku(m, 'SKU-SEM-TABELA');
    await m.iniciar();
    m.fake.seed(caminhoConta(CONTA), {
      ...m.fake.ler(caminhoConta(CONTA)),
      tabelaNormalOuterRef: null,
    });
    const [r] = await m.drenar();
    expect(r).toMatchObject({ acao: 'falhou', motivo: 'sem-tabela-normal' });
    expect(m.run()).toMatchObject({ fase: 'falhou', motivo: 'sem-tabela-normal' });
    expect(m.fake.consultas.filter((q) => q.colecao === 'prodAmazon')).toEqual([]);
    expect(m.chamadas).toEqual([]);
  });
});

describe('★ the valve', () => {
  it('★ off ⇒ ZERO Firestore operations, ONE valve line and ONE page line', async () => {
    const m = mundo();
    sku(m, 'SKU-VALVULA-1');
    await m.iniciar();
    for (const modo of [undefined, 'off', 'desligado']) {
      m.ambiente.AMAZON_MODO_PRECO = modo;
      const antes = m.fake.operacoes;
      m.log.linhas.length = 0;
      const r = await m.pagina(m.paginas[0]?.tarefa as TarefaPaginaPrecoAmazon);
      expect(r.acao, String(modo)).toBe(ACAO_PAGINA_PRECO_AMAZON.valvulaDesligada);
      expect(m.fake.operacoes, String(modo)).toBe(antes);
      expect(m.log.linhas.map((l) => l.meta?.evento)).toEqual(['valvula', 'preco']);
    }
    expect(m.chamadas).toEqual([]);
  });

  it('★ dry-run and on walk ALIKE: the same part, the same counts (the form is Decide’s)', async () => {
    const partes: unknown[] = [];
    for (const modo of ['dry-run', 'on']) {
      const m = mundo();
      m.ambiente.AMAZON_MODO_PRECO = modo;
      varios(m, 3, 'SKU-MODO');
      const { ultima } = await rodar(m);
      partes.push(m.fake.ler(parteDe('exec-preco-1', 0))?.itens);
      expect(m.run()?.contagens.enviaveis, modo).toBe(3);
      expect(ultima?.decide?.decisao, modo).toBe(modo === 'on' ? 'tarefas' : 'dry-run');
      if (modo === 'dry-run') {
        expect(m.tarefas).toEqual([]);
        expect(ultima?.decide?.simulados).toBe(3);
      }
    }
    expect(partes[0]).toEqual(partes[1]);
  });

  it('the preview flag with on + * reads dry-run: no task, and the page line is an ERROR naming the verdict', async () => {
    const m = mundo();
    m.soValidacao = true;
    varios(m, 2, 'SKU-PREVIA');
    const { ultima } = await rodar(m);
    expect(ultima).toMatchObject({ previa: true, veredito: 'validacao-com-todos' });
    expect(ultima?.decide?.decisao).toBe('dry-run');
    expect(m.tarefas).toEqual([]);
    expect(m.linhasPagina().at(-1)?.nivel).toBe('error');
  });
});

describe('★ bounds', () => {
  it('★ a page at proximaParte = MAX_PARTES_EXECUCAO_PRECO_AMAZON ⇒ truncada partes-demais, NO part written', async () => {
    const m = mundo();
    sku(m, 'SKU-LIMITE-1');
    await m.iniciar();
    m.fake.seed(RUN, {
      ...m.fake.ler(RUN),
      proximaParte: MAX_PARTES_EXECUCAO_PRECO_AMAZON,
      itensPorParte: Array.from({ length: MAX_PARTES_EXECUCAO_PRECO_AMAZON }, () => 1),
    });
    const [r] = await m.drenar();
    expect(r).toMatchObject({ acao: 'truncada', motivo: 'partes-demais' });
    expect(m.run()).toMatchObject({ fase: 'truncada', motivo: 'partes-demais' });
    expect(m.fake.escritas.filter((x) => x.caminho.includes('divergenciasPrecoAmazon'))).toEqual(
      [],
    );
    expect(m.tarefas).toEqual([]);
  });

  it('NEAR-MISS: one part below the bound, the page writes part MAX − 1', async () => {
    const m = mundo();
    sku(m, 'SKU-LIMITE-2');
    await m.iniciar();
    const n = MAX_PARTES_EXECUCAO_PRECO_AMAZON - 1;
    m.fake.seed(RUN, {
      ...m.fake.ler(RUN),
      proximaParte: n,
      itensPorParte: Array.from({ length: n }, () => 1),
    });
    await m.drenar(1);
    expect(m.fake.ler(parteDe('exec-preco-1', n))).toBeDefined();
    expect(m.run()?.proximaParte).toBe(MAX_PARTES_EXECUCAO_PRECO_AMAZON);
    // The part's size is APPENDED to the run's list, every earlier one kept.
    expect(m.run()?.itensPorParte).toHaveLength(MAX_PARTES_EXECUCAO_PRECO_AMAZON);
    expect(m.run()?.itensPorParte.at(-1)).toBe(1);
  });
});

describe('★ dense parts', () => {
  it('a page with ZERO sendable SKUs writes no part and does not advance proximaParte', async () => {
    const m = mundo();
    sku(m, 'SKU-IGUAL-1', { amazon: { base: 60, minimo: 60, maximo: 60 } });
    const { ultima } = await rodar(m);
    expect(ultima?.parte).toBeNull();
    expect(m.run()).toMatchObject({ proximaParte: 0, itensPorParte: [], decisao: 'nada' });
    expect(m.run()?.contagens.iguais).toBe(1);
    expect(m.fake.escritas.filter((x) => x.caminho.includes('divergenciasPrecoAmazon'))).toEqual(
      [],
    );
  });

  it('31 parts of one sendable SKU each ⇒ ONE planned batch (the packing follows the drift, not the pages)', async () => {
    const m = mundo();
    const partes = Array.from({ length: 31 }, (_v, i) => [`SKU-DENSA-${String(i)}`]);
    const t = await semearDecidindo(m, partes);
    const r = await m.pagina(t);
    expect(r.decide).toMatchObject({ decisao: 'lotes', lotes: 1, tarefas: 0 });
    expect(r.motivo).toBe(MOTIVO_FEED_NECESSARIO_PRECO_AMAZON);
    expect(m.tarefas).toEqual([]);
    // Log-only: no batch on the run, no wait stamped, nothing enqueued.
    expect(m.run()).toMatchObject({ decisao: 'lotes', lotes: {}, esperaLotesAteMs: null });
    expect(m.paginas).toEqual([]);
    expect(MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON).toBeGreaterThanOrEqual(31);
    expect(m.linhasPagina().at(-1)).toMatchObject({
      nivel: 'warn',
      meta: expect.objectContaining({ motivo: 'feed-necessario', decisao: 'lotes', lotes: 1 }),
    });
  });
});

describe('★ Decide', () => {
  it('★ 30 sendable pathful ⇒ 30 tasks, each with its parte (NEAR-MISS triple: 31 ⇒ the placeholder; 29 + one pathless ⇒ the placeholder)', async () => {
    const m = mundo();
    const skus = varios(m, LIMIAR_FEED_PRECO_AMAZON, 'SKU-TRINTA');
    const { ultima } = await rodar(m);
    expect(ultima?.decide).toMatchObject({ decisao: 'tarefas', tarefas: 30 });
    expect(m.tarefas.map((x) => x.tarefa.sku).sort()).toEqual([...skus].sort());
    expect(new Set(m.tarefas.map((x) => x.tarefa.parte))).toEqual(new Set([0]));

    const n = mundo();
    varios(n, LIMIAR_FEED_PRECO_AMAZON + 1, 'SKU-TRINTA-UM');
    const r31 = (await rodar(n)).ultima;
    expect(r31?.decide?.decisao).toBe('lotes');
    expect(r31?.motivo).toBe('feed-necessario');
    expect(n.tarefas).toEqual([]);

    const o = mundo();
    varios(o, LIMIAR_FEED_PRECO_AMAZON - 1, 'SKU-VINTE-NOVE');
    sku(o, 'SKU/SEM/CAMINHO');
    const r29 = (await rodar(o)).ultima;
    expect(o.run()?.contagens).toMatchObject({ enviaveis: 30, semCaminho: 1 });
    expect(r29?.decide?.decisao).toBe('lotes');
    expect(o.tarefas).toEqual([]);
  });

  it('★ a canary LIST with hits in parts 0 and 7 ⇒ TWO tasks (parte 0 and 7), no placeholder', async () => {
    const m = mundo();
    const partes = Array.from({ length: 8 }, (_v, i) =>
      Array.from({ length: 5 }, (_w, j) => `SKU-C${String(i)}-${String(j)}`),
    );
    m.ambiente.AMAZON_CANARIO_PRECO = `${CONTA}:SKU-C0-3,${CONTA}:SKU-C7-1`;
    const t = await semearDecidindo(m, partes);
    const r = await m.pagina(t);
    expect(r.decide).toMatchObject({ decisao: 'canario', tarefas: 2, simulados: 38 });
    expect(r.motivo).toBeNull();
    expect(m.tarefas.map((x) => [x.tarefa.sku, x.tarefa.parte]).sort()).toEqual([
      ['SKU-C0-3', 0],
      ['SKU-C7-1', 7],
    ]);
    for (const x of m.tarefas) {
      expect(x.tarefa).toMatchObject({
        origem: 'execucao',
        referencia: EXEC_SEMEADA,
        codigosAntes: [],
      });
    }
  });

  it('a stored canario plan under a valve widened to * sends NOTHING, the once-listed SKU included (no list names a hit): every SKU counted, a new run is the operator’s', async () => {
    const m = mundo();
    m.ambiente.AMAZON_CANARIO_PRECO = `${CONTA}:SKU-W-0`;
    const t = await semearDecidindo(m, [['SKU-W-0', 'SKU-W-1']]);
    m.fake.seed(RUN, { ...m.fake.ler(RUN), decisao: 'canario' });
    m.ambiente.AMAZON_CANARIO_PRECO = '*';
    const r = await m.pagina(t);
    expect(r.decide).toMatchObject({ decisao: 'canario', tarefas: 0, simulados: 2 });
    expect(r.decide?.simulados).toBe(m.run()?.contagens.enviaveis);
    expect(m.tarefas).toEqual([]);
  });

  it('★ a canary hit past part 50 (two getAll slices) is found: Decide reads EVERY part, 52 of one SKU each ⇒ ONE task, parte 51', async () => {
    const m = mundo();
    const partes = Array.from({ length: 52 }, (_v, i) => [`SKU-LONGE-${String(i)}`]);
    m.ambiente.AMAZON_CANARIO_PRECO = `${CONTA}:SKU-LONGE-51`;
    const t = await semearDecidindo(m, partes);
    const r = await m.pagina(t);
    expect(r.decide).toMatchObject({
      decisao: 'canario',
      tarefas: 1,
      simulados: 51,
      partesAusentes: 0,
    });
    expect(m.tarefas.map((x) => [x.tarefa.sku, x.tarefa.parte])).toEqual([['SKU-LONGE-51', 51]]);
  });

  it('★ a concurrent Decide’s STORED plan wins: this Decide’s plan write re-derives onto it and carries IT out — never two plans for one run', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, [['SKU-P-1', 'SKU-P-2']]);
    // This Decide would plan `tarefas` (on + *); a Decide that ran meanwhile
    // under a dry-run valve stored its plan first.
    m.fake.antesDaProximaEscrita(RUN, () => {
      m.fake.seed(RUN, { ...m.fake.ler(RUN), decisao: 'dry-run' });
    });
    const r = await m.pagina(t);
    expect(r.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.concluida);
    expect(r.decide).toMatchObject({ decisao: 'dry-run', tarefas: 0, simulados: 2 });
    expect(m.tarefas).toEqual([]);
    expect(m.run()).toMatchObject({ fase: 'concluida', decisao: 'dry-run' });
  });

  it('every Decide task carries the run’s consent and Decide’s clock, and parses as a run task', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, [['SKU-K-1'], ['SKU-K-2']], { baixarPreco: true });
    m.relogio = AGORA_MS + 7 * MIN_MS;
    await m.pagina(t);
    expect(m.tarefas.map((x) => x.tarefa)).toEqual([
      expect.objectContaining({
        sku: 'SKU-K-1',
        parte: 0,
        baixarPreco: true,
        solicitadoEmMs: m.relogio,
      }),
      expect.objectContaining({
        sku: 'SKU-K-2',
        parte: 1,
        baixarPreco: true,
        solicitadoEmMs: m.relogio,
      }),
    ]);
  });

  it('a SKU met in two parts is handed to ONE task, the first part’s', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, [['SKU-DUP-1'], ['SKU-DUP-1', 'SKU-DUP-2']]);
    const r = await m.pagina(t);
    expect(r.decide).toMatchObject({ tarefas: 2, jaEnfileiradas: 0 });
    expect(m.tarefas.map((x) => [x.tarefa.sku, x.tarefa.parte])).toEqual([
      ['SKU-DUP-1', 0],
      ['SKU-DUP-2', 1],
    ]);
  });

  it('a part gone (its TTL) is counted, its SKUs not sent; the rest goes (a WARNING line)', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, [['SKU-G-1'], ['SKU-G-2']]);
    m.fake.apagar(parteDe(EXEC_SEMEADA, 0));
    const r = await m.pagina(t);
    expect(r.decide).toMatchObject({ decisao: 'tarefas', tarefas: 1, partesAusentes: 1 });
    expect(m.tarefas.map((x) => x.tarefa.sku)).toEqual(['SKU-G-2']);
    expect(severidadePaginaPrecoAmazon(r)).toBe('WARNING');
  });

  it('D = 0 ⇒ nada: no part read, nothing enqueued, concluida', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, []);
    const r = await m.pagina(t);
    expect(r.decide).toMatchObject({ decisao: 'nada', tarefas: 0 });
    expect(m.fake.leituras.filter((l) => l.includes('divergenciasPrecoAmazon'))).toEqual([]);
    expect(m.run()?.fase).toBe('concluida');
  });
});

describe('★ the mass stop, wired', () => {
  /** One SKU falling by more than half (100 → 40), with consent. */
  function queda(m: Mundo) {
    sku(m, 'SKU-QUEDA-1', { normal: 40, amazon: { base: 100, minimo: 100, maximo: 100 } });
  }

  it('★ a run whose counts meet the stop ⇒ ZERO enqueues, the aviso raised, the sample on the run, concluida', async () => {
    const m = mundo();
    queda(m);
    const { ultima } = await rodar(m, { baixarPreco: true });
    expect(ultima?.decide?.decisao).toBe('reducao-em-massa');
    expect(m.tarefas).toEqual([]);
    expect(m.run()).toMatchObject({
      fase: 'concluida',
      decisao: 'reducao-em-massa',
      amostraReducoes: ['SKU-QUEDA-1:100>40'],
    });
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.precoReducaoEmMassa)?.resolvidoEm).toBeNull();
    expect(ultima?.avisos).toContain('preco-reducao-em-massa:levantar');
    expect(ultima?.amostraExecucao).toBe('SKU-QUEDA-1:100>40');
    expect(m.linhasPagina().at(-1)?.nivel).toBe('warn');
  });

  it('★ NEAR-MISS: the same counts with confirmarReducaoEmMassa ⇒ the normal plan; a clean later run RESOLVES the aviso', async () => {
    const m = mundo();
    queda(m);
    await rodar(m, { baixarPreco: true });
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.precoReducaoEmMassa)?.resolvidoEm).toBeNull();
    m.relogio += MIN_MS;
    const segunda = await rodar(m, { baixarPreco: true, confirmarReducaoEmMassa: true });
    expect(segunda.ultima?.decide?.decisao).toBe('tarefas');
    expect(m.tarefas.map((x) => x.tarefa)).toEqual([
      expect.objectContaining({
        sku: 'SKU-QUEDA-1',
        baixarPreco: true,
        referencia: 'exec-preco-2',
      }),
    ]);
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.precoReducaoEmMassa)?.resolvidoEm).not.toBeNull();
    expect(segunda.ultima?.avisos).toContain('preco-reducao-em-massa:resolver');
  });

  it('NEAR-MISS: without consent the same drop is no decrease sent at all — the stop never fires, nothing to send', async () => {
    const m = mundo();
    queda(m);
    const { ultima } = await rodar(m, { baixarPreco: false });
    expect(ultima?.decide?.decisao).toBe('nada');
    expect(m.run()?.contagens).toMatchObject({ reducaoSemConsentimento: 1, enviaveis: 0 });
  });
});

describe('★ crash order', () => {
  it('★ a crash after the plan write and before the enqueues ⇒ the re-run enqueues EXACTLY the planned names', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, [['SKU-X-1', 'SKU-X-2'], ['SKU-X-3']]);
    m.falhaPreco = grpc(14, 'UNAVAILABLE');
    await expect(m.pagina(t)).rejects.toThrow();
    // The plan landed before the enqueue that failed; the run still decides
    // (the batch's siblings already in flight may have landed).
    expect(m.run()).toMatchObject({ fase: 'decidindo', decisao: 'tarefas' });
    const antes = m.tarefas.length;
    expect(antes).toBeLessThan(3);
    const r = await m.pagina(t);
    expect(r.decide).toMatchObject({
      planoGuardado: true,
      tarefas: 3 - antes,
      jaEnfileiradas: antes,
    });
    expect(m.run()?.fase).toBe('concluida');
    expect(m.tarefas.map((x) => x.nome).sort()).toEqual(
      ['SKU-X-1', 'SKU-X-2', 'SKU-X-3']
        .map((s) =>
          nomeDaTarefaPrecoAmazon(
            tarefaPrecoSkuAmazonSchema.parse({
              v: 1,
              tipo: 'preco-sku',
              contaId: CONTA,
              sku: s,
              origem: 'execucao',
              referencia: EXEC_SEMEADA,
              parte: s === 'SKU-X-3' ? 1 : 0,
              baixarPreco: false,
              solicitadoEmMs: 0,
              codigosAntes: [],
            }),
          ),
        )
        .sort(),
    );
  });

  it('★ the plan is STORED before the first enqueue (every task saw it on the run)', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, [['SKU-Y-1', 'SKU-Y-2']]);
    await m.pagina(t);
    expect(m.tarefas.map((x) => x.decisaoGuardada)).toEqual(['tarefas', 'tarefas']);
  });

  it('★ parts are written BEFORE the run update (the page’s write order)', async () => {
    const m = mundo();
    varios(m, 2, 'SKU-ORDEM');
    await rodar(m);
    const caminhos = m.fake.escritas.map((x) => `${x.verbo}:${x.caminho}`);
    const parte = caminhos.indexOf(`set:${parteDe('exec-preco-1', 0)}`);
    const atualizacao = caminhos.findIndex(
      (c, i) =>
        i > 0 && c === `update:${RUN}` && caminhos.slice(0, i).some((x) => x === `create:${RUN}`),
    );
    expect(parte).toBeGreaterThan(-1);
    expect(atualizacao).toBeGreaterThan(parte);
  });

  it('a crash between the part and the run update re-runs the page: the SAME part id rewritten, counted once', async () => {
    const m = mundo();
    varios(m, 2, 'SKU-REPETE');
    await m.iniciar();
    m.fake.falharEscrita(RUN, grpc(14, 'UNAVAILABLE'));
    await expect(m.drenar(1)).rejects.toThrow();
    m.fake.falharEscrita(RUN, null);
    expect(m.fake.ler(parteDe('exec-preco-1', 0))?.itens).toHaveLength(2);
    m.despachadas.clear();
    await m.drenar();
    expect(m.fake.escritasEm(parteDe('exec-preco-1', 0))).toHaveLength(2);
    expect(m.run()).toMatchObject({ proximaParte: 1, itensPorParte: [2], fase: 'concluida' });
    expect(m.run()?.contagens.enviaveis).toBe(2);
  });
});

describe('★ the decrease guard at page time', () => {
  it('★ baixarPreco: false counts the decrease and EXCLUDES it; true INCLUDES it (part written, desce counted)', async () => {
    const sem = mundo();
    sku(sem, 'SKU-DESCE-1', { normal: 45 });
    await rodar(sem, { baixarPreco: false });
    expect(sem.run()?.contagens).toMatchObject({
      reducaoSemConsentimento: 1,
      enviaveis: 0,
      desce: 0,
    });
    expect(sem.fake.ler(parteDe('exec-preco-1', 0))).toBeUndefined();

    const com = mundo();
    sku(com, 'SKU-DESCE-1', { normal: 45 });
    await rodar(com, { baixarPreco: true });
    expect(com.run()?.contagens).toMatchObject({
      reducaoSemConsentimento: 0,
      enviaveis: 1,
      desce: 1,
    });
    expect(com.fake.ler(parteDe('exec-preco-1', 0))?.itens).toEqual([
      expect.objectContaining({ sku: 'SKU-DESCE-1', faixa: { base: 45, minimo: 45, maximo: 45 } }),
    ]);
    expect(com.run()?.amostraReducoes).toEqual(['SKU-DESCE-1:50>45']);
  });
});

describe('★ the conta avisos', () => {
  it('★ zero inverted faixas RESOLVES preco-faixa-invertida, clocked by relogioInicio (NEAR-MISS: one inverted faixa raises it)', async () => {
    const m = mundo();
    sku(m, 'SKU-INVERTIDA-1', { normal: 50, promo: 55 });
    await rodar(m);
    expect(m.run()?.contagens.faixaInvertida).toBe(1);
    const levantado = avisoDe(m, MOTIVO_CONTA_AMAZON.precoFaixaInvertida);
    expect(levantado?.resolvidoEm).toBeNull();
    expect(levantado?.relogioEvento).toBe(
      relogioDoDocumentoUs(m.run()?.relogioInicio as { seconds: number; nanoseconds: number }),
    );
    // The operator fixes the promo; the next run resolves, clocked by ITS first read.
    m.fake.seed('produtos/p-SKU-INVERTIDA-1', {
      nome: 'Produto',
      precos: { [NORMAL]: { valor: 50 }, [PROMO]: { valor: 45 } },
    });
    m.relogio += MIN_MS;
    await rodar(m);
    const resolvido = avisoDe(m, MOTIVO_CONTA_AMAZON.precoFaixaInvertida);
    expect(resolvido?.resolvidoEm).not.toBeNull();
    expect(resolvido?.relogioEvento).toBe(
      relogioDoDocumentoUs(m.run()?.relogioInicio as { seconds: number; nanoseconds: number }),
    );
  });

  it('a blocking price issue on a listing raises preco-recusado-pela-amazon; a clean run resolves it', async () => {
    const m = mundo();
    sku(m, 'SKU-ISSUE-1', {
      issues: [
        {
          code: '19037',
          message: 'texto da Amazon',
          severity: 'ERROR',
          attributeNames: ['purchasable_offer'],
          categories: ['INVALID_PRICE'],
        },
      ],
    });
    await rodar(m);
    expect(m.run()?.contagens.problemasDePreco).toBe(1);
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon)?.resolvidoEm).toBeNull();
    m.amazon.set('SKU-ISSUE-1', listing('SKU-ISSUE-1', { base: 50, minimo: 50, maximo: 50 }));
    m.relogio += MIN_MS;
    await rodar(m);
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon)?.resolvidoEm).not.toBeNull();
  });

  it('NEAR-MISS: a TRUNCATED run raises and resolves nothing', async () => {
    const m = mundo();
    sku(m, 'SKU-INVERTIDA-2', { normal: 50, promo: 55 });
    await m.iniciar();
    m.fake.seed(RUN, {
      ...m.fake.ler(RUN),
      proximaParte: MAX_PARTES_EXECUCAO_PRECO_AMAZON,
      itensPorParte: Array.from({ length: MAX_PARTES_EXECUCAO_PRECO_AMAZON }, () => 1),
    });
    sku(m, 'SKU-TRUNCA-ENVIA');
    await m.drenar();
    expect(m.run()?.fase).toBe('truncada');
    for (const motivo of [
      MOTIVO_CONTA_AMAZON.precoFaixaInvertida,
      MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon,
      MOTIVO_CONTA_AMAZON.precoReducaoEmMassa,
    ]) {
      expect(avisoDe(m, motivo), motivo).toBeUndefined();
    }
  });
});

describe('★ budget and 429', () => {
  it('★ a page past its 400-s budget ⇒ truncada (prazo), nothing more read', async () => {
    expect(ORCAMENTO_PAGINA_PRECO_MS).toBe(400_000);
    const m = mundo();
    varios(m, 25, 'SKU-PRAZO');
    await m.iniciar();
    m.taxa = '4';
    // The first search answers 400 s into the page: the second search never starts.
    m.antesDaBusca = () => {
      m.relogio += ORCAMENTO_PAGINA_PRECO_MS;
    };
    const [r] = await m.drenar();
    expect(r).toMatchObject({ acao: 'truncada', motivo: 'prazo', limiteTaxa: 4 });
    expect(m.chamadas.filter((c) => c.tipo === 'busca')).toHaveLength(1);
    // The close stamps the run's progress: the status shows when it stopped.
    expect(m.run()).toMatchObject({ fase: 'truncada', motivo: 'prazo', progressoEmMs: m.relogio });
    expect(m.linhasPagina().at(-1)?.nivel).toBe('warn');
    expect(m.fake.escritas.filter((x) => x.caminho.includes('divergenciasPrecoAmazon'))).toEqual(
      [],
    );
  });

  it('NEAR-MISS: one ms inside the budget, the second search goes and the page completes', async () => {
    const m = mundo();
    varios(m, 25, 'SKU-PRAZO-OK');
    await m.iniciar();
    m.antesDaBusca = () => {
      m.relogio += ORCAMENTO_PAGINA_PRECO_MS - 300;
    };
    const [r] = await m.drenar();
    expect(r?.acao).toBe('concluida');
    expect(m.chamadas.filter((c) => c.tipo === 'busca')).toHaveLength(2);
  });

  it('★ a 429 stamps progressoEmMs FIRST, then re-enqueues the SAME page UNNAMED, 60 s later (no attempt spent)', async () => {
    const m = mundo();
    sku(m, 'SKU-LIMITADA-1');
    await m.iniciar();
    m.relogio = AGORA_MS + 3 * MIN_MS;
    m.limitarProximaBusca = true;
    const [r] = await m.drenar(1);
    expect(r?.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.limitada);
    expect(m.run()).toMatchObject({
      fase: 'paginando',
      proximaPagina: 0,
      progressoEmMs: m.relogio,
    });
    expect(m.paginas.at(-1)).toMatchObject({
      tarefa: { pagina: 0, execucaoId: 'exec-preco-1' },
      nome: null,
      atrasoS: ATRASO_PAUSA_PAGINA_PRECO_S,
    });
    expect(m.fake.escritas.filter((x) => x.caminho.includes('divergenciasPrecoAmazon'))).toEqual(
      [],
    );
    // The paused copy walks the page.
    const [depois] = await m.drenar();
    expect(depois?.acao).toBe('concluida');
  });

  it('NEAR-MISS: any other Amazon failure (a 5xx) is THROWN for the queue’s retry: no progress stamp, no pause, no part', async () => {
    const m = mundo();
    sku(m, 'SKU-FALHA-1');
    await m.iniciar();
    const antes = m.run()?.progressoEmMs;
    m.fetch = ((original) =>
      ((input, init) => {
        if (String(input).includes('/listings/') && !String(input).includes('/auth/')) {
          return Promise.resolve(respostaJson(503, { errors: [{ code: 'ServiceUnavailable' }] }));
        }
        return original(input, init);
      }) as typeof globalThis.fetch)(m.fetch);
    await expect(m.drenar(1)).rejects.toThrow();
    expect(m.run()?.progressoEmMs).toBe(antes);
    expect(m.paginas).toHaveLength(1);
    expect(m.fake.escritas.filter((x) => x.caminho.includes('divergenciasPrecoAmazon'))).toEqual(
      [],
    );
  });

  it('a 429 on a page that lost the run writes nothing and enqueues nothing', async () => {
    const m = mundo();
    sku(m, 'SKU-LIMITADA-2');
    await m.iniciar();
    m.limitarProximaBusca = true;
    m.antesDaBusca = () => {
      m.fake.seed(RUN, { ...m.fake.ler(RUN), fase: 'cancelada' });
    };
    const [r] = await m.drenar(1);
    expect(r?.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.vezPerdida);
    expect(m.paginas).toHaveLength(1);
    expect(m.run()?.fase).toBe('cancelada');
  });
});

describe('★ cost: one page’s operation count', () => {
  it('★ the projected walk, one link query per SKU, masked by-id reads, ONE part write, the run update — and Decide’s plan, end and three avisos', async () => {
    const m = mundo();
    varios(m, 3, 'SKU-CUSTO');
    await m.iniciar();
    const antes = m.fake.contagem;
    const leiturasAntes = m.fake.leiturasDetalhadas.length;
    const consultasAntes = m.fake.consultas.length;
    m.ambiente.AMAZON_MODO_PRECO = 'dry-run';
    await m.drenar();
    const depois = m.fake.contagem;
    const consultas = m.fake.consultas.slice(consultasAntes);
    const lidas = m.fake.leiturasDetalhadas.slice(leiturasAntes);
    const escritas = m.fake.escritas.slice(antes.escritas).map((x) => `${x.verbo}:${x.caminho}`);
    // Queries: the walk's two (one == per ref form, projected to the SKU), one
    // link query per distinct SKU (the reader reuses the dedupe's), one
    // children seek per unit.
    expect(depois.consultas - antes.consultas).toBe(8);
    const walk = consultas.filter(
      (q) => q.colecao === 'prodAmazon' && q.ordens.some(([c]) => c === '__name__'),
    );
    expect(walk).toHaveLength(2);
    for (const q of walk) expect(q.selecao).toEqual(['sku']);
    expect(consultas.filter((q) => q.colecao === 'prodAmazon')).toHaveLength(5);
    expect(consultas.filter((q) => q.colecao === 'produtos')).toHaveLength(3);
    // By-id: the run, the conta's two refs, the link donos and the units — FOUR
    // getAll calls, every one masked.
    expect(depois.chamadasGetAll - antes.chamadasGetAll).toBe(4);
    const porGetAll = lidas.filter((l) => l.via === 'getAll');
    expect(porGetAll).toHaveLength(8);
    for (const l of porGetAll) expect(l.mascara, l.caminho).not.toBeNull();
    expect(porGetAll.filter((l) => l.caminho === RUN)).toHaveLength(1);
    expect(porGetAll.filter((l) => l.caminho === caminhoConta(CONTA))).toHaveLength(1);
    // Writes: ONE part, the page's run update, Decide's plan and its end, the three avisos.
    expect(escritas).toEqual([
      `set:${parteDe('exec-preco-1', 0)}`,
      `update:${RUN}`,
      expect.stringMatching(/^create:avisos\/.*preco-faixa-invertida$/),
      expect.stringMatching(/^create:avisos\/.*preco-recusado-pela-amazon$/),
      `update:${RUN}`,
      expect.stringMatching(/^create:avisos\/.*preco-reducao-em-massa$/),
      `update:${RUN}`,
    ]);
  });
});

describe('the page line', () => {
  it('★ ONE line per dispatch: counts by motivo, sobe/desce, the page’s sample, timing, and the LOWEST rate of its searches and GETs', async () => {
    const m = mundo();
    sku(m, 'SKU-L-SOBE');
    sku(m, 'SKU-L-DESCE', { normal: 45 });
    sku(m, 'SKU-L-IGUAL', { amazon: { base: 60, minimo: 60, maximo: 60 } });
    sku(m, 'SKU-L-AUSENTE', { amazon: null });
    m.taxa = '5';
    await rodar(m, { baixarPreco: true });
    const linhas = m.linhasPagina();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.meta).toMatchObject({
      evento: 'preco',
      fluxo: 'preco',
      conta: CONTA,
      acao: 'concluida',
      execucaoId: 'exec-preco-1',
      pagina: 0,
      vinculos: 4,
      avaliados: 4,
      lidosNaAmazon: 4,
      iguais: 1,
      enviaveis: 2,
      sobe: 1,
      desce: 1,
      recusas: 'nao-listado:1,semAsinNoVinculo:4',
      amostra: 'SKU-L-DESCE:50>45',
      buscas: 1,
      gets: 1,
      limiteTaxa: 5,
      decisao: 'tarefas',
      tarefas: 2,
    });
    expect(typeof linhas[0]?.meta?.duracaoMs).toBe('number');
    // Never an issue text or a price list: closed codes, counts, ids and the sample only.
    expect(JSON.stringify(linhas)).not.toContain('texto da Amazon');
  });

  it('NEAR-MISS: no answer carried the rate ⇒ limiteTaxa null, never 0', async () => {
    const m = mundo();
    sku(m, 'SKU-SEM-TAXA');
    await rodar(m);
    expect(m.linhasPagina()[0]?.meta?.limiteTaxa).toBeNull();
    expect(m.run()?.contagens.limiteTaxa).toBeNull();
  });

  it('the run keeps the LOWEST rate any page saw', async () => {
    const m = mundo();
    for (let i = 0; i < 300; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    sku(m, 'SKU-TAXA-1');
    m.taxa = '3';
    await m.iniciar();
    await m.drenar();
    expect(m.run()?.contagens.limiteTaxa).toBe(3);
  });

  it('a context the read switch refuses ⇒ contexto-recusado, nothing of the run read', async () => {
    const m = mundo();
    sku(m, 'SKU-DESLIGADA');
    await m.iniciar();
    m.ambiente.AMAZON_CHAMADAS = 'off';
    const leituras = m.fake.leituras.length;
    const [r] = await m.drenar();
    expect(r).toMatchObject({ acao: 'contexto-recusado', motivo: 'chamadas-desligadas' });
    expect(m.fake.leituras.slice(leituras)).not.toContain(RUN);
    expect(severidadePaginaPrecoAmazon(r as ResultadoPaginaPrecoAmazon)).toBe('WARNING');
  });

  it('★ the line is a WARNING for a throttled, lost, truncated, failed or refused page (NEAR-MISS: a walked, stopped, healed or valve-closed page is INFO)', () => {
    const base: ResultadoPaginaPrecoAmazon = {
      acao: ACAO_PAGINA_PRECO_AMAZON.paginaConcluida,
      motivo: null,
      pagina: null,
      parte: null,
      decide: null,
      avisos: null,
      amostraExecucao: null,
      limiteTaxa: null,
      previa: false,
      veredito: null,
      duracaoMs: 0,
    };
    for (const acao of [
      ACAO_PAGINA_PRECO_AMAZON.limitada,
      ACAO_PAGINA_PRECO_AMAZON.vezPerdida,
      ACAO_PAGINA_PRECO_AMAZON.truncada,
      ACAO_PAGINA_PRECO_AMAZON.falhou,
      ACAO_PAGINA_PRECO_AMAZON.contextoRecusado,
    ]) {
      expect(severidadePaginaPrecoAmazon({ ...base, acao }), acao).toBe('WARNING');
    }
    for (const acao of [
      ACAO_PAGINA_PRECO_AMAZON.paginaConcluida,
      ACAO_PAGINA_PRECO_AMAZON.concluida,
      ACAO_PAGINA_PRECO_AMAZON.naoEDono,
      ACAO_PAGINA_PRECO_AMAZON.adiantada,
      ACAO_PAGINA_PRECO_AMAZON.valvulaDesligada,
    ]) {
      expect(severidadePaginaPrecoAmazon({ ...base, acao }), acao).toBe('INFO');
    }
  });

  it('★ a SKU linked twice across two pages: the run counts LINK DOCS read and the SKU’s second page as ja-visto, never as a refusal key', async () => {
    const m = mundo();
    // One SKU under two produtos: `a-dup` sorts before every fantasma (page 0),
    // `z-dup` after them (page 1, beside the last fantasma).
    for (let i = 0; i < 299; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    for (const produtoId of ['a-dup', 'z-dup']) {
      m.fake.seed(`produtos/${produtoId}`, { nome: `Produto ${produtoId}` });
      m.fake.seed(`produtos/${produtoId}/prodAmazon/l1`, {
        contaAmazonOuterRef: REF_CONTA,
        sku: 'SKU-DUPLO-1',
        productDataJson: { pesado: 'x'.repeat(32) },
      });
    }
    fantasma(m, 'f0299', 'SKU-F-299');
    await m.iniciar();
    await m.drenar();
    const contagens = m.run()?.contagens;
    // 302 link docs, 301 SKUs: the run's `lidos` is the docs.
    expect(contagens?.lidos).toBe(302);
    expect(contagens?.jaVisto).toBe(1);
    expect(Object.keys(contagens?.porChave ?? {})).not.toContain('ja-visto');
    const [, segunda] = m.linhasPagina();
    expect(segunda?.meta).toMatchObject({ pagina: 1, vinculos: 2, avaliados: 1, jaVistos: 1 });
  });
});

describe('★ the unit’s price sources', () => {
  /** A variation child priced 60 under a parent priced 70, Amazon at 50. */
  function variacao(m: Mundo, propaga: boolean | undefined): void {
    m.fake.seed('produtos/p-pai-variacao', {
      nome: 'Pai da variação',
      precos: { [NORMAL]: { valor: 70 } },
      ...(propaga === undefined ? {} : { propagatePriceToChildren: propaga }),
    });
    m.fake.seed('produtos/p-filho-variacao', {
      nome: 'Filho da variação',
      paiId: 'p-pai-variacao',
      precos: { [NORMAL]: { valor: 60 } },
    });
    m.fake.seed('produtos/p-filho-variacao/prodAmazon/l1', {
      contaAmazonOuterRef: REF_CONTA,
      sku: 'SKU-FILHO-1',
      productDataJson: { pesado: 'x'.repeat(32) },
    });
    m.amazon.set('SKU-FILHO-1', listing('SKU-FILHO-1', { base: 50, minimo: 50, maximo: 50 }));
  }

  it('★ a variation child is priced from its PARENT’s map under propagation: the part keeps the parent’s faixa (NEAR-MISS: propagatePriceToChildren false ⇒ the child’s own)', async () => {
    const propagado = mundo();
    variacao(propagado, undefined);
    await rodar(propagado);
    expect(propagado.fake.ler(parteDe('exec-preco-1', 0))?.itens).toEqual([
      expect.objectContaining({ sku: 'SKU-FILHO-1', faixa: { base: 70, minimo: 70, maximo: 70 } }),
    ]);

    const proprio = mundo();
    variacao(proprio, false);
    await rodar(proprio);
    expect(proprio.fake.ler(parteDe('exec-preco-1', 0))?.itens).toEqual([
      expect.objectContaining({ sku: 'SKU-FILHO-1', faixa: { base: 60, minimo: 60, maximo: 60 } }),
    ]);
  });
});

describe('★ the read instant', () => {
  /**
   * Our own accepted patch of 60, `idadeMs` old when the page's live read
   * STARTS; Amazon still answers 50 (2 s to answer), and the ERP asks 55.
   */
  async function comPatchRecente(idadeMs: number) {
    const m = mundo();
    sku(m, 'SKU-RECENTE-1', { normal: 55 });
    const link = 'produtos/p-SKU-RECENTE-1/prodAmazon/l1';
    m.fake.seed(link, {
      ...m.fake.ler(link),
      envioPrecoAmazon: {
        via: 'patch',
        emMs: AGORA_MS - idadeMs,
        oferta: { base: 60, minimo: 60, maximo: 60 },
        resultado: 'aceito',
        submissionId: 'sub-recente-1',
      },
    });
    await m.iniciar();
    m.antesDaBusca = () => {
      m.relogio += 2_000;
    };
    await m.drenar();
    return m;
  }

  it('★ a page judges at the instant its live read STARTED: our patch 15 min − 1 s old then still raises the reference, so the 55 is a decrease refused without consent (NEAR-MISS: 15 min + 1 s old ⇒ an increase over the live 50, sent)', async () => {
    const recente = await comPatchRecente(15 * MIN_MS - 1_000);
    expect(recente.run()?.contagens).toMatchObject({ reducaoSemConsentimento: 1, enviaveis: 0 });
    expect(recente.tarefas).toEqual([]);

    const antiga = await comPatchRecente(15 * MIN_MS + 1_000);
    expect(antiga.run()?.contagens).toMatchObject({
      reducaoSemConsentimento: 0,
      enviaveis: 1,
      sobe: 1,
    });
    expect(antiga.fake.ler(parteDe('exec-preco-1', 0))?.itens).toEqual([
      expect.objectContaining({ sku: 'SKU-RECENTE-1', lidoEmMs: AGORA_MS }),
    ]);
  });
});

describe('the run’s one write, re-derived', () => {
  it('a cancel landing between step 0 and the page’s run update ⇒ vez-perdida: the cancel stands, nothing advanced', async () => {
    const m = mundo();
    sku(m, 'SKU-CANCELA-1');
    await m.iniciar();
    m.fake.antesDaProximaEscrita(RUN, () => {
      m.fake.seed(RUN, { ...m.fake.ler(RUN), fase: 'cancelada' });
    });
    const [r] = await m.drenar();
    expect(r?.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.vezPerdida);
    expect(m.run()).toMatchObject({ fase: 'cancelada', proximaPagina: 0 });
    expect(m.tarefas).toEqual([]);
    expect(m.paginas).toHaveLength(1);
  });

  it('a cancel landing during Decide ⇒ no concluida written over it', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, [['SKU-Z-1']]);
    // The plan write is the first; the cancel lands before the end's.
    m.fake.antesDaProximaEscrita(RUN, () => {
      m.fake.antesDaProximaEscrita(RUN, () => {
        m.fake.seed(RUN, { ...m.fake.ler(RUN), fase: 'cancelada' });
      });
    });
    const r = await m.pagina(t);
    expect(r.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.vezPerdida);
    expect(m.run()?.fase).toBe('cancelada');
  });

  it('★ ANOTHER run claimed between step 0 and the page’s run update, at the same phase and page ⇒ vez-perdida: nothing of the old page lands on the new run', async () => {
    const m = mundo();
    sku(m, 'SKU-OUTRA-1');
    await m.iniciar();
    const cursores = m.run()?.cursores;
    // A cancel and an immediate new claim: walking, page 0, part 0 — another id.
    m.fake.antesDaProximaEscrita(RUN, () => {
      m.fake.seed(RUN, { ...m.fake.ler(RUN), execucaoId: 'exec-preco-outra' });
    });
    const [r] = await m.drenar(1);
    expect(r?.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.vezPerdida);
    expect(m.run()).toMatchObject({
      execucaoId: 'exec-preco-outra',
      fase: 'paginando',
      proximaPagina: 0,
      proximaParte: 0,
      itensPorParte: [],
      relogioInicio: null,
    });
    expect(m.run()?.cursores).toEqual(cursores);
    expect(m.run()?.contagens.enviaveis).toBe(0);
    expect(m.paginas).toHaveLength(1);
    expect(m.tarefas).toEqual([]);
  });

  it('★ ANOTHER run deciding by the time Decide writes its plan ⇒ vez-perdida: no plan written onto it, no task enqueued', async () => {
    const m = mundo();
    const t = await semearDecidindo(m, [['SKU-OUTRA-2']]);
    m.fake.antesDaProximaEscrita(RUN, () => {
      m.fake.seed(RUN, { ...m.fake.ler(RUN), execucaoId: 'exec-preco-outra' });
    });
    const r = await m.pagina(t);
    expect(r.acao).toBe(ACAO_PAGINA_PRECO_AMAZON.vezPerdida);
    expect(m.run()).toMatchObject({
      execucaoId: 'exec-preco-outra',
      fase: 'decidindo',
      decisao: null,
    });
    expect(m.tarefas).toEqual([]);
  });

  it('a page ADVANCED by another dispatch between step 0 and the update ⇒ vez-perdida, nothing counted twice (NEAR-MISS: a moved part index too)', async () => {
    for (const campo of ['proximaPagina', 'proximaParte'] as const) {
      const m = mundo();
      sku(m, 'SKU-AVANCO-1');
      await m.iniciar();
      m.fake.antesDaProximaEscrita(RUN, () => {
        m.fake.seed(RUN, {
          ...m.fake.ler(RUN),
          [campo]: 1,
          ...(campo === 'proximaParte' ? { itensPorParte: [1] } : {}),
        });
      });
      const [r] = await m.drenar(1);
      expect(r?.acao, campo).toBe(ACAO_PAGINA_PRECO_AMAZON.vezPerdida);
      expect(m.run()?.contagens.enviaveis, campo).toBe(0);
      expect(m.tarefas, campo).toEqual([]);
      expect(m.paginas, campo).toHaveLength(1);
    }
  });

  it('a concurrent write that keeps the page the run’s next is re-derived: the update lands on the fresh read', async () => {
    const m = mundo();
    sku(m, 'SKU-RECONTA-1');
    await m.iniciar();
    m.fake.antesDaProximaEscrita(RUN, () => {
      m.fake.seed(RUN, { ...m.fake.ler(RUN), progressoEmMs: AGORA_MS + 1 });
    });
    await m.drenar();
    expect(m.run()).toMatchObject({ fase: 'concluida', proximaPagina: 1 });
    expect(m.run()?.contagens.enviaveis).toBe(1);
  });

  it('the page reads the run MASKED to exactly what it decides from', async () => {
    const m = mundo();
    sku(m, 'SKU-MASCARA-1');
    await m.iniciar();
    await m.drenar();
    const doRun = m.fake.leiturasDetalhadas.filter((l) => l.caminho === RUN);
    expect(doRun.length).toBeGreaterThan(0);
    for (const l of doRun.filter(
      (x) => (x.mascara?.length ?? 0) === CAMPOS_PAGINA_EXECUCAO_PRECO_AMAZON.length,
    )) {
      expect([...(l.mascara ?? [])].sort()).toEqual(
        [...CAMPOS_PAGINA_EXECUCAO_PRECO_AMAZON].sort(),
      );
    }
    expect(
      doRun.some((l) => (l.mascara?.length ?? 0) === CAMPOS_PAGINA_EXECUCAO_PRECO_AMAZON.length),
    ).toBe(true);
  });
});

describe('the step order of a refused SKU', () => {
  it('a refused link verdict is never read on Amazon (ZERO calls for a page of refusals)', async () => {
    const m = mundo();
    for (let i = 0; i < 5; i += 1) fantasma(m, `g${String(i)}`, `SKU-G-${String(i)}`);
    await rodar(m);
    expect(m.chamadas).toEqual([]);
    expect(m.run()?.contagens.porChave).toMatchObject({ 'produto-ausente': 5 });
  });

  it('a SKU with no normal price and one Amazon does not list are counted, never sent', async () => {
    const m = mundo();
    sku(m, 'SKU-SEM-PRECO', { normal: null });
    sku(m, 'SKU-NAO-LISTADO', { amazon: null });
    await rodar(m);
    expect(m.run()?.contagens).toMatchObject({ semPreco: 1, enviaveis: 0 });
    expect(m.run()?.contagens.porChave).toMatchObject({ 'nao-listado': 1 });
    expect(m.tarefas).toEqual([]);
  });
});
