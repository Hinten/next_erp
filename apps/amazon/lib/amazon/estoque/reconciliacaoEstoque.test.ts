/**
 * The daily stock RECONCILE (step 12, PR 12-f) against the counting fake
 * Firestore: Request, Start, the pages, Decide and Close, end to end through
 * the REAL context, the REAL evaluator (resolver pieces, verdict, family read,
 * quantity core, listings wrapper, listing gate), the REAL drift-block I/O, the
 * REAL jobs and stock producers over recording queues, and the REAL avisos seam.
 * Amazon is a scripted `fetch` (a catalogue: a search answers the listed SKUs it
 * was asked for, a GET answers the listing or its own 404) that REFUSES anything
 * unscripted; the evaluator's pacing runs on the world's fake clock.
 *
 * Pages are dispatched by draining the recorded jobs queue in order, one page at
 * a time, exactly as the jobs queue's concurrency 1 would.
 *
 * ⚠️ D11: the global `fetch` refuses; the read switch is `on` only in the object
 * literal handed to the page. After EVERY test: no network call left the
 * scripted `fetch` and no LWA exchange ran. PLACEHOLDERS ONLY (public repository).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  AmazonHttpError,
  AmazonThrottleError,
  CAMINHO_LISTINGS,
  MARKETPLACE_ID_BR,
} from '@delfrance/integrations-amazon-sp-api';
import {
  FASE_RECONCILIACAO_ESTOQUE_AMAZON,
  INTEGRACAO_TIPO,
  LIMIAR_FEED_ESTOQUE_AMAZON,
  LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON,
  MOTIVO_CONTA_AMAZON,
  type ReconciliacaoEstoqueAmazon,
  idDivergenciaEstoqueAmazon,
  makeEstoqueUid,
} from '@delfrance/schemas';

import {
  ACAO_AVISO_CONTA_ESTOQUE_AMAZON,
  chaveContaPrecisaAtencao,
  relogioDoDocumentoUs,
  sincronizarAvisoContaEstoqueAmazon,
} from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { CANARIO_ENV_AMAZON, VALVULA_ENV_AMAZON } from '../core/valvulas';
import { type FilaLotesAmazon, criarAgendadorLotesAmazon } from '../feeds/agendadorLotes';
import { MAX_FALHAS_SEGUIDAS_FEED } from '../feeds/provedorLote';
import {
  MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON,
  type TarefaEnviarFeedAmazon,
  type TarefaLoteAmazon,
  type TarefaPaginaReconciliacaoAmazon,
  execucaoIdDoLoteBlocosFeed,
  nomeEnvioFeed,
  nomePaginaReconciliacao,
  nomeRetomadaReconciliacao,
  tarefaEnviarFeedAmazonSchema,
} from '../feeds/tarefaLote';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  DIA_MS,
  HORA_MS,
  SPID_A,
  caminhoAviso,
  caminhoConta,
  loggerEspiao,
  respostaJson,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import {
  gravarBlocoDivergenciaEstoqueAmazon,
  lerBlocosDivergenciaEstoqueAmazon,
} from './divergenciasFirestore';
import { type FilaEstoqueAmazon, criarProdutorEstoqueAmazon } from './produtorEstoque';
import {
  ACAO_PAGINA_RECONCILIACAO,
  ATRASO_ENVIO_RECONCILIACAO_S,
  CAMPOS_VARREDURA_VINCULOS_ESTOQUE_AMAZON,
  DECISAO_RECONCILIACAO,
  type DepsPaginaReconciliacaoEstoqueAmazon,
  ESPERA_LIMITE_PAGINA_S,
  ESPERA_LOTE_BLOCOS_MS,
  GUARDA_REEXECUCAO_AUTOMATICA_MS,
  MAX_AMOSTRA_DRY_RUN,
  ORCAMENTO_PAGINA_RECONCILIACAO_MS,
  ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON,
  PAGINA_VARREDURA_ESTOQUE_AMAZON,
  RECLAMACAO_RECONCILIACAO_MS,
  RETOMADA_RECONCILIACAO_MS,
  type ResultadoPaginaReconciliacaoEstoqueAmazon,
  decidirInicioReconciliacaoEstoqueAmazon,
  decidirRetomadaReconciliacaoEstoqueAmazon,
  guardaSistemicaEstoqueAmazon,
  iniciarReconciliacaoEstoqueAmazon,
  lotesDeBlocosEstoqueAmazon,
  processarPaginaReconciliacaoEstoqueAmazon,
  retomarReconciliacaoEstoqueAmazon,
  solicitarReconciliacaoEstoqueAmazon,
} from './reconciliacaoEstoque';
import type { TarefaEstoqueAmazon } from './tarefaEstoque';

const CONTA = 'conta-amz-reconciliacao';
const REF_CONTA = `documents/integracao/${CONTA}`;
const REF_CONTA_NUA = `integracao/${CONTA}`;
const DEP = 'dep-rec-1';
const REF_DEP = `documents/depositos/${DEP}`;
const DEP_NOVO = 'dep-rec-2';
const RUN = `reconciliacaoEstoqueAmazon/${CONTA}`;
const PEDIDO = `pedidoReconciliacaoEstoqueAmazon/${CONTA}`;
const VEZ = `feedsAmazonEmCurso/estoque-${CONTA}`;
const CAMINHO_BUSCA = `${CAMINHO_LISTINGS}/${SPID_A}`;
const MIN_MS = 60_000;

/* -------------------------------------------------------------------------- */
/*                                  the world                                 */
/* -------------------------------------------------------------------------- */

interface Enfileirada<T> {
  readonly tarefa: T;
  readonly nome: string | null;
  readonly atrasoS: number;
}

interface ChamadaAmazon {
  readonly tipo: 'busca' | 'get';
  readonly skus: readonly string[];
}

const mundos: { readonly lwa: readonly string[] }[] = [];
const rede: string[] = [];

function listing(sku: string, quantidade: number): Record<string, unknown> {
  return {
    sku,
    summaries: [{ marketplaceId: MARKETPLACE_ID_BR, productType: 'PRODUCT', status: ['BUYABLE'] }],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: quantidade }],
    relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
  };
}

function mundo() {
  const fake = new FakeDb();
  // A link doc carries a whole product payload: every read of one is masked.
  fake.exigirMascaraEm('prodAmazon');
  fake.seed(caminhoConta(CONTA), {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta reconciliação',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
    depositoOuterRef: REF_DEP,
  });
  // A token far from expiry: no LWA exchange.
  seedCredencial(fake, CONTA, { expirationDate: AGORA_MS + 365 * DIA_MS });
  const log = loggerEspiao();
  const idsLotes = new Set<string>();
  const idsEstoque = new Set<string>();
  let execucoes = 0;
  const m = {
    fake,
    log,
    relogio: AGORA_MS,
    amazon: new Map<string, Record<string, unknown>>(),
    chamadas: [] as ChamadaAmazon[],
    lwa: [] as string[],
    lotes: [] as Enfileirada<TarefaLoteAmazon>[],
    patches: [] as Enfileirada<TarefaEstoqueAmazon>[],
    /** Pages dispatched so far, by their index in `lotes`. */
    despachadas: new Set<number>(),
    /** A failure for the next jobs enqueue whose payload matches, consumed once each. */
    falhasLotes: [] as {
      readonly quando: (t: TarefaLoteAmazon) => boolean;
      readonly erro: Error;
    }[],
    /** A 429 for the next search, consumed once. */
    limitarProximaBusca: false,
    /** An HTTP status EVERY search answers while set (a non-429 Amazon failure). */
    statusDaBusca: null as number | null,
    ambiente: {
      ...AMBIENTE_LIGADO,
      [VALVULA_ENV_AMAZON.estoque]: 'on',
      [CANARIO_ENV_AMAZON.estoque]: '*',
    } as Record<string, string | undefined>,
    fetch: ((input, init) => {
      const url = new URL(String(input));
      const metodo = init?.method ?? 'GET';
      if (url.pathname === '/auth/o2/token') {
        m.lwa.push(metodo);
        return Promise.resolve(tokenDeAcesso());
      }
      if (metodo !== 'GET') {
        return Promise.reject(new TypeError(`sem rede: ${metodo} ${url.pathname}`));
      }
      if (url.pathname === CAMINHO_BUSCA) {
        const pedidos = (url.searchParams.get('identifiers') ?? '').split(',');
        m.chamadas.push({ tipo: 'busca', skus: pedidos });
        if (m.statusDaBusca !== null) {
          return Promise.resolve(
            respostaJson(m.statusDaBusca, { errors: [{ code: 'InternalFailure' }] }),
          );
        }
        if (m.limitarProximaBusca) {
          m.limitarProximaBusca = false;
          return Promise.resolve(respostaJson(429, { errors: [{ code: 'QuotaExceeded' }] }));
        }
        const items = pedidos.filter((s) => m.amazon.has(s)).map((s) => m.amazon.get(s));
        return Promise.resolve(respostaJson(200, { numberOfResults: items.length, items }));
      }
      if (url.pathname.startsWith(`${CAMINHO_BUSCA}/`)) {
        const sku = decodeURIComponent(url.pathname.slice(CAMINHO_BUSCA.length + 1));
        m.chamadas.push({ tipo: 'get', skus: [sku] });
        const corpo = m.amazon.get(sku);
        return Promise.resolve(
          corpo === undefined
            ? respostaJson(404, { errors: [{ code: 'NOT_FOUND' }] })
            : respostaJson(200, corpo),
        );
      }
      return Promise.reject(new TypeError(`sem rede: ${metodo} ${url.pathname} não roteirizado`));
    }) as typeof globalThis.fetch,
    deps(): DepsPaginaReconciliacaoEstoqueAmazon {
      return {
        ambiente: m.ambiente,
        agora: () => m.relogio,
        logger: log.logger,
        increment,
        agendador: () =>
          criarAgendadorLotesAmazon({
            desligado: false,
            fila: (): FilaLotesAmazon => ({
              enqueue: (tarefa, opcoes) => {
                const i = m.falhasLotes.findIndex((f) => f.quando(tarefa));
                if (i >= 0) {
                  const [falha] = m.falhasLotes.splice(i, 1);
                  return Promise.reject(falha?.erro);
                }
                const id = opcoes?.id;
                if (id !== undefined) {
                  if (idsLotes.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
                  idsLotes.add(id);
                }
                m.lotes.push({
                  tarefa,
                  nome: id ?? null,
                  atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
                });
                return Promise.resolve();
              },
            }),
          }),
        produtorEstoque: () =>
          criarProdutorEstoqueAmazon({
            desligado: false,
            fila: (): FilaEstoqueAmazon => ({
              enqueue: (tarefa, opcoes) => {
                const id = opcoes?.id;
                if (id !== undefined) {
                  if (idsEstoque.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
                  idsEstoque.add(id);
                }
                m.patches.push({
                  tarefa,
                  nome: id ?? null,
                  atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
                });
                return Promise.resolve();
              },
            }),
          }),
        gerarExecucaoId: () => {
          execucoes += 1;
          return `exec-rec-${String(execucoes)}`;
        },
        registro: { tentativa: 0, idTarefa: 'tarefa-rec-teste' },
        fetch: m.fetch,
        gerarCorrelationId: () => 'corr-rec-teste',
        esperar: (ms) => {
          m.relogio += ms;
          return Promise.resolve();
        },
      };
    },
    /** The run, as stored. */
    run: () => fake.ler(RUN) as (ReconciliacaoEstoqueAmazon & Record<string, unknown>) | undefined,
    iniciar: () => iniciarReconciliacaoEstoqueAmazon(asDb(fake), CONTA, m.deps()),
    solicitar: (
      origem: (typeof ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON)[keyof typeof ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON],
    ) => solicitarReconciliacaoEstoqueAmazon(asDb(fake), CONTA, origem, m.deps()),
    pagina: (t: TarefaPaginaReconciliacaoAmazon) =>
      processarPaginaReconciliacaoEstoqueAmazon(asDb(fake), t, m.deps()),
    /** The pages enqueued so far, with their index in `lotes`. */
    paginas: (): {
      readonly i: number;
      readonly t: TarefaPaginaReconciliacaoAmazon;
      readonly x: Enfileirada<TarefaLoteAmazon>;
    }[] =>
      m.lotes.flatMap((x, i) => (x.tarefa.tipo === 'reconciliacao' ? [{ i, t: x.tarefa, x }] : [])),
    /**
     * Dispatch the pages not yet dispatched, in order: at most `quantas` when
     * given, else until none is left (60 at most, then the test fails).
     */
    drenar: async (quantas?: number): Promise<ResultadoPaginaReconciliacaoEstoqueAmazon[]> => {
      const saidas: ResultadoPaginaReconciliacaoEstoqueAmazon[] = [];
      for (let n = 0; n < (quantas ?? 60); n += 1) {
        const proxima = m.paginas().find((p) => !m.despachadas.has(p.i));
        if (proxima === undefined) return saidas;
        m.despachadas.add(proxima.i);
        saidas.push(await m.pagina(proxima.t));
      }
      if (quantas !== undefined) return saidas;
      throw new Error('teste: a fila de páginas não esvaziou');
    },
    feeds: (): Enfileirada<TarefaEnviarFeedAmazon>[] =>
      m.lotes.flatMap((x) => (x.tarefa.tipo === 'feed-enviar' ? [{ ...x, tarefa: x.tarefa }] : [])),
    linhasPagina: () =>
      log.linhas.filter((l) => l.meta?.fase === 'reconciliacao' && l.meta.etapa === 'pagina'),
  };
  mundos.push(m);
  return m;
}

type Mundo = ReturnType<typeof mundo>;

/* ------------------------------- the seeds -------------------------------- */

interface OpcoesSku {
  readonly produtoId?: string;
  readonly linkId?: string;
  /** `null`: no estoque row at the depósito (an ERP 0 from no row). */
  readonly erp?: number | null;
  /** `null`: Amazon does not list it. */
  readonly amazon?: number | null;
  /** The link's conta ref form. */
  readonly refConta?: string;
  readonly link?: Record<string, unknown>;
}

/** A simple produto linked to `sku` (module header): ERP and Amazon both 5 unless told. */
function sku(m: Mundo, s: string, o: OpcoesSku = {}): string {
  const produtoId = o.produtoId ?? `p-${s}`;
  m.fake.seed(`produtos/${produtoId}`, { nome: `Produto ${s}`, precos: { varejo: 10 } });
  m.fake.seed(`produtos/${produtoId}/prodAmazon/${o.linkId ?? 'l1'}`, {
    contaAmazonOuterRef: o.refConta ?? REF_CONTA,
    sku: s,
    productDataJson: { pesado: 'x'.repeat(32) },
    ...o.link,
  });
  const erp = o.erp === undefined ? 5 : o.erp;
  if (erp !== null) {
    m.fake.seed(`produtos/${produtoId}/estoques/${makeEstoqueUid(produtoId, DEP)}`, {
      depositoOuterRef: REF_DEP,
      parentId: produtoId,
      quantidade: erp,
      quantidadeReservada: 0,
    });
  }
  const amazon = o.amazon === undefined ? 5 : o.amazon;
  if (amazon !== null) m.amazon.set(s, listing(s, amazon));
  return s;
}

/** A link doc under a produto that does not exist (refused, never read on Amazon). */
function fantasma(m: Mundo, produtoId: string, s: string, refConta = REF_CONTA): void {
  m.fake.seed(`produtos/${produtoId}/prodAmazon/l1`, {
    contaAmazonOuterRef: refConta,
    sku: s,
    productDataJson: { pesado: 'x'.repeat(32) },
  });
}

/** `n` simple SKUs `<prefixo>-0001`…, each ERP `erp` and Amazon `amazon`. */
function varios(m: Mundo, n: number, prefixo: string, o: OpcoesSku = {}): string[] {
  return Array.from({ length: n }, (_v, i) =>
    sku(m, `${prefixo}-${String(i + 1).padStart(4, '0')}`, o),
  );
}

/** Start, then every page. */
async function rodar(m: Mundo) {
  const inicio = await m.iniciar();
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
  for (const m of mundos) expect(m.lwa).toEqual([]);
  mundos.length = 0;
});

/* -------------------------------------------------------------------------- */
/*                                  the walk                                  */
/* -------------------------------------------------------------------------- */

describe('★ the walk: ONE == per ref form, projected, paged by key', () => {
  it('both forms are walked, each with its own ==, never in, with the projection; the counters equal the seed', async () => {
    const m = mundo();
    sku(m, 'SKU-CANONICA');
    sku(m, 'SKU-NUA', { refConta: REF_CONTA_NUA });
    const { ultima } = await rodar(m);
    expect(ultima?.acao).toBe(ACAO_PAGINA_RECONCILIACAO.concluida);
    const walk = m.fake.consultas.filter(
      (q) => q.colecao === 'prodAmazon' && q.ordens.some(([c]) => c === '__name__'),
    );
    expect(walk.map((q) => q.filtros)).toEqual([
      [['contaAmazonOuterRef', REF_CONTA]],
      [['contaAmazonOuterRef', REF_CONTA_NUA]],
    ]);
    for (const q of walk) {
      expect(q.grupo).toBe(true);
      expect(q.ordens).toEqual([['__name__', 'asc']]);
      expect(q.selecao).toEqual([...CAMPOS_VARREDURA_VINCULOS_ESTOQUE_AMAZON]);
      expect(q.limite).toBeLessThanOrEqual(PAGINA_VARREDURA_ESTOQUE_AMAZON);
    }
    // NEAR-MISS: no walk query is the `in` the resolver runs.
    expect(walk.some((q) => q.filtros.some(([c]) => c.endsWith(' in')))).toBe(false);
    expect(m.run()?.contagens).toMatchObject({
      vinculosLidos: 2,
      skusAvaliados: 2,
      enviaveis: 2,
      divergencias: 0,
    });
    expect(m.run()?.cursores).toEqual({
      canonica: { ultimoCaminho: 'produtos/p-SKU-CANONICA/prodAmazon/l1', concluida: true },
      nua: { ultimoCaminho: 'produtos/p-SKU-NUA/prodAmazon/l1', concluida: true },
    });
  });

  it('a page cursor resumes EXACTLY after the last doc: 650 links ⇒ 3 pages, every doc read once', async () => {
    const m = mundo();
    for (let i = 0; i < 650; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    await m.iniciar();
    // Page 0's step-0 read is the run's first: its readTime is the claim's commit here.
    const doClaim = m.fake.carimboDe(RUN);
    const paginas = await m.drenar();
    expect(
      (m.run()?.relogioInicio as { isEqual: (o: unknown) => boolean } | null)?.isEqual(doClaim),
    ).toBe(true);
    expect(paginas.map((p) => p.acao)).toEqual([
      ACAO_PAGINA_RECONCILIACAO.paginaConcluida,
      ACAO_PAGINA_RECONCILIACAO.paginaConcluida,
      ACAO_PAGINA_RECONCILIACAO.concluida,
    ]);
    const walk = m.fake.consultas.filter(
      (q) => q.colecao === 'prodAmazon' && q.ordens.some(([c]) => c === '__name__'),
    );
    expect(walk.map((q) => [q.filtros[0]?.[1], q.apos, q.limite])).toEqual([
      [REF_CONTA, null, 300],
      [REF_CONTA, 'produtos/f0299/prodAmazon/l1', 300],
      [REF_CONTA, 'produtos/f0599/prodAmazon/l1', 300],
      // The canonical form ended short (50 of 300): the bare one takes the rest.
      [REF_CONTA_NUA, null, 250],
    ]);
    expect(m.run()).toMatchObject({ paginas: 3, proximaPagina: 3, fase: 'concluida' });
    expect(m.run()?.contagens).toMatchObject({ vinculosLidos: 650, skusAvaliados: 650 });
  });

  it('a full page ending on a link no produto owns cannot store its cursor: the run is truncada', async () => {
    const m = mundo();
    for (let i = 0; i < 299; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    // `zz/…` sorts after every `produtos/…` key: the page's LAST doc.
    m.fake.seed('zz/z1/prodAmazon/l1', { contaAmazonOuterRef: REF_CONTA, sku: 'SKU-FORA' });
    const { paginas } = await rodar(m);
    expect(paginas.at(-1)).toMatchObject({ acao: 'truncada', motivo: 'cursor-ilegivel' });
    expect(m.run()?.fase).toBe('truncada');
  });
});

describe('★ the dedupe: a SKU is evaluated on the page of its SMALLEST link-doc path', () => {
  it('one SKU with link docs on pages 1 and 3 is evaluated ONCE, on page 1, and counted ja-visto on page 3', async () => {
    const m = mundo();
    for (let i = 0; i < 700; i += 1) {
      if (i === 5) continue;
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    }
    // The SKU's live dono sits on page 1; a second doc of it, under a gone produto, on page 3.
    sku(m, 'SKU-DUPLO', { produtoId: 'f0005' });
    fantasma(m, 'f0650', 'SKU-DUPLO');
    const { paginas } = await rodar(m);
    expect(paginas.map((p) => p.pagina?.jaVistos)).toEqual([0, 0, 1]);
    // Amazon read it once: one search held it.
    const comDuplo = m.chamadas.filter((ch) => ch.skus.includes('SKU-DUPLO'));
    expect(comDuplo).toHaveLength(1);
    expect(m.run()?.contagens).toMatchObject({
      vinculosLidos: 700,
      skusAvaliados: 699,
      enviaveis: 1,
      porChave: expect.objectContaining({ 'ja-visto': 1 }),
    });
  });

  it('NEAR-MISS: the smallest path decides, not the first page met — a SKU whose smaller doc is in the LATER form is evaluated there', async () => {
    const m = mundo();
    // Canonical form: `produtos/b/…`; bare form: `produtos/a/…`, a smaller key walked LATER.
    sku(m, 'SKU-FORMAS', { produtoId: 'b' });
    fantasma(m, 'a', 'SKU-FORMAS', REF_CONTA_NUA);
    const { paginas } = await rodar(m);
    // One page holds both forms (two docs < 300): the SKU evaluated once.
    expect(paginas).toHaveLength(1);
    expect(m.run()?.contagens).toMatchObject({ vinculosLidos: 2, skusAvaliados: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/*                                  the decide                                */
/* -------------------------------------------------------------------------- */

describe('★ Decide: the switch over the drift, every send delayed 20 minutes', () => {
  it('D = 0 ⇒ no task, no feed', async () => {
    const m = mundo();
    varios(m, 3, 'SKU-OK');
    const { ultima } = await rodar(m);
    expect(ultima).toMatchObject({
      acao: 'concluida',
      decisao: DECISAO_RECONCILIACAO.semDivergencia,
      feed: null,
      lotes: 0,
      lotesJaEnfileirados: 0,
    });
    expect(m.patches).toEqual([]);
    expect(m.feeds()).toEqual([]);
    // No feed, no batch: every page line says so (the closed set's `null`).
    expect(m.linhasPagina().length).toBeGreaterThan(0);
    for (const linha of m.linhasPagina()) {
      expect(linha.meta).toMatchObject({ feed: null, lotes: 0, lotesJaEnfileirados: 0 });
    }
  });

  it('D = 30 ⇒ 30 patch tasks, each NAMED by the run, the walk’s depósito id, delayed 1,200 s; no feed', async () => {
    const m = mundo();
    const skus = varios(m, LIMIAR_FEED_ESTOQUE_AMAZON, 'SKU-D', { erp: 7, amazon: 2 });
    const { paginas, ultima } = await rodar(m);
    expect(ultima).toMatchObject({
      decisao: DECISAO_RECONCILIACAO.patches,
      tarefas: 30,
      feed: null,
      lotes: 0,
      lotesJaEnfileirados: 0,
    });
    // A patch decide names no batch: its line says so.
    expect(m.linhasPagina()).toHaveLength(paginas.length);
    for (const linha of m.linhasPagina()) {
      expect(linha.meta).toMatchObject({ feed: null, lotes: 0, lotesJaEnfileirados: 0 });
    }
    expect(m.feeds()).toEqual([]);
    expect(m.patches).toHaveLength(30);
    expect(ATRASO_ENVIO_RECONCILIACAO_S).toBe(1_200);
    const exec = m.run()?.execucaoId;
    for (const p of m.patches) {
      expect(p.atrasoS).toBe(1_200);
      expect(p.nome).toMatch(/^[0-9a-f]{64}$/);
      expect(p.tarefa).toMatchObject({
        origem: 'reconciliacao',
        referencia: exec,
        depositoId: DEP,
        contaId: CONTA,
      });
    }
    expect(m.patches.map((p) => (p.tarefa as TarefaEstoqueAmazon).sku).sort()).toEqual(skus);
  });

  it('NEAR-MISS D = 31 under * ⇒ ONE feed-enviar carrying a BLOCK lote (the run, parteInicial 0, partes, esperaAteMs), its OWN execucaoId batch 0 of the run, named by it, delayed 1,200 s; ZERO patch tasks', async () => {
    const m = mundo();
    varios(m, LIMIAR_FEED_ESTOQUE_AMAZON + 1, 'SKU-D', { erp: 7, amazon: 2 });
    const { ultima } = await rodar(m);
    expect(ultima).toMatchObject({
      decisao: DECISAO_RECONCILIACAO.feed,
      feed: 'enfileirada',
      lotes: 1,
      lotesJaEnfileirados: 0,
    });
    expect(m.patches).toEqual([]);
    const [feed, ...outros] = m.feeds();
    expect(outros).toEqual([]);
    const run = m.run();
    const lote0 = execucaoIdDoLoteBlocosFeed(CONTA, run?.execucaoId ?? '', 0);
    expect(lote0).not.toBe(run?.execucaoId);
    expect(feed?.atrasoS).toBe(1_200);
    expect(feed?.nome).toBe(nomeEnvioFeed(CONTA, lote0));
    expect(feed?.tarefa).toEqual({
      v: 1,
      tipo: 'feed-enviar',
      fluxo: 'estoque',
      contaId: CONTA,
      execucaoId: lote0,
      origem: 'reconciliacao',
      lote: {
        tipo: 'blocos',
        execucaoIdRun: run?.execucaoId,
        parteInicial: 0,
        partes: 1,
        esperaAteMs: expect.any(Number) as number,
      },
    });
    // The decide's line carries the count next to the answer.
    expect(m.linhasPagina().at(-1)?.meta).toMatchObject({
      feed: 'enfileirada',
      lotes: 1,
      lotesJaEnfileirados: 0,
    });
    const espera = feed?.tarefa.lote.tipo === 'blocos' ? feed.tarefa.lote.esperaAteMs : 0;
    expect(espera - m.relogio).toBe(1_200_000 + ESPERA_LOTE_BLOCOS_MS);
    expect(ESPERA_LOTE_BLOCOS_MS).toBe(6 * HORA_MS);
  });

  it('D = 31 under a canary LIST ⇒ patch tasks for the canary hits ONLY, ALSO delayed 1,200 s; no feed', async () => {
    const m = mundo();
    const skus = varios(m, 31, 'SKU-D', { erp: 7, amazon: 2 });
    m.ambiente[CANARIO_ENV_AMAZON.estoque] = `${CONTA}:${skus[3] ?? ''},${CONTA}:${skus[17] ?? ''}`;
    const { ultima } = await rodar(m);
    expect(ultima).toMatchObject({ decisao: DECISAO_RECONCILIACAO.canario, tarefas: 2 });
    expect(m.feeds()).toEqual([]);
    expect(m.patches.map((p) => [(p.tarefa as TarefaEstoqueAmazon).sku, p.atrasoS])).toEqual([
      [skus[3], 1_200],
      [skus[17], 1_200],
    ]);
  });

  it('D = 31 under dry-run ⇒ ONE feed-enviar with the SAME block payload a feed gets (the send under dry-run builds and posts nothing); D = 25 under dry-run ⇒ no task, the count and a sample of 20 in the line', async () => {
    const m = mundo();
    m.ambiente[VALVULA_ENV_AMAZON.estoque] = 'dry-run';
    varios(m, 31, 'SKU-D', { erp: 7, amazon: 2 });
    const { ultima } = await rodar(m);
    expect(ultima).toMatchObject({ decisao: DECISAO_RECONCILIACAO.dryRunFeed });
    expect(m.feeds()).toHaveLength(1);
    const run = m.run();
    const lote0 = execucaoIdDoLoteBlocosFeed(CONTA, run?.execucaoId ?? '', 0);
    expect(m.feeds()[0]).toMatchObject({
      nome: nomeEnvioFeed(CONTA, lote0),
      atrasoS: 1_200,
      tarefa: {
        tipo: 'feed-enviar',
        fluxo: 'estoque',
        execucaoId: lote0,
        origem: 'reconciliacao',
        lote: {
          tipo: 'blocos',
          execucaoIdRun: run?.execucaoId,
          parteInicial: 0,
          partes: 1,
        },
      },
    });
    expect(m.patches).toEqual([]);
    expect(MAX_AMOSTRA_DRY_RUN).toBe(20);

    const n = mundo();
    n.ambiente[VALVULA_ENV_AMAZON.estoque] = 'dry-run';
    const skus = varios(n, 25, 'SKU-P', { erp: 7, amazon: 2 });
    const r = await rodar(n);
    expect(r.ultima).toMatchObject({
      decisao: DECISAO_RECONCILIACAO.patches,
      tarefas: 0,
      simulados: 25,
      amostra: skus.slice(0, MAX_AMOSTRA_DRY_RUN).join(','),
    });
    expect(n.patches).toEqual([]);
    expect(n.linhasPagina().at(-1)?.meta).toMatchObject({ simulados: 25 });
  });

  it('the valve off ⇒ a page reads NOTHING (zero Firestore operations)', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    await m.iniciar();
    m.ambiente[VALVULA_ENV_AMAZON.estoque] = 'off';
    const antes = m.fake.operacoes;
    const r = await m.drenar();
    expect(r.map((x) => x.acao)).toEqual([ACAO_PAGINA_RECONCILIACAO.valvulaDesligada]);
    expect(m.fake.operacoes).toBe(antes);
  });

  it('the read switch off ⇒ contexto-recusado, nothing read', async () => {
    const m = mundo();
    await m.iniciar();
    m.ambiente.AMAZON_CHAMADAS = 'off';
    const antes = m.fake.operacoes;
    const r = await m.drenar();
    expect(r.map((x) => [x.acao, x.motivo])).toEqual([
      ['contexto-recusado', 'chamadas-desligadas'],
    ]);
    expect(m.fake.operacoes).toBe(antes);
  });
});

describe('★ the systemic guard is catalogue-scale, never the switch', () => {
  it.each([
    [1_500, 20_000, true],
    [1_499, 20_000, false],
    [31, 60, true],
    [31, 63, false],
    [30, 60, false],
  ])('zeroSemLinha %i of %i enviáveis ⇒ guard %s', (zeroSemLinha, enviaveis, esperado) => {
    expect(guardaSistemicaEstoqueAmazon({ zeroSemLinha, enviaveis })).toBe(esperado);
    expect(LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON).toBe(1_500);
  });

  it('31 rowless zeros of 60 ⇒ NOTHING sent, estoque-deposito-sem-linhas raised', async () => {
    const m = mundo();
    varios(m, 31, 'SKU-Z', { erp: null, amazon: 3 });
    varios(m, 29, 'SKU-OK');
    const { ultima } = await rodar(m);
    expect(m.run()?.contagens).toMatchObject({ enviaveis: 60, zeroSemLinha: 31, divergencias: 31 });
    expect(ultima).toMatchObject({ decisao: DECISAO_RECONCILIACAO.depositoSemLinhas });
    expect(m.feeds()).toEqual([]);
    expect(m.patches).toEqual([]);
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.estoqueDepositoSemLinhas)?.resolvidoEm).toBeNull();
    // NEAR-MISS: the close never resolves what the decide just raised.
    expect(ultima?.avisos ?? '').toContain('estoque-deposito-sem-linhas:levantar');
    expect(ultima?.avisos ?? '').not.toContain('estoque-deposito-sem-linhas:resolver');
    // The decide's raise is clocked by the run's FIRST read too.
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.estoqueDepositoSemLinhas)?.relogioEvento).toBe(
      relogioDoDocumentoUs(m.run()?.relogioInicio as { seconds: number; nanoseconds: number }),
    );
  });

  it('NEAR-MISS: 31 rowless zeros of 63 ⇒ an ordinary feed (31 zeros is not catalogue-scale)', async () => {
    const m = mundo();
    varios(m, 31, 'SKU-Z', { erp: null, amazon: 3 });
    varios(m, 32, 'SKU-OK');
    const { ultima } = await rodar(m);
    expect(ultima).toMatchObject({ decisao: DECISAO_RECONCILIACAO.feed });
    expect(m.feeds()).toHaveLength(1);
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.estoqueDepositoSemLinhas)?.resolvidoEm).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                            the blocks and the payload                      */
/* -------------------------------------------------------------------------- */

describe('★ the blocks', () => {
  it('the block count travels IN the payload: after the next run reclaims and walks a page, the first run’s feed still reads ALL its blocks', async () => {
    const m = mundo();
    for (let i = 0; i < 320; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    varios(m, 31, 'SKU-D', { erp: 7, amazon: 2 }); // `produtos/p-…` keys: the 2nd page
    // A request lands during the run: its close starts the next run.
    await m.iniciar();
    await m.drenar(1);
    await m.solicitar(ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON.tick);
    await m.drenar(1);
    const [feed] = m.feeds();
    const lote = feed?.tarefa.lote;
    if (lote?.tipo !== 'blocos') throw new Error('teste: um lote de blocos');
    const primeiro = lote.execucaoIdRun;
    expect(lote).toMatchObject({ tipo: 'blocos', parteInicial: 0, partes: 2 });
    expect(feed?.tarefa.execucaoId).toBe(execucaoIdDoLoteBlocosFeed(CONTA, primeiro, 0));
    // The next run reclaimed the document and walked one page.
    await m.drenar(1);
    expect(m.run()?.execucaoId).not.toBe(primeiro);
    expect(m.run()?.paginas).toBe(1);
    const blocos = await lerBlocosDivergenciaEstoqueAmazon(asDb(m.fake), {
      contaId: CONTA,
      execucaoId: primeiro,
      parteInicial: lote.parteInicial,
      partes: lote.partes,
    });
    expect(blocos.flatMap((b) => b.itens)).toHaveLength(31);
    // NEAR-MISS: the run document's count is the NEXT run's, a prefix of the first's blocks.
    const doDocumento = await lerBlocosDivergenciaEstoqueAmazon(asDb(m.fake), {
      contaId: CONTA,
      execucaoId: primeiro,
      parteInicial: 0,
      partes: m.run()?.paginas ?? 1,
    });
    expect(doDocumento.flatMap((b) => b.itens)).toHaveLength(0);
  });

  it('a block retried after a crash between steps 5 and 6, with live reads that changed meanwhile, equals what step 6 counted', async () => {
    const m = mundo();
    const skus = varios(m, 4, 'SKU-D', { erp: 7, amazon: 2 });
    await m.iniciar();
    // The state update of page 0 fails once: the block is written, the counters are not.
    m.fake.falharEscrita(RUN, Object.assign(new Error('UNAVAILABLE'), { code: 14 }));
    await expect(m.drenar(1)).rejects.toThrow('UNAVAILABLE');
    m.fake.falharEscrita(RUN, null);
    const id = idDivergenciaEstoqueAmazon(m.run()?.execucaoId ?? '', 0);
    const bloco = `${RUN}/divergenciasEstoqueAmazon/${id}`;
    expect((m.fake.ler(bloco)?.itens as unknown[]).length).toBe(4);
    // Meanwhile Amazon converged on two SKUs; the queue retries the page.
    m.amazon.set(skus[0] ?? '', listing(skus[0] ?? '', 7));
    m.amazon.set(skus[1] ?? '', listing(skus[1] ?? '', 7));
    m.despachadas.clear();
    await m.drenar(1);
    expect(m.fake.escritasEm(bloco).map((e) => e.verbo)).toEqual(['set', 'set']);
    expect((m.fake.ler(bloco)?.itens as { sku: string }[]).map((x) => x.sku)).toEqual(
      skus.slice(2),
    );
    expect(m.run()?.contagens.divergencias).toBe(2);
  });

  it('NEAR-MISS: a retry that finds NO drift still overwrites the crashed attempt’s block (an empty block, never the stale items)', async () => {
    const m = mundo();
    const skus = varios(m, 3, 'SKU-Z', { erp: 7, amazon: 2 });
    await m.iniciar();
    m.fake.falharEscrita(RUN, Object.assign(new Error('UNAVAILABLE'), { code: 14 }));
    await expect(m.drenar(1)).rejects.toThrow('UNAVAILABLE');
    m.fake.falharEscrita(RUN, null);
    const id = idDivergenciaEstoqueAmazon(m.run()?.execucaoId ?? '', 0);
    const bloco = `${RUN}/divergenciasEstoqueAmazon/${id}`;
    expect((m.fake.ler(bloco)?.itens as unknown[]).length).toBe(3);
    // Amazon converged on every SKU; the queue retries the page.
    for (const s of skus) m.amazon.set(s, listing(s, 7));
    m.despachadas.clear();
    await m.drenar(1);
    expect(m.fake.escritasEm(bloco).map((e) => e.verbo)).toEqual(['set', 'set']);
    expect(m.fake.ler(bloco)?.itens).toEqual([]);
    expect(m.run()?.contagens.divergencias).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the depósito                               */
/* -------------------------------------------------------------------------- */

describe('★ the depósito is pinned from the walk', () => {
  it('changed during the walk ⇒ the run closes truncada (no decide) and a fresh run starts at the new depósito', async () => {
    const m = mundo();
    for (let i = 0; i < 320; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    await m.iniciar();
    const primeiro = m.run()?.execucaoId;
    await m.drenar(1);
    m.fake.seed(caminhoConta(CONTA), {
      ...m.fake.ler(caminhoConta(CONTA)),
      depositoOuterRef: `documents/depositos/${DEP_NOVO}`,
    });
    __resetAllReadCaches();
    const [r] = await m.drenar(1);
    expect(r).toMatchObject({ acao: 'truncada', motivo: 'deposito-mudou', proximo: 'iniciada' });
    expect(m.feeds()).toEqual([]);
    expect(m.patches).toEqual([]);
    expect(m.run()).toMatchObject({
      fase: 'varrendo',
      depositoOuterRef: `documents/depositos/${DEP_NOVO}`,
    });
    expect(m.run()?.execucaoId).not.toBe(primeiro);
    expect(m.fake.ler(PEDIDO)?.pendente).toBe(false);
  });

  it('every patch task carries the WALK’s depósito id, the block its canonical ref', async () => {
    const m = mundo();
    varios(m, 2, 'SKU-D', { erp: 7, amazon: 2 });
    await rodar(m);
    expect(m.patches.map((p) => (p.tarefa as TarefaEstoqueAmazon).depositoId)).toEqual([DEP, DEP]);
    const id = idDivergenciaEstoqueAmazon(m.run()?.execucaoId ?? '', 0);
    expect(m.fake.ler(`${RUN}/divergenciasEstoqueAmazon/${id}`)?.depositoOuterRef).toBe(REF_DEP);
  });

  it('a decide re-run AFTER the conta changed depósito still sends at the WALK’s depósito (NEAR-MISS: the conta’s new one)', async () => {
    const m = mundo();
    varios(m, 2, 'SKU-DV', { erp: 7, amazon: 2 });
    await m.iniciar();
    const [p0] = m.paginas();
    if (p0 === undefined) throw new Error('teste: a página 0 não foi enfileirada');
    m.despachadas.add(p0.i);
    // The decide's patch enqueue fails: the dispatch throws, the run stays `decidindo`.
    const falha = new TypeError('teste: a fila de estoque caiu');
    await expect(
      processarPaginaReconciliacaoEstoqueAmazon(asDb(m.fake), p0.t, {
        ...m.deps(),
        produtorEstoque: () => {
          throw falha;
        },
      }),
    ).rejects.toBe(falha);
    expect(m.run()).toMatchObject({ fase: 'decidindo', proximaPagina: 1 });
    expect(m.patches).toEqual([]);
    // The conta moves to another depósito before the queue retries the page.
    m.fake.seed(caminhoConta(CONTA), {
      ...m.fake.ler(caminhoConta(CONTA)),
      depositoOuterRef: `documents/depositos/${DEP_NOVO}`,
    });
    __resetAllReadCaches();
    expect((await m.pagina(p0.t)).acao).toBe(ACAO_PAGINA_RECONCILIACAO.adiantada);
    const [r] = await m.drenar();
    expect(r).toMatchObject({ acao: 'concluida', decisao: DECISAO_RECONCILIACAO.patches });
    // The drift was measured at DEP: its tasks say so, and the patch task refuses
    // them at the conta's new depósito (`deposito-mudou`) instead of patching.
    expect(m.patches.map((p) => (p.tarefa as TarefaEstoqueAmazon).depositoId)).toEqual([DEP, DEP]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        the run check and the re-kick                       */
/* -------------------------------------------------------------------------- */

describe('★ the re-kick of a live run that lost its next task', () => {
  it('a crash after the claim and before page 0’s enqueue ⇒ ≥ 15 min later the re-kick enqueues page 0 and the run completes', async () => {
    const m = mundo();
    varios(m, 2, 'SKU-OK');
    m.falhasLotes.push({ quando: (t) => t.tipo === 'reconciliacao', erro: new Error('fila caiu') });
    await expect(m.iniciar()).rejects.toThrow('fila caiu');
    const run = m.run();
    expect(run).toMatchObject({ fase: 'varrendo', proximaPagina: 0 });
    // NEAR-MISS: 14 minutes later nothing is due.
    m.relogio = AGORA_MS + 14 * MIN_MS;
    expect(await retomarReconciliacaoEstoqueAmazon(CONTA, m.run() ?? null, m.deps())).toBeNull();
    expect(m.paginas()).toEqual([]);
    m.relogio = AGORA_MS + 16 * MIN_MS;
    expect(await retomarReconciliacaoEstoqueAmazon(CONTA, m.run() ?? null, m.deps())).toBe(
      'retomada',
    );
    const [retomada] = m.paginas();
    expect(retomada?.x.nome).toBe(
      nomeRetomadaReconciliacao(CONTA, run?.execucaoId ?? '', 0, run?.iniciadaEmMs ?? 0),
    );
    // The same stall re-kicked twice is one task.
    expect(await retomarReconciliacaoEstoqueAmazon(CONTA, m.run() ?? null, m.deps())).toBe(
      'ja-retomada',
    );
    const { length } = await m.drenar();
    expect(length).toBe(1);
    expect(m.run()?.fase).toBe('concluida');
  });

  it('a page whose next-page enqueue fails on every attempt ⇒ the run stalls, and the re-kick heals it the same way', async () => {
    const m = mundo();
    for (let i = 0; i < 320; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    await m.iniciar();
    for (let n = 0; n < 5; n += 1) {
      m.falhasLotes.push({
        quando: (t) => t.tipo === 'reconciliacao' && t.pagina === 1,
        erro: new Error('fila caiu'),
      });
    }
    const [pagina0] = m.paginas();
    // Five attempts of page 0: the first walks, the other four only re-enqueue page 1.
    for (let n = 0; n < 5; n += 1) {
      await expect(m.pagina(pagina0?.t as TarefaPaginaReconciliacaoAmazon)).rejects.toThrow(
        'fila caiu',
      );
    }
    expect(m.run()?.proximaPagina).toBe(1);
    const progresso = m.run()?.progressoEmMs ?? 0;
    m.relogio = progresso + RETOMADA_RECONCILIACAO_MS + 1;
    expect(await retomarReconciliacaoEstoqueAmazon(CONTA, m.run() ?? null, m.deps())).toBe(
      'retomada',
    );
    m.despachadas.add(0);
    await m.drenar();
    expect(m.run()).toMatchObject({ fase: 'concluida', paginas: 2 });
    expect(m.run()?.contagens.vinculosLidos).toBe(320);
  });

  it.each([
    [RETOMADA_RECONCILIACAO_MS, null],
    [RETOMADA_RECONCILIACAO_MS + 1, 4],
  ])('the boundary: stale by %i ms ⇒ re-kick page %s', (atraso, pagina) => {
    const run = runDe({ progressoEmMs: AGORA_MS });
    expect(run.proximaPagina).toBe(4);
    const r = decidirRetomadaReconciliacaoEstoqueAmazon(run, AGORA_MS + atraso);
    expect(r === null ? null : r.pagina).toBe(pagina);
  });

  it('the bound is 15 min, literally: 14 min 30 s stale ⇒ no re-kick; 15 min and 1 ms ⇒ one', () => {
    expect(RETOMADA_RECONCILIACAO_MS).toBe(15 * MIN_MS);
    const run = runDe({ progressoEmMs: AGORA_MS });
    expect(decidirRetomadaReconciliacaoEstoqueAmazon(run, AGORA_MS + 14 * MIN_MS + 30_000)).toBe(
      null,
    );
    expect(decidirRetomadaReconciliacaoEstoqueAmazon(run, AGORA_MS + 15 * MIN_MS + 1)).toEqual({
      pagina: run.proximaPagina,
      marcoMs: AGORA_MS,
    });
  });
});

function runDe(over: Partial<ReconciliacaoEstoqueAmazon> = {}): ReconciliacaoEstoqueAmazon {
  return {
    execucaoId: 'exec-x',
    fase: FASE_RECONCILIACAO_ESTOQUE_AMAZON.varrendo,
    depositoOuterRef: REF_DEP,
    cursores: {
      canonica: { ultimoCaminho: null, concluida: false },
      nua: { ultimoCaminho: null, concluida: false },
    },
    proximaPagina: 4,
    paginas: 4,
    contagens: {
      vinculosLidos: 0,
      skusAvaliados: 0,
      enviaveis: 0,
      divergencias: 0,
      zeroSemLinha: 0,
      recusasHumanas: 0,
      recusadosEmDivergencia: 0,
      porChave: {},
    },
    progressoEmMs: null,
    relogioInicio: null,
    iniciadaEmMs: AGORA_MS,
    concluidaEmMs: null,
    ...over,
  };
}

describe('★ Start’s decision', () => {
  it.each([
    ['no run', null, AGORA_MS, 'criar'],
    ['an ended run', runDe({ fase: 'concluida' }), AGORA_MS, 'reclamar'],
    ['a truncated run', runDe({ fase: 'truncada' }), AGORA_MS, 'reclamar'],
    ['a live run, fresh', runDe({ progressoEmMs: AGORA_MS }), AGORA_MS + MIN_MS, 'em-execucao'],
    [
      'a live run 16 min stale',
      runDe({ progressoEmMs: AGORA_MS }),
      AGORA_MS + 16 * MIN_MS,
      'retomar',
    ],
    [
      'decidindo more than 2 h stale',
      runDe({ fase: 'decidindo', progressoEmMs: AGORA_MS }),
      AGORA_MS + 2 * HORA_MS + 1,
      'reclamar',
    ],
    [
      'NEAR-MISS: decidindo 1 h 59 min stale (re-kicked, never reclaimed)',
      runDe({ fase: 'decidindo', progressoEmMs: AGORA_MS }),
      AGORA_MS + 119 * MIN_MS,
      'retomar',
    ],
    [
      'NEAR-MISS: a live run EXACTLY 2 h stale (re-kicked, not yet reclaimed)',
      runDe({ progressoEmMs: AGORA_MS }),
      AGORA_MS + RECLAMACAO_RECONCILIACAO_MS,
      'retomar',
    ],
    [
      'a claim never progressed, 2 h stale (iniciadaEmMs)',
      runDe({ iniciadaEmMs: AGORA_MS }),
      AGORA_MS + RECLAMACAO_RECONCILIACAO_MS + 1,
      'reclamar',
    ],
  ])('%s ⇒ %s', (_caso, run, agora, tipo) => {
    expect(decidirInicioReconciliacaoEstoqueAmazon(run, agora).tipo).toBe(tipo);
  });

  it('a stuck decidindo reclaimed by the next Start runs a fresh walk; the old run’s late page stops at step 0', async () => {
    const m = mundo();
    varios(m, 2, 'SKU-OK');
    m.fake.seed(RUN, {
      ...runDe({ fase: 'decidindo', progressoEmMs: AGORA_MS }),
      depositoOuterRef: REF_DEP,
    });
    m.relogio = AGORA_MS + 2 * HORA_MS + 1;
    expect(await m.iniciar()).toMatchObject({ acao: 'iniciada' });
    // A late copy of the old run's page.
    const velha = await m.pagina({
      v: 1,
      tipo: 'reconciliacao',
      contaId: CONTA,
      execucaoId: 'exec-x',
      pagina: 4,
    });
    expect(velha.acao).toBe(ACAO_PAGINA_RECONCILIACAO.naoEDono);
    await m.drenar();
    expect(m.run()).toMatchObject({ fase: 'concluida', paginas: 1 });
  });

  it('★ Start on a live run 16 min stale RE-KICKS its next page (named by the stall) and never reclaims it', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    m.fake.seed(RUN, {
      ...runDe({ progressoEmMs: AGORA_MS - 16 * MIN_MS }),
      depositoOuterRef: REF_DEP,
    });
    expect(await m.iniciar()).toEqual({ acao: 'retomada', execucaoId: 'exec-x', pagina: 4 });
    expect(m.run()?.execucaoId).toBe('exec-x');
    expect(m.paginas().map((p) => [p.t.pagina, p.x.nome])).toEqual([
      [4, nomeRetomadaReconciliacao(CONTA, 'exec-x', 4, AGORA_MS - 16 * MIN_MS)],
    ]);
    // The same stall re-kicked again is the same task.
    expect(await m.iniciar()).toEqual({ acao: 'ja-retomada', execucaoId: 'exec-x', pagina: 4 });
    // A run that progressed 6 min ago is live and fresh: nothing at all.
    m.relogio = AGORA_MS - 10 * MIN_MS;
    expect(await m.iniciar()).toEqual({ acao: 'em-execucao', execucaoId: 'exec-x' });
    expect(m.paginas()).toHaveLength(1);
  });

  it('a conta that is not Amazon’s ⇒ no run; a conta with no depósito ⇒ no run; an inactive conta ⇒ no run', async () => {
    const m = mundo();
    const conta = m.fake.ler(caminhoConta(CONTA));
    m.fake.seed(caminhoConta(CONTA), { ...conta, tipo: 'outro' });
    expect(await m.iniciar()).toEqual({ acao: 'conta-indisponivel' });
    m.fake.seed(caminhoConta(CONTA), { ...conta });
    m.fake.seed(caminhoConta(CONTA), {
      ...m.fake.ler(caminhoConta(CONTA)),
      depositoOuterRef: null,
    });
    expect(await m.iniciar()).toEqual({ acao: 'sem-deposito' });
    m.fake.seed(caminhoConta(CONTA), { ...m.fake.ler(caminhoConta(CONTA)), ativo: false });
    expect(await m.iniciar()).toEqual({ acao: 'conta-indisponivel' });
    expect(m.fake.ler(RUN)).toBeUndefined();
    expect(m.lotes).toEqual([]);
  });

  it('a depósito whose id the stock documents cannot store ⇒ sem-deposito, nothing written (the storable parse, never the plain one)', async () => {
    const m = mundo();
    m.fake.seed(caminhoConta(CONTA), {
      ...m.fake.ler(caminhoConta(CONTA)),
      depositoOuterRef: 'documents/depositos/dep.ponto',
    });
    expect(await m.iniciar()).toEqual({ acao: 'sem-deposito' });
    expect(m.fake.ler(RUN)).toBeUndefined();
    expect(m.lotes).toEqual([]);
  });
});

describe('★ page idempotency and the run check', () => {
  it('every page is enqueued NAMED by (conta, run, page): page 0 by the claim, each next one by the page before it', async () => {
    const m = mundo();
    for (let i = 0; i < 650; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    await rodar(m);
    const exec = m.run()?.execucaoId ?? '';
    expect(m.run()).toMatchObject({ fase: 'concluida', paginas: 3 });
    expect(m.paginas().map((p) => [p.t.pagina, p.x.nome])).toEqual([
      [0, nomePaginaReconciliacao(CONTA, exec, 0)],
      [1, nomePaginaReconciliacao(CONTA, exec, 1)],
      [2, nomePaginaReconciliacao(CONTA, exec, 2)],
    ]);
  });

  it('a reconcile page confirms EVERY miss by GET — no window cap: 61 SKUs Amazon does not list ⇒ 61 GETs, none nao-confirmado', async () => {
    const m = mundo();
    varios(m, 61, 'SKU-AUS', { amazon: null });
    await rodar(m);
    expect(m.chamadas.filter((c) => c.tipo === 'get')).toHaveLength(61);
    expect(m.run()?.contagens.porChave['nao-confirmado']).toBeUndefined();
    expect(m.run()?.contagens.porChave['nao-listado']).toBe(61);
  });

  it('a late copy of a CONCLUDED run’s last page stops at step 0: no enqueue, no write (NEAR-MISS: the same run id is not enough)', async () => {
    const m = mundo();
    varios(m, 2, 'SKU-FIM');
    await rodar(m);
    expect(m.run()).toMatchObject({ fase: 'concluida', paginas: 1, proximaPagina: 1 });
    const [p0] = m.paginas();
    if (p0 === undefined) throw new Error('teste: a página 0 não foi enfileirada');
    const lotes = m.lotes.length;
    const escritas = m.fake.escritas.length;
    expect((await m.pagina(p0.t)).acao).toBe(ACAO_PAGINA_RECONCILIACAO.naoEDono);
    expect(m.lotes).toHaveLength(lotes);
    expect(m.fake.escritas.length).toBe(escritas);
  });

  it('the next-page enqueue throws once ⇒ the retried page re-enqueues WITHOUT re-walking, and the counters equal the seed', async () => {
    const m = mundo();
    for (let i = 0; i < 320; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    await m.iniciar();
    m.falhasLotes.push({
      quando: (t) => t.tipo === 'reconciliacao' && t.pagina === 1,
      erro: new Error('transitório'),
    });
    const [p0] = m.paginas();
    await expect(m.pagina(p0?.t as TarefaPaginaReconciliacaoAmazon)).rejects.toThrow('transitório');
    const consultas = m.fake.consultas.length;
    const r = await m.pagina(p0?.t as TarefaPaginaReconciliacaoAmazon);
    expect(r.acao).toBe(ACAO_PAGINA_RECONCILIACAO.adiantada);
    expect(m.fake.consultas.length).toBe(consultas); // no walk, no resolver query
    m.despachadas.add(0);
    await m.drenar();
    expect(m.run()?.contagens).toMatchObject({ vinculosLidos: 320, skusAvaliados: 320 });
  });

  it('a lost precondition at step 6 because ANOTHER dispatch advanced the run ⇒ vez-perdida, the run as that dispatch left it', async () => {
    const m = mundo();
    for (let i = 0; i < 320; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    await m.iniciar();
    m.fake.antesDaProximaEscrita(RUN, () => {
      m.fake.seed(RUN, { ...m.fake.ler(RUN), proximaPagina: 1, paginas: 1 });
    });
    const [r] = await m.drenar(1);
    expect(r?.acao).toBe(ACAO_PAGINA_RECONCILIACAO.vezPerdida);
    expect(m.run()).toMatchObject({ proximaPagina: 1, paginas: 1 });
    expect(m.run()?.contagens.vinculosLidos).toBe(0);
    expect(m.paginas()).toHaveLength(1);
  });

  it('a page past proximaPagina stops; a page of another run stops; neither writes', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    await m.iniciar();
    const exec = m.run()?.execucaoId ?? '';
    const escritas = m.fake.escritas.length;
    expect(
      (await m.pagina({ v: 1, tipo: 'reconciliacao', contaId: CONTA, execucaoId: exec, pagina: 2 }))
        .acao,
    ).toBe('nao-e-dono');
    expect(
      (
        await m.pagina({
          v: 1,
          tipo: 'reconciliacao',
          contaId: CONTA,
          execucaoId: 'outra',
          pagina: 0,
        })
      ).acao,
    ).toBe('nao-e-dono');
    expect(m.fake.escritas.length).toBe(escritas);
  });

  it('a request written between a page’s read and its state update leaves the run progressing (requests live apart)', async () => {
    const m = mundo();
    varios(m, 2, 'SKU-OK');
    await m.iniciar();
    let pedido: unknown = null;
    m.fake.antesDaProximaEscrita(RUN, async () => {
      pedido = await m.solicitar(ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON.tick);
    });
    const [r] = await m.drenar(1);
    expect(pedido).toMatchObject({ acao: 'pedido', inicio: { acao: 'em-execucao' } });
    // The page's update landed (no lost precondition), the run went on to close…
    expect(r?.acao).toBe(ACAO_PAGINA_RECONCILIACAO.concluida);
    // …and the close read the request and started the next run.
    expect(r?.proximo).toBe('iniciada');
    // `pendente` never touched the run's document.
    for (const e of m.fake.escritasEm(RUN)) expect(e.dados).not.toHaveProperty('pendente');
  });

  it('a 429 while reading Amazon ⇒ the run’s progress stamped (its ONE write), then the SAME page re-enqueued UNNAMED 60 s later; no block', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    await m.iniciar();
    m.limitarProximaBusca = true;
    const escritas = m.fake.escritas.length;
    const [r] = await m.drenar(1);
    expect(r?.acao).toBe(ACAO_PAGINA_RECONCILIACAO.limitada);
    const novas = m.fake.escritas.slice(escritas);
    expect(novas.map((e) => [e.caminho, e.verbo, e.comPrecondicao])).toEqual([
      [RUN, 'update', true],
    ]);
    expect(Object.keys(novas[0]?.dados ?? {})).toEqual(['progressoEmMs']);
    expect(m.run()).toMatchObject({ proximaPagina: 0, paginas: 0, progressoEmMs: m.relogio });
    const copia = m.lotes.at(-1);
    expect(copia).toMatchObject({ nome: null, atrasoS: ESPERA_LIMITE_PAGINA_S });
    expect(copia?.tarefa).toEqual(m.paginas()[0]?.t);
    await m.drenar();
    expect(m.run()?.fase).toBe('concluida');
  });

  it('the page budget reached ⇒ the page gives up: the run is truncada', async () => {
    const m = mundo();
    varios(m, 25, 'SKU-OK');
    await m.iniciar();
    // Every pacing wait burns the whole budget.
    const deps = m.deps();
    const lento: DepsPaginaReconciliacaoEstoqueAmazon = {
      ...deps,
      esperar: (ms) => {
        m.relogio += ms + ORCAMENTO_PAGINA_RECONCILIACAO_MS;
        return Promise.resolve();
      },
    };
    const [p0] = m.paginas();
    const r = await processarPaginaReconciliacaoEstoqueAmazon(
      asDb(m.fake),
      p0?.t as TarefaPaginaReconciliacaoAmazon,
      lento,
    );
    expect(r).toMatchObject({ acao: 'truncada', motivo: 'prazo' });
    expect(m.run()?.fase).toBe('truncada');
  });

  it.each([
    [401_000, ACAO_PAGINA_RECONCILIACAO.truncada],
    [399_000, ACAO_PAGINA_RECONCILIACAO.concluida],
  ] as const)(
    'the budget is 400 s, literally: a page whose pacing burns %i ms ends %s',
    async (queima, acao) => {
      expect(ORCAMENTO_PAGINA_RECONCILIACAO_MS).toBe(400_000);
      const m = mundo();
      varios(m, 25, 'SKU-OK');
      await m.iniciar();
      const [p0] = m.paginas();
      if (p0 === undefined) throw new Error('teste: a página 0 não foi enfileirada');
      const r = await processarPaginaReconciliacaoEstoqueAmazon(asDb(m.fake), p0.t, {
        ...m.deps(),
        esperar: (ms) => {
          m.relogio += ms + queima;
          return Promise.resolve();
        },
      });
      expect(r.acao).toBe(acao);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                                 the requests                               */
/* -------------------------------------------------------------------------- */

describe('★ Request', () => {
  it('a request during a run sets pendente on the REQUEST doc only; the run’s close starts the next', async () => {
    const m = mundo();
    for (let i = 0; i < 320; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    await m.iniciar();
    await m.drenar(1);
    const runAntes = m.fake.escritasEm(RUN).length;
    expect(await m.solicitar(ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON.tick)).toMatchObject({
      acao: 'pedido',
      inicio: { acao: 'em-execucao' },
    });
    expect(m.fake.ler(PEDIDO)).toMatchObject({ pendente: true, pedidoEmMs: m.relogio });
    expect(m.fake.escritasEm(RUN)).toHaveLength(runAntes);
    const [r] = await m.drenar(1);
    expect(r).toMatchObject({ acao: 'concluida', proximo: 'iniciada' });
    expect(m.fake.ler(PEDIDO)?.pendente).toBe(false);
    expect(m.run()).toMatchObject({ fase: 'varrendo', proximaPagina: 0 });
  });

  it('★ the automatic request: once per 24 h — a second inside the guard is REFUSED, nothing written, feed-estoque-falhou raised', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    expect((await m.solicitar('automatica')).acao).toBe('pedido');
    expect(m.fake.ler(PEDIDO)?.reexecucaoAutomaticaEmMs).toBe(AGORA_MS);
    await m.drenar();
    m.relogio = AGORA_MS + GUARDA_REEXECUCAO_AUTOMATICA_MS - 1;
    const escritas = m.fake.escritasEm(PEDIDO).length;
    expect(await m.solicitar('automatica')).toEqual({ acao: 'automatica-recusada' });
    expect(m.fake.escritasEm(PEDIDO)).toHaveLength(escritas);
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.feedEstoqueFalhou)?.resolvidoEm).toBeNull();
    // NEAR-MISS: a NON-automatic request inside the same 24 h is not guarded.
    expect((await m.solicitar('feed')).acao).toBe('pedido');
    // NEAR-MISS: at the 24-h mark the automatic one goes through again.
    m.relogio = AGORA_MS + GUARDA_REEXECUCAO_AUTOMATICA_MS;
    expect((await m.solicitar('automatica')).acao).toBe('pedido');
  });

  it('the guard is 24 h, literally: a second automatic request 23 h 30 min later is still refused', async () => {
    expect(GUARDA_REEXECUCAO_AUTOMATICA_MS).toBe(24 * HORA_MS);
    const m = mundo();
    sku(m, 'SKU-OK');
    expect((await m.solicitar('automatica')).acao).toBe('pedido');
    await m.drenar();
    m.relogio = AGORA_MS + 23 * HORA_MS + 30 * MIN_MS;
    expect(await m.solicitar('automatica')).toEqual({ acao: 'automatica-recusada' });
  });
});

/* -------------------------------------------------------------------------- */
/*                                  the avisos                                */
/* -------------------------------------------------------------------------- */

describe('★ Close: the avisos, clocked by relogioInicio', () => {
  it('a completed clean run resolves vinculos-recusados, recusado-pela-amazon and deposito-sem-linhas', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    await rodar(m);
    for (const motivo of [
      MOTIVO_CONTA_AMAZON.estoqueVinculosRecusados,
      MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon,
      MOTIVO_CONTA_AMAZON.estoqueDepositoSemLinhas,
    ]) {
      expect(avisoDe(m, motivo)?.resolvidoEm, motivo).not.toBeNull();
      // Clocked by the run's FIRST read, never the close's.
      expect(avisoDe(m, motivo)?.relogioEvento).toBe(
        relogioDoDocumentoUs(m.run()?.relogioInicio as { seconds: number; nanoseconds: number }),
      );
    }
  });

  it('a TRUNCATED run resolves nothing (it may still raise a refusal it counted)', async () => {
    const m = mundo();
    // A refused SKU on page 0, then a depósito change truncates page 1.
    for (let i = 0; i < 320; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    await m.iniciar();
    await m.drenar(1);
    m.fake.seed(caminhoConta(CONTA), {
      ...m.fake.ler(caminhoConta(CONTA)),
      depositoOuterRef: null,
    });
    __resetAllReadCaches();
    await m.drenar(1);
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.estoqueVinculosRecusados)?.resolvidoEm).toBeNull();
    for (const motivo of [
      MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon,
      MOTIVO_CONTA_AMAZON.estoqueDepositoSemLinhas,
      MOTIVO_CONTA_AMAZON.feedEstoqueFalhou,
    ]) {
      expect(avisoDe(m, motivo), motivo).toBeUndefined();
    }
  });

  it('NEAR-MISS: a truncated run that counted NO refusal writes no aviso at all (a completed one would resolve them)', async () => {
    const m = mundo();
    varios(m, 305, 'SKU-OK');
    await m.iniciar();
    await m.drenar(1);
    expect(m.run()?.contagens.recusasHumanas).toBe(0);
    m.fake.seed(caminhoConta(CONTA), {
      ...m.fake.ler(caminhoConta(CONTA)),
      depositoOuterRef: null,
    });
    __resetAllReadCaches();
    const [r] = await m.drenar(1);
    expect(r).toMatchObject({ acao: 'truncada', motivo: 'deposito-mudou', avisos: null });
    for (const motivo of [
      MOTIVO_CONTA_AMAZON.estoqueVinculosRecusados,
      MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon,
      MOTIVO_CONTA_AMAZON.estoqueDepositoSemLinhas,
      MOTIVO_CONTA_AMAZON.feedEstoqueFalhou,
    ]) {
      expect(avisoDe(m, motivo), motivo).toBeUndefined();
    }
  });

  it('★ R6: a patch INVALID raise AFTER the run’s first read survives the close; a stale recusado on an in-sync SKU is not counted', async () => {
    const m = mundo();
    sku(m, 'SKU-OK', {
      link: {
        envioEstoqueAmazon: {
          via: 'patch',
          emMs: AGORA_MS - DIA_MS,
          resultado: 'recusado',
          quantidade: 5,
          problemas: [],
        },
      },
    });
    await m.iniciar();
    // During the walk, after its first read, a patch task raises the aviso.
    m.fake.antesDaProximaEscrita(RUN, async () => {
      await sincronizarAvisoContaEstoqueAmazon(
        asDb(m.fake),
        { increment, nowMs: m.relogio },
        {
          integracaoId: CONTA,
          motivo: MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon,
          acao: ACAO_AVISO_CONTA_ESTOQUE_AMAZON.levantar,
          // A Firestore clock LATER than the run's first read.
          relogio: m.fake.seed('sondas/r6', { n: 1 }),
        },
      );
    });
    await m.drenar();
    expect(m.run()?.contagens.recusadosEmDivergencia).toBe(0);
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon)?.resolvidoEm).toBeNull();
  });

  it('a recusado on a SKU still in drift is counted and raises estoque-recusado-pela-amazon', async () => {
    const m = mundo();
    sku(m, 'SKU-D', {
      erp: 7,
      amazon: 2,
      link: {
        envioEstoqueAmazon: {
          via: 'patch',
          emMs: AGORA_MS - DIA_MS,
          resultado: 'recusado',
          quantidade: 7,
          problemas: [],
        },
      },
    });
    await rodar(m);
    expect(m.run()?.contagens.recusadosEmDivergencia).toBe(1);
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon)?.resolvidoEm).toBeNull();
  });

  it('a human refusal raises estoque-vinculos-recusados', async () => {
    const m = mundo();
    fantasma(m, 'sumido', 'SKU-SUMIDO');
    await rodar(m);
    expect(m.run()?.contagens.recusasHumanas).toBe(1);
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.estoqueVinculosRecusados)?.resolvidoEm).toBeNull();
  });
});

describe('★ the breaker’s aviso: a zero drift resolves feed-estoque-falhou only while the feed path is healthy', () => {
  async function comVez(vez: Record<string, unknown> | null) {
    const m = mundo();
    sku(m, 'SKU-OK');
    // The aviso already raised by a failed feed, long ago.
    await sincronizarAvisoContaEstoqueAmazon(
      asDb(m.fake),
      { increment, nowMs: AGORA_MS },
      {
        integracaoId: CONTA,
        motivo: MOTIVO_CONTA_AMAZON.feedEstoqueFalhou,
        acao: ACAO_AVISO_CONTA_ESTOQUE_AMAZON.levantar,
        relogio: { seconds: 1, nanoseconds: 0 },
      },
    );
    if (vez !== null) m.fake.seed(VEZ, vez);
    await rodar(m);
    const aviso = avisoDe(m, MOTIVO_CONTA_AMAZON.feedEstoqueFalhou);
    if (aviso?.resolvidoEm != null) {
      // A resolve by the decide is clocked by the run's FIRST read.
      expect(aviso.relogioEvento).toBe(
        relogioDoDocumentoUs(m.run()?.relogioInicio as { seconds: number; nanoseconds: number }),
      );
    }
    return aviso?.resolvidoEm;
  }
  const livre = (falhasSeguidas: number) => ({
    estado: 'livre',
    ateMs: AGORA_MS - HORA_MS,
    atualizadoEmMs: AGORA_MS - HORA_MS,
    falhasSeguidas,
  });

  it(`falhasSeguidas ${String(MAX_FALHAS_SEGUIDAS_FEED)} (the breaker open) ⇒ STAYS raised`, async () => {
    expect(await comVez(livre(MAX_FALHAS_SEGUIDAS_FEED))).toBeNull();
  });

  it('NEAR-MISS: falhasSeguidas 2 ⇒ resolved; no lease at all ⇒ resolved', async () => {
    expect(await comVez(livre(2))).not.toBeNull();
    expect(await comVez(null)).not.toBeNull();
  });

  it('an uncertain enviando (expired, no feedId) ⇒ STAYS raised; a LIVE enviando ⇒ resolved', async () => {
    const enviando = (ateMs: number) => ({
      estado: 'enviando',
      execucaoId: 'outro',
      antesDoEnvioMs: AGORA_MS - HORA_MS,
      ateMs,
      atualizadoEmMs: AGORA_MS - HORA_MS,
    });
    expect(await comVez(enviando(AGORA_MS - MIN_MS))).toBeNull();
    expect(await comVez(enviando(AGORA_MS + HORA_MS))).not.toBeNull();
  });
});

describe('the lines', () => {
  it('ONE line per page dispatch, with ids and counts only — never a SKU outside a dry-run sample', async () => {
    const m = mundo();
    varios(m, 3, 'SKU-SEGREDO', { erp: 7, amazon: 2 });
    await rodar(m);
    expect(m.linhasPagina()).toHaveLength(1);
    expect(m.linhasPagina()[0]?.meta).toMatchObject({
      evento: 'estoque',
      fase: 'reconciliacao',
      etapa: 'pagina',
      acao: 'concluida',
      decisao: 'patches',
      tarefas: 3,
      conta: CONTA,
    });
    const paginas = JSON.stringify(m.linhasPagina());
    expect(paginas).not.toContain('SKU-SEGREDO');
  });

  it('the page names derive from (conta, run, page)', () => {
    expect(nomePaginaReconciliacao(CONTA, 'e1', 0)).not.toBe(
      nomePaginaReconciliacao(CONTA, 'e1', 1),
    );
    expect(nomePaginaReconciliacao(CONTA, 'e1', 0)).not.toBe(
      nomePaginaReconciliacao(CONTA, 'e2', 0),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                      the run across pages, and its healing                  */
/* -------------------------------------------------------------------------- */

const indisponivel = () => Object.assign(new Error('UNAVAILABLE'), { code: 14 });

/**
 * The fake, whose `prodAmazon` group queries advance the world's clock by
 * `saltoMs` as they read: the instant a walk's budget check looks at.
 */
function comVarreduraLenta(m: Mundo, saltoMs: number): Firestore {
  const base = asDb(m.fake) as unknown as Record<string | symbol, unknown>;
  const CONSTRUTORES = new Set(['where', 'orderBy', 'select', 'limit', 'startAfter']);
  const consulta = (alvo: object): object =>
    new Proxy(alvo, {
      get(t, prop) {
        const v: unknown = Reflect.get(t, prop, t);
        if (typeof v !== 'function') return v;
        const f = v as (...a: unknown[]) => unknown;
        if (prop === 'get') {
          return async (...a: unknown[]) => {
            const r = await f.apply(t, a);
            m.relogio += saltoMs;
            return r;
          };
        }
        if (typeof prop === 'string' && CONSTRUTORES.has(prop)) {
          return (...a: unknown[]) => consulta(f.apply(t, a) as object);
        }
        return f.bind(t);
      },
    });
  return new Proxy(base, {
    get(t, prop) {
      const v: unknown = Reflect.get(t, prop, t);
      if (typeof v !== 'function') return v;
      const f = v as (...a: unknown[]) => unknown;
      if (prop === 'collectionGroup') {
        return (id: string) => {
          const q = f.call(t, id) as object;
          return id === 'prodAmazon' ? consulta(q) : q;
        };
      }
      return f.bind(t);
    },
  }) as unknown as Firestore;
}

describe('★ Decide reads the WHOLE run’s drift, not the closing page’s', () => {
  /** `n` drift SKUs whose keys sort BEFORE 320 refused links: page 0 holds them, page 1 none. */
  function driftNoPrimeiroBloco(m: Mundo, n: number): string[] {
    const skus = Array.from({ length: n }, (_v, i) =>
      sku(m, `SKU-A-${String(i).padStart(3, '0')}`, {
        produtoId: `a-${String(i).padStart(3, '0')}`,
        erp: 7,
        amazon: 2,
      }),
    );
    for (let i = 0; i < 320; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    return skus;
  }

  it('31 drift SKUs all on page 0, none on the closing page ⇒ ONE block feed-enviar with partes 2 (NEAR-MISS: the closing page’s zero would read as no drift)', async () => {
    const m = mundo();
    driftNoPrimeiroBloco(m, 31);
    const { paginas, ultima } = await rodar(m);
    expect(paginas.map((p) => p.pagina?.divergencias)).toEqual([31, 0]);
    expect(ultima).toMatchObject({ decisao: DECISAO_RECONCILIACAO.feed, feed: 'enfileirada' });
    expect(m.feeds().map((f) => f.tarefa.lote)).toEqual([
      expect.objectContaining({ tipo: 'blocos', parteInicial: 0, partes: 2 }),
    ]);
    expect(m.patches).toEqual([]);
    // The walk page decided nothing: its line names no feed and no batch (NEAR-MISS: the decide's does).
    const [walk, decide] = m.linhasPagina();
    expect(walk?.meta).toMatchObject({ feed: null, lotes: 0, lotesJaEnfileirados: 0 });
    expect(decide?.meta).toMatchObject({ feed: 'enfileirada', lotes: 1, lotesJaEnfileirados: 0 });
  });

  it('5 drift SKUs on page 0 ⇒ 5 patch tasks, and feed-estoque-falhou is NOT resolved as a zero drift', async () => {
    const m = mundo();
    const skus = driftNoPrimeiroBloco(m, 5);
    await sincronizarAvisoContaEstoqueAmazon(
      asDb(m.fake),
      { increment, nowMs: AGORA_MS },
      {
        integracaoId: CONTA,
        motivo: MOTIVO_CONTA_AMAZON.feedEstoqueFalhou,
        acao: ACAO_AVISO_CONTA_ESTOQUE_AMAZON.levantar,
        relogio: { seconds: 1, nanoseconds: 0 },
      },
    );
    const { ultima } = await rodar(m);
    expect(ultima).toMatchObject({
      decisao: DECISAO_RECONCILIACAO.patches,
      tarefas: 5,
      feed: null,
      lotes: 0,
      lotesJaEnfileirados: 0,
    });
    for (const linha of m.linhasPagina()) {
      expect(linha.meta).toMatchObject({ feed: null, lotes: 0, lotesJaEnfileirados: 0 });
    }
    expect(m.patches.map((p) => (p.tarefa as TarefaEstoqueAmazon).sku).sort()).toEqual(skus);
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.feedEstoqueFalhou)?.resolvidoEm).toBeNull();
  });
});

describe('★ step 4 narrows by class: only a 429 is a pause', () => {
  it('a search answering 500 ⇒ the page REJECTS with the HTTP class, never the throttle (the queue retries, its attempts counted); no copy re-enqueued, the run unwritten', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    await m.iniciar();
    m.statusDaBusca = 500;
    const lotes = m.lotes.length;
    const escritas = m.fake.escritasEm(RUN).length;
    const falha: unknown = await m.drenar(1).then(
      () => null,
      (err: unknown) => err,
    );
    expect(falha).toBeInstanceOf(AmazonHttpError);
    expect(falha).not.toBeInstanceOf(AmazonThrottleError);
    expect(m.lotes).toHaveLength(lotes);
    expect(m.fake.escritasEm(RUN)).toHaveLength(escritas);
  });

  it('a Firestore failure inside the evaluator (a children seek) ⇒ the page REJECTS with it; no copy, the run unwritten', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    await m.iniciar();
    m.fake.falharConsulta('produtos', indisponivel());
    const lotes = m.lotes.length;
    const escritas = m.fake.escritasEm(RUN).length;
    await expect(m.drenar(1)).rejects.toMatchObject({ code: 14 });
    expect(m.lotes).toHaveLength(lotes);
    expect(m.fake.escritasEm(RUN)).toHaveLength(escritas);
  });
});

describe('★ healing a run whose close died', () => {
  it('the close’s request read fails AFTER the end was written ⇒ the retried page re-runs the tail and starts the pending run (NEAR-MISS: a late copy with nothing pending writes nothing)', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    await m.iniciar();
    const primeiro = m.run()?.execucaoId;
    m.fake.seed(PEDIDO, { pendente: true, pedidoEmMs: AGORA_MS, reexecucaoAutomaticaEmMs: null });
    // The page's writes on the run: its state update, the decide's `enviando`, the close's end.
    m.fake.antesDaProximaEscrita(RUN, () => undefined);
    m.fake.antesDaProximaEscrita(RUN, () => undefined);
    m.fake.antesDaProximaEscrita(RUN, () => {
      m.fake.falharLeitura(PEDIDO, indisponivel());
    });
    await expect(m.drenar(1)).rejects.toThrow('UNAVAILABLE');
    m.fake.falharLeitura(PEDIDO, null);
    expect(m.run()).toMatchObject({ execucaoId: primeiro, fase: 'concluida' });
    expect(m.fake.ler(PEDIDO)?.pendente).toBe(true);

    m.despachadas.clear();
    const [r] = await m.drenar(1);

    expect(r).toMatchObject({ acao: ACAO_PAGINA_RECONCILIACAO.naoEDono, proximo: 'iniciada' });
    expect(m.run()).toMatchObject({ fase: 'varrendo', proximaPagina: 0 });
    expect(m.run()?.execucaoId).not.toBe(primeiro);
    expect(m.fake.ler(PEDIDO)?.pendente).toBe(false);
  });

  it('the close’s END write fails after the decide marked enviando ⇒ the re-kick ≥ 15 min later closes it concluida and starts the pending run, WITHOUT deciding again', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    await m.iniciar();
    m.fake.seed(PEDIDO, { pendente: true, pedidoEmMs: AGORA_MS, reexecucaoAutomaticaEmMs: null });
    m.fake.antesDaProximaEscrita(RUN, () => undefined);
    m.fake.antesDaProximaEscrita(RUN, () => undefined);
    m.fake.antesDaProximaEscrita(RUN, () => {
      throw indisponivel();
    });
    await expect(m.drenar(1)).rejects.toThrow('UNAVAILABLE');
    expect(m.run()).toMatchObject({ fase: 'enviando', proximaPagina: 1 });
    const leiturasDaVez = m.fake.leituras.filter((c) => c === VEZ).length;
    expect(leiturasDaVez).toBe(1);

    m.relogio = (m.run()?.progressoEmMs ?? 0) + RETOMADA_RECONCILIACAO_MS + 1;
    expect(await retomarReconciliacaoEstoqueAmazon(CONTA, m.run() ?? null, m.deps())).toBe(
      'retomada',
    );
    const lotes = m.lotes.length;
    const [r] = await m.drenar(1);

    expect(r).toMatchObject({
      acao: ACAO_PAGINA_RECONCILIACAO.concluida,
      decisao: null,
      proximo: 'iniciada',
    });
    // Decide ran ONCE: no second lease read, no second send.
    expect(m.fake.leituras.filter((c) => c === VEZ)).toHaveLength(leiturasDaVez);
    expect(m.lotes.slice(lotes).map((l) => l.tarefa.tipo)).toEqual(['reconciliacao']);
    expect(m.run()).toMatchObject({ fase: 'varrendo', proximaPagina: 0 });
  });
});

describe('★ the depósito check reads the claim’s source', () => {
  it('a depósito changed while the context’s CACHED conta still holds the old one ⇒ re-read raw, the page WALKS at the run’s depósito (NEAR-MISS: a raw read that differs too truncates — once)', async () => {
    const m = mundo();
    sku(m, 'SKU-OK', { amazon: 0 });
    await rodar(m); // the conta cache now holds DEP
    expect(m.run()?.fase).toBe('concluida');
    const conta = m.fake.ler(caminhoConta(CONTA));
    m.fake.seed(caminhoConta(CONTA), {
      ...conta,
      depositoOuterRef: `documents/depositos/${DEP_NOVO}`,
    });

    const segundo = await rodar(m);

    expect(segundo.paginas.map((p) => p.acao)).toEqual([ACAO_PAGINA_RECONCILIACAO.concluida]);
    expect(m.run()).toMatchObject({
      fase: 'concluida',
      depositoOuterRef: `documents/depositos/${DEP_NOVO}`,
    });

    // NEAR-MISS: the conta moves again before page 0: the raw read differs too.
    await m.iniciar();
    m.fake.seed(caminhoConta(CONTA), {
      ...conta,
      depositoOuterRef: 'documents/depositos/dep-rec-3',
    });
    const terceiro = await m.drenar();
    expect(terceiro.map((p) => [p.acao, p.motivo])).toEqual([
      [ACAO_PAGINA_RECONCILIACAO.truncada, 'deposito-mudou'],
      [ACAO_PAGINA_RECONCILIACAO.concluida, null],
    ]);
    expect(m.run()).toMatchObject({ depositoOuterRef: 'documents/depositos/dep-rec-3' });
  });

  it('NEAR-MISS: a page whose cached conta holds the run’s depósito reads the conta raw NO more (the raw read is for a mismatch only)', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    await rodar(m); // the conta cache now holds DEP
    await m.iniciar(); // Start's own raw read
    const contaLida = () => m.fake.leituras.filter((c) => c === caminhoConta(CONTA)).length;
    const antes = contaLida();

    const paginas = await m.drenar();

    expect(paginas.map((p) => p.acao)).toEqual([ACAO_PAGINA_RECONCILIACAO.concluida]);
    expect(contaLida()).toBe(antes);
  });
});

describe('★ the automatic request owes its Start', () => {
  it('a first attempt that wrote the request and failed before the claim ⇒ the queue’s retry inside the 24 h STARTS it, stamping nothing (NEAR-MISS: with nothing pending it is refused, no Start)', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    m.fake.falharLeitura(RUN, indisponivel());
    await expect(m.solicitar('automatica')).rejects.toThrow('UNAVAILABLE');
    m.fake.falharLeitura(RUN, null);
    expect(m.fake.ler(PEDIDO)).toMatchObject({
      pendente: true,
      reexecucaoAutomaticaEmMs: AGORA_MS,
    });
    m.relogio += 30_000;
    const escritas = m.fake.escritasEm(PEDIDO).length;

    expect(await m.solicitar('automatica')).toMatchObject({
      acao: 'pedido',
      inicio: { acao: 'iniciada' },
    });
    // The only request write is the claim's clearing; the guard's stamp is the first's.
    expect(m.fake.escritasEm(PEDIDO)).toHaveLength(escritas + 1);
    expect(m.fake.ler(PEDIDO)).toMatchObject({
      pendente: false,
      reexecucaoAutomaticaEmMs: AGORA_MS,
    });
    expect(avisoDe(m, MOTIVO_CONTA_AMAZON.feedEstoqueFalhou)).toBeUndefined();

    await m.drenar();
    const lotes = m.lotes.length;
    expect(await m.solicitar('automatica')).toEqual({ acao: 'automatica-recusada' });
    expect(m.lotes).toHaveLength(lotes);
  });
});

describe('★ a throttled page is never re-kicked as lost', () => {
  it('three 429s a minute apart stamp the run’s progress: a tick 16 min after the claim re-kicks nothing (NEAR-MISS: 15 min after the LAST stamp, a lost copy IS re-kicked)', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    await m.iniciar();
    for (const minuto of [13, 14, 15]) {
      m.relogio = AGORA_MS + minuto * MIN_MS;
      m.limitarProximaBusca = true;
      const [r] = await m.drenar(1);
      expect(r?.acao).toBe(ACAO_PAGINA_RECONCILIACAO.limitada);
    }
    m.relogio = AGORA_MS + 16 * MIN_MS;
    expect(await retomarReconciliacaoEstoqueAmazon(CONTA, m.run() ?? null, m.deps())).toBeNull();
    m.relogio = (m.run()?.progressoEmMs ?? 0) + RETOMADA_RECONCILIACAO_MS + 1;
    expect(await retomarReconciliacaoEstoqueAmazon(CONTA, m.run() ?? null, m.deps())).toBe(
      'retomada',
    );
  });

  it('a 429 whose progress stamp finds the run moved on (another dispatch walked this page) ⇒ vez-perdida, NO copy re-enqueued', async () => {
    const m = mundo();
    sku(m, 'SKU-OK');
    await m.iniciar();
    m.limitarProximaBusca = true;
    m.fake.antesDaProximaEscrita(RUN, () => {
      m.fake.seed(RUN, { ...m.fake.ler(RUN), proximaPagina: 1, paginas: 1 });
    });
    const lotes = m.lotes.length;
    const [r] = await m.drenar(1);
    expect(r?.acao).toBe(ACAO_PAGINA_RECONCILIACAO.vezPerdida);
    expect(m.lotes).toHaveLength(lotes);
    expect(m.run()).toMatchObject({ proximaPagina: 1, progressoEmMs: null });
  });
});

describe('★ the dedupe and the counters across pages', () => {
  it('ONE produto holding two link docs of a SKU across a page boundary ⇒ evaluated on page 0 only, ja-visto on page 1, ONE block item (NEAR-MISS: keyed by the dono it would run twice)', async () => {
    const m = mundo();
    for (let i = 0; i < 299; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    sku(m, 'SKU-DUP', { produtoId: 'p-dup', linkId: 'l1', erp: 7, amazon: 2 });
    m.fake.seed('produtos/p-dup/prodAmazon/l2', {
      contaAmazonOuterRef: REF_CONTA,
      sku: 'SKU-DUP',
      productDataJson: { pesado: 'x'.repeat(32) },
    });
    const { paginas } = await rodar(m);
    expect(
      paginas.map((p) => [p.pagina?.vinculos, p.pagina?.avaliados, p.pagina?.jaVistos]),
    ).toEqual([
      [300, 300, 0],
      [1, 0, 1],
    ]);
    expect(m.run()?.contagens).toMatchObject({ skusAvaliados: 300, divergencias: 1 });
    const blocos = await lerBlocosDivergenciaEstoqueAmazon(asDb(m.fake), {
      contaId: CONTA,
      execucaoId: m.run()?.execucaoId ?? '',
      parteInicial: 0,
      partes: 2,
    });
    expect(blocos.flatMap((b) => b.itens.map((x) => x.sku))).toEqual(['SKU-DUP']);
  });

  it('the per-motivo counts are SUMMED over the pages, and an in-drift recusado counts once PER LINK', async () => {
    const m = mundo();
    for (let i = 0; i < 320; i += 1)
      fantasma(m, `f${String(i).padStart(4, '0')}`, `SKU-F-${String(i)}`);
    const recusado = {
      envioEstoqueAmazon: {
        via: 'patch',
        emMs: AGORA_MS - DIA_MS,
        resultado: 'recusado',
        quantidade: 7,
        problemas: [],
      },
    };
    sku(m, 'SKU-R', { produtoId: 'a-r', erp: 7, amazon: 2, link: recusado });
    m.fake.seed('produtos/a-r/prodAmazon/l2', {
      contaAmazonOuterRef: REF_CONTA,
      sku: 'SKU-R',
      productDataJson: { pesado: 'x'.repeat(32) },
      ...recusado,
    });
    const { paginas } = await rodar(m);
    expect(paginas).toHaveLength(2);
    expect(m.run()?.contagens.porChave['produto-ausente']).toBe(320);
    expect(m.run()?.contagens.recusadosEmDivergencia).toBe(2);
  });
});

describe('★ the walk’s budget is read before EACH ref form’s query', () => {
  it('the budget passed while the canonical form was read ⇒ the bare form is NOT queried, the run truncada (prazo)', async () => {
    const m = mundo();
    sku(m, 'SKU-CANONICA');
    sku(m, 'SKU-NUA', { refConta: REF_CONTA_NUA });
    await m.iniciar();
    const [p0] = m.paginas();
    if (p0 === undefined) throw new Error('teste: a página 0 não foi enfileirada');
    m.despachadas.add(p0.i);
    const r = await processarPaginaReconciliacaoEstoqueAmazon(
      comVarreduraLenta(m, ORCAMENTO_PAGINA_RECONCILIACAO_MS),
      p0.t,
      m.deps(),
    );
    expect(r).toMatchObject({ acao: 'truncada', motivo: 'prazo' });
    const walk = m.fake.consultas.filter(
      (q) => q.colecao === 'prodAmazon' && q.ordens.some(([c]) => c === '__name__'),
    );
    expect(walk.map((q) => q.filtros)).toEqual([[['contaAmazonOuterRef', REF_CONTA]]]);
  });
});

describe('★ Decide PARTITIONS the block feed: one batch per cap of walked pages', () => {
  const CAP = MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON;
  const EXEC_P = 'exec-particao';

  /**
   * A run that walked `paginas` pages with 31+ drift SKUs, stored `decidindo`:
   * the page past its last re-enters the decide (step 0), no walk needed.
   */
  async function decidirCom(m: Mundo, paginas: number) {
    m.fake.seed(RUN, {
      ...runDe({
        execucaoId: EXEC_P,
        fase: FASE_RECONCILIACAO_ESTOQUE_AMAZON.decidindo,
        proximaPagina: paginas,
        paginas,
        progressoEmMs: AGORA_MS,
      }),
      contagens: { ...runDe().contagens, enviaveis: 4 * paginas, divergencias: 2 * paginas + 31 },
    });
    return m.pagina({
      v: 1,
      tipo: 'reconciliacao',
      contaId: CONTA,
      execucaoId: EXEC_P,
      pagina: paginas,
    });
  }

  /** What each enqueued block feed covers: [parteInicial, parteInicial + partes). */
  const intervalos = (m: Mundo) =>
    m
      .feeds()
      .map((f) =>
        f.tarefa.lote.tipo === 'blocos'
          ? [f.tarefa.lote.parteInicial, f.tarefa.lote.parteInicial + f.tarefa.lote.partes]
          : null,
      );

  it('the partition: ⌈pages ÷ cap⌉ consecutive ranges, no gap, no overlap, every one but the last exactly the cap', () => {
    expect(CAP).toBe(50);
    expect(lotesDeBlocosEstoqueAmazon(1)).toEqual([{ parteInicial: 0, partes: 1 }]);
    expect(lotesDeBlocosEstoqueAmazon(CAP)).toEqual([{ parteInicial: 0, partes: CAP }]);
    expect(lotesDeBlocosEstoqueAmazon(CAP + 1)).toEqual([
      { parteInicial: 0, partes: CAP },
      { parteInicial: CAP, partes: 1 },
    ]);
    expect(lotesDeBlocosEstoqueAmazon(2 * CAP + 7)).toEqual([
      { parteInicial: 0, partes: CAP },
      { parteInicial: CAP, partes: CAP },
      { parteInicial: 2 * CAP, partes: 7 },
    ]);
    for (const paginas of [1, 2, CAP - 1, CAP, CAP + 1, 3 * CAP, 3 * CAP + 1, 997]) {
      const lotes = lotesDeBlocosEstoqueAmazon(paginas);
      expect(lotes).toHaveLength(Math.ceil(paginas / CAP));
      const cobertas = lotes.flatMap((l) =>
        Array.from({ length: l.partes }, (_v, i) => l.parteInicial + i),
      );
      expect(cobertas).toEqual(Array.from({ length: paginas }, (_v, i) => i));
      for (const l of lotes) expect(l.partes).toBeLessThanOrEqual(CAP);
    }
    for (const paginas of [0, -1, 1.5]) {
      expect(() => lotesDeBlocosEstoqueAmazon(paginas)).toThrow(RangeError);
    }
  });

  it('★ exactly the cap of pages ⇒ ONE batch [0, cap), batch 0 of the run', async () => {
    const m = mundo();
    const r = await decidirCom(m, CAP);
    expect(r).toMatchObject({
      decisao: DECISAO_RECONCILIACAO.feed,
      feed: 'enfileirada',
      lotes: 1,
      lotesJaEnfileirados: 0,
    });
    expect(intervalos(m)).toEqual([[0, CAP]]);
    const [feed] = m.feeds();
    expect(feed?.tarefa.execucaoId).toBe(execucaoIdDoLoteBlocosFeed(CONTA, EXEC_P, 0));
    expect(feed?.nome).toBe(nomeEnvioFeed(CONTA, execucaoIdDoLoteBlocosFeed(CONTA, EXEC_P, 0)));
    expect(feed?.tarefa.lote).toMatchObject({ execucaoIdRun: EXEC_P });
    expect(m.run()?.fase).toBe('concluida');
  });

  it('★ NEAR-MISS cap + 1 pages ⇒ TWO batches [0, cap) and [cap, cap + 1): distinct execucaoIds and names, both reading the run, the same delay and wait, each a payload the schema accepts', async () => {
    const m = mundo();
    const r = await decidirCom(m, CAP + 1);
    expect(r).toMatchObject({
      decisao: DECISAO_RECONCILIACAO.feed,
      feed: 'enfileirada',
      lotes: 2,
      lotesJaEnfileirados: 0,
    });
    expect(intervalos(m)).toEqual([
      [0, CAP],
      [CAP, CAP + 1],
    ]);
    const feeds = m.feeds();
    const ids = feeds.map((f) => f.tarefa.execucaoId);
    expect(ids).toEqual([0, 1].map((k) => execucaoIdDoLoteBlocosFeed(CONTA, EXEC_P, k)));
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(EXEC_P);
    expect(feeds.map((f) => f.nome)).toEqual(ids.map((id) => nomeEnvioFeed(CONTA, id)));
    expect(new Set(feeds.map((f) => f.nome)).size).toBe(2);
    const esperas = new Set<number>();
    for (const f of feeds) {
      expect(f.atrasoS).toBe(ATRASO_ENVIO_RECONCILIACAO_S);
      expect(f.tarefa).toMatchObject({
        fluxo: 'estoque',
        contaId: CONTA,
        origem: 'reconciliacao',
        lote: { tipo: 'blocos', execucaoIdRun: EXEC_P },
      });
      expect(tarefaEnviarFeedAmazonSchema.parse(f.tarefa)).toEqual(f.tarefa);
      if (f.tarefa.lote.tipo === 'blocos') esperas.add(f.tarefa.lote.esperaAteMs);
    }
    expect([...esperas]).toEqual([m.relogio + 1_200_000 + ESPERA_LOTE_BLOCOS_MS]);
    expect(m.linhasPagina().at(-1)?.meta).toMatchObject({ lotes: 2, lotesJaEnfileirados: 0 });
  });

  it('a walk of 2 × cap + 7 pages ⇒ three batches, the last one the remainder', async () => {
    const m = mundo();
    expect(await decidirCom(m, 2 * CAP + 7)).toMatchObject({ lotes: 3 });
    expect(intervalos(m)).toEqual([
      [0, CAP],
      [CAP, 2 * CAP],
      [2 * CAP, 2 * CAP + 7],
    ]);
  });

  it.each([
    [1, 1],
    [CAP, 1],
    [CAP + 1, 2],
  ])(
    '★ the decide of %i pages run again (its enviando lost) names every one of its %i batches as before: all ja-enfileirada, nothing new enqueued (NEAR-MISS: the first decide had enqueued them as NEW tasks before its enviando failed)',
    async (paginas, lotes) => {
      const m = mundo();
      // The decide's first write on the run is its `enviando`: it fails once.
      m.fake.antesDaProximaEscrita(RUN, () => {
        throw indisponivel();
      });
      await expect(decidirCom(m, paginas)).rejects.toThrow('UNAVAILABLE');
      expect(m.run()?.fase).toBe('decidindo');
      // The fake queue records only a task it accepted as new.
      const primeiros = m.feeds().map((f) => f.nome);
      expect(primeiros).toHaveLength(lotes);

      const r = await m.pagina({
        v: 1,
        tipo: 'reconciliacao',
        contaId: CONTA,
        execucaoId: EXEC_P,
        pagina: paginas,
      });

      expect(r).toMatchObject({ feed: 'ja-enfileirada', lotes, lotesJaEnfileirados: lotes });
      expect(m.linhasPagina().at(-1)?.meta).toMatchObject({
        feed: 'ja-enfileirada',
        lotes,
        lotesJaEnfileirados: lotes,
      });
      expect(m.feeds().map((f) => f.nome)).toEqual(primeiros);
      expect(m.run()?.fase).toBe('concluida');
    },
  );

  it('a decide whose SECOND batch failed to enqueue is retried: batch 0 already held, batch 1 enqueued ⇒ feed enfileirada, lotesJaEnfileirados 1', async () => {
    const m = mundo();
    m.falhasLotes.push({
      quando: (t) =>
        t.tipo === 'feed-enviar' && t.lote.tipo === 'blocos' && t.lote.parteInicial === CAP,
      erro: indisponivel(),
    });
    await expect(decidirCom(m, CAP + 1)).rejects.toThrow();
    expect(intervalos(m)).toEqual([[0, CAP]]);
    expect(m.run()?.fase).toBe('decidindo');

    const r = await m.pagina({
      v: 1,
      tipo: 'reconciliacao',
      contaId: CONTA,
      execucaoId: EXEC_P,
      pagina: CAP + 1,
    });

    expect(r).toMatchObject({ feed: 'enfileirada', lotes: 2, lotesJaEnfileirados: 1 });
    expect(intervalos(m)).toEqual([
      [0, CAP],
      [CAP, CAP + 1],
    ]);
  });

  it('under dry-run the decide partitions the same way (the send each batch reaches posts nothing: pinned in provedorLoteEstoque.test.ts)', async () => {
    const m = mundo();
    m.ambiente[VALVULA_ENV_AMAZON.estoque] = 'dry-run';
    expect(await decidirCom(m, CAP + 1)).toMatchObject({
      decisao: DECISAO_RECONCILIACAO.dryRunFeed,
      lotes: 2,
    });
    expect(intervalos(m)).toEqual([
      [0, CAP],
      [CAP, CAP + 1],
    ]);
  });

  /** The SKUs the drift blocks of {@link EXEC_P} hold, by page: one each. */
  const SKU_BLOCO_0 = 'SKU-BLOCO-0';
  const SKU_BLOCO_CAP = 'SKU-BLOCO-CAP';
  const SKU_FORA_DO_RUN = 'SKU-FORA-DO-RUN';

  /**
   * A run of `paginas` pages stored `decidindo` with `divergencias` drift SKUs,
   * one drift block written at page 0, at page `cap` and at page `paginas` (one
   * past the run's last page): the page past its last re-enters the decide.
   */
  async function decidirPatchesCom(m: Mundo, paginas: number, divergencias: number) {
    for (const [pagina, s] of [
      [0, SKU_BLOCO_0],
      [CAP, SKU_BLOCO_CAP],
      [paginas, SKU_FORA_DO_RUN],
    ] as const) {
      await gravarBlocoDivergenciaEstoqueAmazon(asDb(m.fake), {
        contaId: CONTA,
        execucaoId: EXEC_P,
        pagina,
        depositoId: DEP,
        itens: [
          { sku: s, unidadeId: `u-${String(pagina)}`, quantidadeAmazon: 2, quantidadeErp: 7 },
        ],
        agoraMs: AGORA_MS,
      });
    }
    m.fake.seed(RUN, {
      ...runDe({
        execucaoId: EXEC_P,
        fase: FASE_RECONCILIACAO_ESTOQUE_AMAZON.decidindo,
        proximaPagina: paginas,
        paginas,
        progressoEmMs: AGORA_MS,
      }),
      contagens: { ...runDe().contagens, enviaveis: 4 * paginas, divergencias },
    });
    return m.pagina({
      v: 1,
      tipo: 'reconciliacao',
      contaId: CONTA,
      execucaoId: EXEC_P,
      pagina: paginas,
    });
  }

  const skusDosPatches = (m: Mundo) =>
    m.patches.map((p) => (p.tarefa as TarefaEstoqueAmazon).sku).sort();

  it('★ the patch path is NOT capped: D ≤ 30 over cap + 1 pages ⇒ a patch task for the drift on block 0 AND on block cap, each named by the run (NEAR-MISS: a block past the run’s last page is never read)', async () => {
    const m = mundo();
    const r = await decidirPatchesCom(m, CAP + 1, 3);
    expect(r).toMatchObject({
      decisao: DECISAO_RECONCILIACAO.patches,
      tarefas: 2,
      feed: null,
      lotes: 0,
      lotesJaEnfileirados: 0,
    });
    expect(skusDosPatches(m)).toEqual([SKU_BLOCO_0, SKU_BLOCO_CAP]);
    expect(skusDosPatches(m)).not.toContain(SKU_FORA_DO_RUN);
    for (const p of m.patches) {
      expect(p.tarefa).toMatchObject({ origem: 'reconciliacao', referencia: EXEC_P });
    }
    expect(m.feeds()).toEqual([]);
  });

  it('★ the canary branch is NOT capped either: D ≥ 31 over cap + 1 pages under a canary list naming the SKU of block cap ⇒ its patch task (NEAR-MISS: a listed SKU on a block past the run’s last page gets none, an unlisted one on block 0 none)', async () => {
    const m = mundo();
    m.ambiente[CANARIO_ENV_AMAZON.estoque] =
      `${CONTA}:${SKU_BLOCO_CAP},${CONTA}:${SKU_FORA_DO_RUN}`;
    const r = await decidirPatchesCom(m, CAP + 1, 2 * (CAP + 1) + 31);
    expect(r).toMatchObject({
      decisao: DECISAO_RECONCILIACAO.canario,
      tarefas: 1,
      feed: null,
      lotes: 0,
    });
    expect(skusDosPatches(m)).toEqual([SKU_BLOCO_CAP]);
    expect(m.feeds()).toEqual([]);
  });
});
