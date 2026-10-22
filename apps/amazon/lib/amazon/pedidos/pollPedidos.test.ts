/**
 * The backstop poll, end to end against the fake Firestore: the REAL context
 * loader, the REAL package client and `searchOrders` helper, the REAL
 * notification store, the REAL park and the REAL `escreverAviso` /
 * `resolverAviso`. Only the transports are faked: Amazon is a scripted `fetch`
 * handed in through `deps.fetch`, the queue a recording producer, the clock and
 * the enqueue deadline manual.
 *
 * ⚠️ No network (D11): the global `fetch` is replaced by one that refuses and
 * records, and every test ends by asserting it was never called.
 *
 * Every row is built IN TEST CODE from the committed BR sandbox fixture
 * (`fixtures/__wire__/sb-searchorders-br.json`, the model's own example,
 * sanitized): only `orderId` and `lastUpdatedTime` are rewritten.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  MOTIVO_IMPORTACAO_PARADA_AMAZON,
  type PollPedidosAmazon,
  TIPO_AVISO,
  pollPedidosAmazonSchema,
} from '@delfrance/schemas';

import {
  chaveImportacaoParada,
  chaveReconexao,
  chaveSegredoRecusado,
  levantarImportacaoParadaAmazon,
} from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { ConfigAmazonAusenteError } from '../core/erros';
import { DIRETORIO_WIRE_AMAZON, lerFixtureAmazon } from '../fixtures/wireCorpus';
import type { AgendadorDePrazoAmazon } from '../notificacoes/prazo';
import {
  FalhaTarefaAmazonError,
  type PayloadNotificacaoAmazon,
  docIdNotificacaoAmazon,
} from '../notificacoes/notificacao';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { falhaDoFunctions, rejeicaoDoTransporte } from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  AMBIENTE_DESLIGADO,
  HORA_MS,
  REFRESH_TOKEN_A,
  AUTORIZADO_EM_MS,
  SPID_A,
  SPID_B,
  caminhoAviso,
  caminhoCredencial,
  credencialDoc,
  erroLwa,
  loggerEspiao,
  refDe,
  respostaJson,
  seedConta,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import { LOOKBACK_POLL_ENV_AMAZON } from './janelaPoll';
import { INTERVALO_POLL_AMAZON_MS, ordemDoTickAmazon } from './orcamentoPoll';
import {
  type DepsPollAmazon,
  LIMIAR_AVISO_IMPORTACAO_PARADA_AMAZON,
  type ResultadoContaPollAmazon,
  type ResultadoTickPollAmazon,
  executarPollPedidosAmazon,
  resumirTickPollAmazon,
} from './pollPedidos';

const ID = 'conta-1';
const CAMINHO_POLL = `pollPedidosAmazon/${ID}`;
const COLECAO_NOTIFICACOES = 'notificacoesAmazon';
const MINUTO_MS = 60_000;

/** A stored cursor two hours before AGORA: its fresh window starts ten minutes earlier. */
const CURSOR = AGORA_MS - 2 * HORA_MS;
const JANELA_DO_CURSOR = '2027-01-15T12:50:00Z';
/** A cursorless conta's bootstrap with the default 24-h look-back, and its window. */
const BOOTSTRAP = AGORA_MS - 24 * HORA_MS;
const JANELA_DO_BOOTSTRAP = '2027-01-14T14:50:00Z';

const PEDIDO_A = '111-0000000-0000001';
const PEDIDO_B = '111-0000000-0000002';
const PEDIDO_C = '111-0000000-0000003';

/* ------------------------------ the BR fixture ------------------------------ */

const ORDEM_DO_EXEMPLO: Record<string, unknown> = (() => {
  const leitura = lerFixtureAmazon(
    readFileSync(join(DIRETORIO_WIRE_AMAZON, 'sb-searchorders-br.json'), 'utf8'),
  );
  if (!leitura.ok) throw new Error('sb-searchorders-br.json não é um envelope válido');
  const corpo = leitura.data.resposta.corpo as { orders?: unknown[] };
  const [ordem] = corpo.orders ?? [];
  if (typeof ordem !== 'object' || ordem === null) throw new Error('o exemplo não tem pedido');
  return ordem as Record<string, unknown>;
})();

const iso = (ms: number, fracao = '000') => `${new Date(ms).toISOString().slice(0, 19)}.${fracao}Z`;

/** One row: the BR example with its order id and stamp rewritten. */
function linha(orderId: string, lastUpdatedTime: string): Record<string, unknown> {
  return { ...structuredClone(ORDEM_DO_EXEMPLO), orderId, lastUpdatedTime };
}

/** µs of an ISO stamp built by {@link iso}. */
const us = (ms: number, fracao = 0) => ms * 1000 + fracao;

/**
 * `searchOrders` pages served by token: page `i` is answered for token `t-<i>`
 * (no token = page 0) and announces `t-<i+1>` while another page follows.
 */
function paginado(
  paginas: readonly (readonly unknown[])[],
): (url: URL) => Response | Promise<Response> {
  return (url) => {
    const token = url.searchParams.get('paginationToken');
    const i = token === null ? 0 : Number(token.slice(2));
    const corpo: Record<string, unknown> = { orders: paginas[i] ?? [] };
    if (i < paginas.length - 1) corpo.pagination = { nextToken: `t-${String(i + 1)}` };
    return respostaJson(200, corpo);
  };
}

/* --------------------------------- the harness -------------------------------- */

/** A deadline that never fires on its own: a test fires it through `h.dispararPrazo()`. */
function montar() {
  const db = new FakeDb();
  let agora = AGORA_MS;
  let execucoes = 0;
  const log = loggerEspiao();
  const prazos: (() => void)[] = [];
  const h = {
    db,
    log,
    agora: () => agora,
    avancar(ms: number) {
      agora += ms;
    },
    ir(ms: number) {
      agora = ms;
    },
    /** Every SP-API request, in order. */
    requisicoes: [] as URL[],
    /** How many LWA exchanges were made. */
    lwa: 0,
    respostaLwa: (): Response => tokenDeAcesso(),
    responder: paginado([[]]) as (
      url: URL,
      init: RequestInit | undefined,
    ) => Response | Promise<Response>,
    latenciaMs: 0,
    custoDoEnfileiramentoMs: 0,
    enfileirados: [] as PayloadNotificacaoAmazon[],
    enfileirar: null as ((p: PayloadNotificacaoAmazon) => Promise<void>) | null,
    esperas: [] as number[],
    /** Fire the deadline of the enqueue in flight. */
    dispararPrazo() {
      const vencer = prazos.at(-1);
      if (vencer === undefined) throw new Error('nenhum prazo armado');
      vencer();
    },
    deps(over: Partial<DepsPollAmazon> = {}): DepsPollAmazon {
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if ((init?.method ?? 'GET') === 'POST') {
          h.lwa += 1;
          return h.respostaLwa();
        }
        h.requisicoes.push(url);
        const r = await h.responder(url, init);
        h.avancar(h.latenciaMs);
        return r;
      };
      const agendarPrazo: AgendadorDePrazoAmazon = (_ms, aoVencer) => {
        prazos.push(aoVencer);
        return () => undefined;
      };
      return {
        ambiente: AMBIENTE_LIGADO,
        importadorPresente: true,
        agendador: {
          enfileirar: async (p) => {
            h.avancar(h.custoDoEnfileiramentoMs);
            if (h.enfileirar !== null) return h.enfileirar(p);
            h.enfileirados.push(p);
          },
        },
        agora: () => agora,
        increment,
        logger: log.logger,
        gerarExecucaoId: () => {
          execucoes += 1;
          return `exec-${String(execucoes)}`;
        },
        esperar: (ms) => {
          h.esperas.push(ms);
          return Promise.resolve();
        },
        agendarPrazo,
        fetch,
        gerarCorrelationId: () => 'corr-1',
        ...over,
      };
    },
  };
  return h;
}

type Harness = ReturnType<typeof montar>;

/** An active, connected conta with a fresh credential (no LWA call needed). */
function contaConectada(h: Harness, id = ID, spid = SPID_A, nome = 'Conta Um') {
  seedConta(h.db, id, { nome, selling_partner_id: spid });
  seedCredencial(h.db, id);
}

/** A poll document as stored, from the schema's defaults plus `over`. */
function seedPoll(h: Harness, over: Record<string, unknown> = {}, caminho = CAMINHO_POLL) {
  return h.db.seed(caminho, pollPedidosAmazonSchema.parse({ cursorMs: CURSOR, ...over }));
}

function poll(h: Harness, caminho = CAMINHO_POLL): PollPedidosAmazon {
  const d = h.db.ler(caminho);
  if (d === undefined) throw new Error(`${caminho} não existe`);
  return pollPedidosAmazonSchema.parse(d);
}

function tick(h: Harness, over: Partial<DepsPollAmazon> = {}): Promise<ResultadoTickPollAmazon> {
  return executarPollPedidosAmazon(asDb(h.db), h.deps(over));
}

async function umaConta(h: Harness, over: Partial<DepsPollAmazon> = {}) {
  const r = await tick(h, over);
  const [c] = r.contas;
  if (c === undefined) throw new Error('a conta não rodou');
  return c;
}

const caminhoNotificacao = (p: PayloadNotificacaoAmazon) =>
  `${COLECAO_NOTIFICACOES}/${docIdNotificacaoAmazon(p)}`;

const aviso = (h: Harness, id = ID) => h.db.ler(caminhoAviso(chaveImportacaoParada(id)));

/** The poll's own lines (`evento: 'poll'`). */
const linhasDoPoll = (h: Harness) =>
  h.log.linhas.filter((l) => l.meta?.evento === 'poll').map((l) => l.meta ?? {});

/* ------------------------------ D11 and the caches ------------------------------ */

const chamadasDeRede: string[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/* ===================================== gates ===================================== */

describe('the tick’s two gates — each with ZERO reads', () => {
  it('no importer ⇒ one INFO line and not a single Firestore operation or request', async () => {
    const h = montar();
    contaConectada(h);
    const r = await tick(h, { importadorPresente: false });
    expect(r).toEqual({ portao: 'importador-ausente', contas: [], abortado: null });
    expect(h.db.operacoes).toBe(0);
    expect(h.requisicoes).toHaveLength(0);
    expect(h.log.linhas).toHaveLength(1);
    expect(h.log.linhas[0]?.nivel).toBe('info');
    expect(h.log.linhas[0]?.meta).toMatchObject({ evento: 'poll', desfecho: 'importador-ausente' });
  });

  it('the switch off ⇒ one chamada-bloqueada line, zero reads, zero fetches, NO poll document', async () => {
    const h = montar();
    contaConectada(h);
    const r = await tick(h, { ambiente: AMBIENTE_DESLIGADO });
    expect(r.portao).toBe('chamadas-desligadas');
    expect(h.db.operacoes).toBe(0);
    expect(h.requisicoes).toHaveLength(0);
    expect(h.lwa).toBe(0);
    expect(h.db.ler(CAMINHO_POLL)).toBeUndefined();
    expect(h.log.linhas.map((l) => l.meta)).toEqual([
      expect.objectContaining({ evento: 'chamada-bloqueada', rota: 'pollPedidos' }),
    ]);
  });

  it('the importer gate comes FIRST: both closed ⇒ only the importer line', async () => {
    const h = montar();
    const r = await tick(h, { importadorPresente: false, ambiente: AMBIENTE_DESLIGADO });
    expect(r.portao).toBe('importador-ausente');
    expect(h.log.linhas.map((l) => l.meta?.evento)).toEqual(['poll']);
  });
});

/* ===================================== drain ===================================== */

describe('the drain', () => {
  it('a cursorless conta: the bootstrap is anchored IN the lease create; an empty window keeps it', async () => {
    const h = montar();
    contaConectada(h);
    const c = await umaConta(h);
    expect(c.desfecho).toBe('janela-vazia');
    const [primeira] = h.requisicoes;
    expect(primeira?.pathname).toBe('/orders/2026-01-01/orders');
    expect(primeira?.searchParams.get('lastUpdatedAfter')).toBe(JANELA_DO_BOOTSTRAP);
    expect(primeira?.searchParams.get('marketplaceIds')).toBe('A2Q3Y263D00KWC');
    expect(primeira?.searchParams.get('maxResultsPerPage')).toBe('100');
    expect(primeira?.searchParams.has('lastUpdatedBefore')).toBe(false);
    const [lease] = h.db.escritasEm(CAMINHO_POLL);
    expect(lease?.verbo).toBe('create');
    expect(lease?.dados?.cursorMs).toBe(BOOTSTRAP);
    expect(poll(h)).toMatchObject({
      cursorMs: BOOTSTRAP,
      pendente: null,
      emExecucaoAteMs: 0,
      execucaoId: null,
      falhasSeguidas: 0,
      ultimaVarreduraEmMs: AGORA_MS,
    });
  });

  it('several pages ⇒ every new row enqueued once and the cursor advanced to the max row', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    const a = CURSOR + 10 * MINUTO_MS;
    const b = CURSOR + 20 * MINUTO_MS;
    h.responder = paginado([[linha(PEDIDO_A, iso(a, '000123'))], [linha(PEDIDO_B, iso(b))]]);
    const c = await umaConta(h);
    expect(c).toMatchObject({
      desfecho: 'sucesso',
      enfileiradas: 2,
      paginas: 2,
      cursorAvancou: true,
    });
    expect(h.requisicoes.map((u) => u.searchParams.get('paginationToken'))).toEqual([null, 't-1']);
    // Every page resends the window byte-identical.
    expect(new Set(h.requisicoes.map((u) => u.searchParams.get('lastUpdatedAfter')))).toEqual(
      new Set([JANELA_DO_CURSOR]),
    );
    expect(h.enfileirados.map((p) => p.amazonOrderId)).toEqual([PEDIDO_A, PEDIDO_B]);
    expect(h.enfileirados[0]).toEqual({
      tipo: 'pedido',
      origem: 'poll',
      sellerId: SPID_A,
      amazonOrderId: PEDIDO_A,
      contaId: ID,
      lastUpdatedUs: us(a, 123),
    });
    expect(poll(h)).toMatchObject({
      cursorMs: b,
      pendente: null,
      vistos: { [PEDIDO_A]: us(a, 123), [PEDIDO_B]: us(b) },
    });
  });

  it('the cursor never passes the drain start − 5 min, even when the max row is later', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = paginado([[linha(PEDIDO_A, iso(AGORA_MS - MINUTO_MS))]]);
    await umaConta(h);
    expect(poll(h).cursorMs).toBe(AGORA_MS - 5 * MINUTO_MS);
    // …and the row is still enqueued: the cap only holds the cursor back.
    expect(h.enfileirados).toHaveLength(1);
  });

  it('truncated at page 5 ⇒ the cursor unchanged and the next page’s token stored as pendente', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.latenciaMs = 1_000;
    const paginas = [0, 1, 2, 3, 4, 5].map((i) => [
      linha(`111-0000000-000010${String(i)}`, iso(CURSOR + (i + 1) * 5 * MINUTO_MS)),
    ]);
    h.responder = paginado(paginas);
    const c = await umaConta(h);
    expect(c).toMatchObject({ desfecho: 'truncado', paginas: 5, enfileiradas: 5, motivo: null });
    expect(h.requisicoes).toHaveLength(5);
    expect(poll(h)).toMatchObject({
      cursorMs: CURSOR,
      falhasSeguidas: 0,
      pendente: {
        paginationToken: 't-5',
        lastUpdatedAfter: JANELA_DO_CURSOR,
        marketplaceIds: 'A2Q3Y263D00KWC',
        inicioDrenagemMs: AGORA_MS,
        tokenEmMs: AGORA_MS + 5_000,
        paginas: 5,
      },
    });

    // An hour later (the lease long expired) the next tick RESUMES: the stored
    // token and the stored window, byte-identical — then the drain completes.
    h.ir(AGORA_MS + HORA_MS);
    h.requisicoes.length = 0;
    const d = await umaConta(h);
    expect(d).toMatchObject({ desfecho: 'sucesso', retomada: true, paginas: 1, enfileiradas: 1 });
    const [retomada] = h.requisicoes;
    expect(retomada?.searchParams.get('paginationToken')).toBe('t-5');
    expect(retomada?.searchParams.get('lastUpdatedAfter')).toBe(JANELA_DO_CURSOR);
    expect(retomada?.searchParams.get('marketplaceIds')).toBe('A2Q3Y263D00KWC');
    // Capped by the STORED drain start, the cursor reaches the last page's row.
    expect(poll(h)).toMatchObject({ cursorMs: CURSOR + 30 * MINUTO_MS, pendente: null });
  });

  it('a resume sends the STORED lastUpdatedAfter and marketplaceIds byte-identical — never recomputed', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h, {
      pendente: {
        paginationToken: 'tok-guardado+/=',
        lastUpdatedAfter: '2027-01-15T11:11:11Z',
        marketplaceIds: 'A2Q3Y263D00KWC,ATVPDKIKX0DER',
        inicioDrenagemMs: AGORA_MS - 10 * MINUTO_MS,
        tokenEmMs: AGORA_MS - 10 * MINUTO_MS,
        paginas: 2,
      },
    });
    await umaConta(h);
    const [r] = h.requisicoes;
    expect(r?.searchParams.get('paginationToken')).toBe('tok-guardado+/=');
    expect(r?.searchParams.get('lastUpdatedAfter')).toBe('2027-01-15T11:11:11Z');
    expect(r?.searchParams.get('marketplaceIds')).toBe('A2Q3Y263D00KWC,ATVPDKIKX0DER');
  });

  it('a stored token of 23 h + 1 ms is discarded (a fresh window); one of 23 h − 1 ms is resumed', async () => {
    const pendente = (tokenEmMs: number) => ({
      paginationToken: 'tok-velho',
      lastUpdatedAfter: '2027-01-15T11:11:11Z',
      marketplaceIds: 'A2Q3Y263D00KWC',
      inicioDrenagemMs: tokenEmMs,
      tokenEmMs,
      paginas: 5,
    });
    const velho = montar();
    contaConectada(velho);
    seedPoll(velho, { pendente: pendente(AGORA_MS - 23 * HORA_MS - 1) });
    await umaConta(velho);
    expect(velho.requisicoes[0]?.searchParams.has('paginationToken')).toBe(false);
    expect(velho.requisicoes[0]?.searchParams.get('lastUpdatedAfter')).toBe(JANELA_DO_CURSOR);

    const novo = montar();
    contaConectada(novo);
    seedPoll(novo, { pendente: pendente(AGORA_MS - 23 * HORA_MS + 1) });
    await umaConta(novo);
    expect(novo.requisicoes[0]?.searchParams.get('paginationToken')).toBe('tok-velho');
  });

  it('a 400 on the RESUMED page ⇒ pendente cleared, NOT counted; a 400 on a fresh window ⇒ counted', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h, {
      pendente: {
        paginationToken: 'tok-expirado',
        lastUpdatedAfter: JANELA_DO_CURSOR,
        marketplaceIds: 'A2Q3Y263D00KWC',
        inicioDrenagemMs: AGORA_MS - HORA_MS,
        tokenEmMs: AGORA_MS - HORA_MS,
        paginas: 5,
      },
    });
    h.responder = () => respostaJson(400, { errors: [{ code: 'InvalidInput' }] });
    const c = await umaConta(h);
    expect(c).toMatchObject({ desfecho: 'paginacao-expirada', motivo: null });
    expect(poll(h)).toMatchObject({ pendente: null, falhasSeguidas: 0, cursorMs: CURSOR });
    expect(aviso(h)).toBeUndefined();

    // The next tick builds a fresh window — and a 400 there is OUR parameter bug.
    h.ir(AGORA_MS + INTERVALO_POLL_AMAZON_MS);
    const d = await umaConta(h);
    expect(d).toMatchObject({
      desfecho: 'falha',
      motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.requisicaoRecusada,
    });
    expect(poll(h)).toMatchObject({ falhasSeguidas: 1, ultimoErro: 'requisicao-recusada' });
    expect(aviso(h)).toMatchObject({
      resolvidoEm: null,
      params: { motivo: 'requisicao-recusada' },
    });
  });

  it('near-miss: a 400 on page 2 of a FRESH window (a token this run received) is counted, never "expired"', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    const pagina1 = paginado([[linha(PEDIDO_A, iso(CURSOR + MINUTO_MS))], []]);
    h.responder = (url) =>
      url.searchParams.has('paginationToken')
        ? respostaJson(400, { errors: [{ code: 'InvalidInput' }] })
        : pagina1(url);
    const c = await umaConta(h);
    expect(c.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.requisicaoRecusada);
    // The run stopped AT page 2: that position is stored for the next tick.
    expect(poll(h).pendente?.paginationToken).toBe('t-1');
  });

  it('a stale run’s final write never moves the cursor back (re-derived as a max)', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    const a = CURSOR + 10 * MINUTO_MS;
    h.responder = paginado([[linha(PEDIDO_A, iso(a))]]);
    // The lease lands; then, before the final write, something moves the cursor
    // FORWARD while the lease is still ours.
    h.db.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
    h.db.antesDaProximaEscrita(CAMINHO_POLL, () => {
      const atual = h.db.ler(CAMINHO_POLL) ?? {};
      // Ten minutes ahead: still inside vistos' 25-min window, so the merge shows.
      h.db.seed(CAMINHO_POLL, { ...atual, cursorMs: a + 10 * MINUTO_MS });
    });
    const c = await umaConta(h);
    expect(c.desfecho).toBe('sucesso');
    expect(poll(h)).toMatchObject({
      cursorMs: a + 10 * MINUTO_MS,
      execucaoId: null,
      vistos: { [PEDIDO_A]: us(a) },
    });
  });

  it('an idle tick re-listing the overlap enqueues NOTHING; a changed stamp of the same order IS enqueued', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    const a = CURSOR + 10 * MINUTO_MS;
    h.responder = paginado([[linha(PEDIDO_A, iso(a))]]);
    await umaConta(h);
    expect(h.enfileirados).toHaveLength(1);

    h.ir(AGORA_MS + INTERVALO_POLL_AMAZON_MS);
    const ocioso = await umaConta(h);
    expect(ocioso.enfileiradas).toBe(0);
    expect(h.enfileirados).toHaveLength(1);

    // Near-miss: one MICROsecond later is another change.
    h.ir(AGORA_MS + 2 * INTERVALO_POLL_AMAZON_MS);
    h.responder = paginado([[linha(PEDIDO_A, iso(a, '000001'))]]);
    const mudou = await umaConta(h);
    expect(mudou.enfileiradas).toBe(1);
    expect(h.enfileirados.map((p) => p.amazonOrderId)).toEqual([PEDIDO_A, PEDIDO_A]);
  });

  it('the same order on two pages of one run is enqueued once', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    const a = CURSOR + 10 * MINUTO_MS;
    h.responder = paginado([[linha(PEDIDO_A, iso(a))], [linha(PEDIDO_A, iso(a))]]);
    const c = await umaConta(h);
    expect(c).toMatchObject({ enfileiradas: 1, paginas: 2 });
  });

  it('a reconnect to another seller is seen at once: the conta cache is evicted before each run', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    const a = CURSOR + MINUTO_MS;
    h.responder = paginado([[linha(PEDIDO_A, iso(a))]]);
    // Warms this instance's conta cache with the first seller.
    await umaConta(h);
    // The callback (on another instance) binds the conta to a new seller; this
    // instance's cached copy is still fresh by its TTL and `isFresh`.
    seedConta(h.db, ID, { nome: 'Conta Um', selling_partner_id: SPID_B });
    h.ir(AGORA_MS + INTERVALO_POLL_AMAZON_MS);
    h.responder = paginado([[linha(PEDIDO_B, iso(a + MINUTO_MS))]]);
    const c = await umaConta(h);
    // A stale copy would ask the seller query for the OLD seller (no conta ⇒ a
    // false vendedor-duplicado), or stamp the payload with it (a drop at the task).
    expect(c).toMatchObject({ desfecho: 'sucesso', enfileiradas: 1 });
    expect(h.enfileirados.map((p) => p.sellerId)).toEqual([SPID_A, SPID_B]);
  });

  it('the deadline reached MID-PAGE ⇒ the handed-off rows kept, the page re-read next tick, only the rest enqueued', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    const pagina = [
      linha(PEDIDO_A, iso(CURSOR + MINUTO_MS)),
      linha(PEDIDO_B, iso(CURSOR + 2 * MINUTO_MS)),
      linha(PEDIDO_C, iso(CURSOR + 3 * MINUTO_MS)),
    ];
    h.responder = paginado([pagina]);
    // The deadline is 180 s after the start; each enqueue costs 100 s.
    h.custoDoEnfileiramentoMs = 100_000;
    const c = await umaConta(h);
    expect(c).toMatchObject({
      desfecho: 'falha',
      motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.orcamentoEsgotado,
      enfileiradas: 2,
    });
    expect(poll(h)).toMatchObject({
      cursorMs: CURSOR,
      falhasSeguidas: 1,
      ultimoErro: 'orcamento-esgotado',
      execucaoId: null,
      // The token that FETCHED this page: page 1 of a fresh window.
      pendente: {
        paginationToken: null,
        lastUpdatedAfter: JANELA_DO_CURSOR,
        inicioDrenagemMs: AGORA_MS,
        paginas: 0,
      },
      vistos: { [PEDIDO_A]: us(CURSOR + MINUTO_MS), [PEDIDO_B]: us(CURSOR + 2 * MINUTO_MS) },
    });
    // Counted below its threshold (4): no aviso yet.
    expect(aviso(h)).toBeUndefined();

    h.ir(AGORA_MS + INTERVALO_POLL_AMAZON_MS);
    h.custoDoEnfileiramentoMs = 0;
    h.requisicoes.length = 0;
    const d = await umaConta(h);
    expect(d).toMatchObject({ desfecho: 'sucesso', enfileiradas: 1, retomada: true });
    expect(h.requisicoes[0]?.searchParams.has('paginationToken')).toBe(false);
    expect(h.enfileirados.map((p) => p.amazonOrderId)).toEqual([PEDIDO_A, PEDIDO_B, PEDIDO_C]);
    expect(poll(h)).toMatchObject({
      cursorMs: CURSOR + 3 * MINUTO_MS,
      pendente: null,
      falhasSeguidas: 0,
    });
  });

  it('the deadline reached BETWEEN pages ⇒ the stored token is the one that fetches the next page', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = paginado([
      [linha(PEDIDO_A, iso(CURSOR + MINUTO_MS))],
      [linha(PEDIDO_B, iso(CURSOR + 2 * MINUTO_MS))],
    ]);
    h.custoDoEnfileiramentoMs = 190_000;
    const c = await umaConta(h);
    expect(c).toMatchObject({ motivo: 'orcamento-esgotado', paginas: 1, enfileiradas: 1 });
    expect(h.requisicoes).toHaveLength(1);
    expect(poll(h).pendente).toMatchObject({ paginationToken: 't-1', paginas: 1 });
  });

  it('an enqueue that never resolves loses its deadline ⇒ a poll: failure document, and the drain goes on', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    const a = CURSOR + MINUTO_MS;
    const b = CURSOR + 2 * MINUTO_MS;
    h.responder = paginado([[linha(PEDIDO_A, iso(a)), linha(PEDIDO_B, iso(b))]]);
    h.enfileirar = (p) => {
      if (p.amazonOrderId !== PEDIDO_A) {
        h.enfileirados.push(p);
        return Promise.resolve();
      }
      h.dispararPrazo();
      // …and it rejects LATE: consumed, logged by class, never rethrown.
      return new Promise((_resolve, rejeitar) => {
        queueMicrotask(() => {
          rejeitar(new TypeError('tarde demais'));
        });
      });
    };
    const c = await umaConta(h);
    expect(c).toMatchObject({ desfecho: 'sucesso', enfileiradas: 1, persistidas: 1 });
    const payloadA = {
      tipo: 'pedido',
      origem: 'poll',
      sellerId: SPID_A,
      amazonOrderId: PEDIDO_A,
      contaId: ID,
      lastUpdatedUs: us(a),
    } as const;
    expect(h.db.ler(caminhoNotificacao(payloadA))).toMatchObject({
      status: 'failed',
      erro: 'enfileiramento/AmazonTarefasTransitoriasError/prazo',
      contaId: ID,
      amazonOrderId: PEDIDO_A,
    });
    // Handed off either way: the cursor may advance.
    expect(poll(h)).toMatchObject({
      cursorMs: b,
      vistos: { [PEDIDO_A]: us(a), [PEDIDO_B]: us(b) },
    });
    expect(linhasDoPoll(h)).toContainEqual(
      expect.objectContaining({ alerta: 'rejeicao-tardia', classe: 'TypeError' }),
    );
  });

  it('echoes of lastUpdatedBefore are logged as seen, never trusted', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = () =>
      respostaJson(200, { orders: [], lastUpdatedBefore: '2027-01-15T14:58:00Z' });
    const c = await umaConta(h);
    expect(c).toMatchObject({ desfecho: 'janela-vazia', lastUpdatedBeforeEcoado: true });
    expect(poll(h).cursorMs).toBe(CURSOR);
  });
});

/* ============================= a window across runs ============================= */

describe('a window drained across runs', () => {
  /** Six one-row pages after the cursor; page 0 also carries an offset-less (invalid) row. */
  const seisPaginasComLinhaInvalida = () =>
    [0, 1, 2, 3, 4, 5].map((i) => [
      linha(`111-0000000-000010${String(i)}`, iso(CURSOR + (i + 1) * 5 * MINUTO_MS)),
      ...(i === 0 ? [linha(PEDIDO_B, '2027-01-15T13:02:00')] : []),
    ]);

  it('an invalid row on page 1 still blocks the advance when ANOTHER run completes the window', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = paginado(seisPaginasComLinhaInvalida());
    const truncado = await umaConta(h);
    expect(truncado).toMatchObject({ desfecho: 'truncado', motivo: null, paginas: 5 });
    // The stored drain carries the flag across the gap.
    expect(poll(h)).toMatchObject({
      cursorMs: CURSOR,
      falhasSeguidas: 0,
      pendente: { paginationToken: 't-5', paginas: 5, linhaInvalida: true },
    });

    // The next run reads only the clean page 6 — and still counts the window.
    h.ir(AGORA_MS + HORA_MS);
    const completou = await umaConta(h);
    expect(completou).toMatchObject({
      desfecho: 'falha',
      motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida,
      retomada: true,
      paginas: 1,
      enfileiradas: 1,
    });
    expect(poll(h)).toMatchObject({
      cursorMs: CURSOR,
      pendente: null,
      falhasSeguidas: 1,
      ultimoErro: 'resposta-invalida',
    });
    expect(aviso(h)).toBeUndefined();

    // A fresh window from the KEPT cursor re-reads the row: the second count raises.
    h.ir(AGORA_MS + 2 * HORA_MS);
    await umaConta(h);
    h.ir(AGORA_MS + 3 * HORA_MS);
    const segunda = await umaConta(h);
    expect(segunda.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida);
    expect(poll(h)).toMatchObject({ cursorMs: CURSOR, falhasSeguidas: 2 });
    expect(aviso(h)).toMatchObject({ resolvidoEm: null, params: { motivo: 'resposta-invalida' } });
    expect(h.enfileirados.map((p) => p.amazonOrderId)).not.toContain(PEDIDO_B);
  });

  it('near-miss: the same six pages with every row valid advance the cursor on completion', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = paginado(seisPaginasComLinhaInvalida().map((p) => p.slice(0, 1)));
    await umaConta(h);
    expect(poll(h).pendente).toMatchObject({ linhaInvalida: false });
    h.ir(AGORA_MS + HORA_MS);
    const c = await umaConta(h);
    expect(c.desfecho).toBe('sucesso');
    expect(poll(h)).toMatchObject({ cursorMs: CURSOR + 30 * MINUTO_MS, falhasSeguidas: 0 });
  });

  it('an invalid row, then a 429 on the next page: the resumed completion still counts the row', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    const a = CURSOR + MINUTO_MS;
    const paginas = paginado([
      [linha(PEDIDO_A, iso(a)), linha('não-é-um-pedido', iso(a))],
      [linha(PEDIDO_C, iso(a + MINUTO_MS))],
    ]);
    // Page 2 is throttled ONCE.
    let limitar = true;
    h.responder = (url) => {
      if (url.searchParams.get('paginationToken') === 't-1' && limitar) {
        limitar = false;
        return respostaJson(429, { errors: [{ code: 'QuotaExceeded' }] });
      }
      return paginas(url);
    };
    const primeira = await umaConta(h);
    expect(primeira.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.limiteDeTaxa);
    expect(poll(h)).toMatchObject({
      falhasSeguidas: 1,
      pendente: { paginationToken: 't-1', linhaInvalida: true },
    });

    h.ir(AGORA_MS + INTERVALO_POLL_AMAZON_MS);
    const segunda = await umaConta(h);
    expect(segunda).toMatchObject({
      desfecho: 'falha',
      motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida,
      retomada: true,
    });
    expect(poll(h)).toMatchObject({ cursorMs: CURSOR, pendente: null, falhasSeguidas: 2 });
    expect(h.enfileirados.map((p) => p.amazonOrderId)).toEqual([PEDIDO_A, PEDIDO_C]);
  });

  it('a 400 on the SECOND request of a resumed drain is counted, and the drain stays at that token', async () => {
    const h = montar();
    contaConectada(h);
    const a = CURSOR + MINUTO_MS;
    seedPoll(h, {
      pendente: {
        paginationToken: 'tok-g',
        lastUpdatedAfter: JANELA_DO_CURSOR,
        marketplaceIds: 'A2Q3Y263D00KWC',
        inicioDrenagemMs: AGORA_MS - HORA_MS,
        tokenEmMs: AGORA_MS - HORA_MS,
        paginas: 3,
      },
    });
    h.responder = (url) =>
      url.searchParams.get('paginationToken') === 'tok-g'
        ? respostaJson(200, {
            orders: [linha(PEDIDO_A, iso(a))],
            pagination: { nextToken: 'tok-h' },
          })
        : respostaJson(400, { errors: [{ code: 'InvalidInput' }] });
    const c = await umaConta(h);
    expect(c).toMatchObject({
      desfecho: 'falha',
      motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.requisicaoRecusada,
      retomada: true,
      paginas: 1,
    });
    expect(h.requisicoes.map((u) => u.searchParams.get('paginationToken'))).toEqual([
      'tok-g',
      'tok-h',
    ]);
    expect(poll(h)).toMatchObject({
      falhasSeguidas: 1,
      ultimoErro: 'requisicao-recusada',
      cursorMs: CURSOR,
      pendente: { paginationToken: 'tok-h', paginas: 4 },
      vistos: { [PEDIDO_A]: us(a) },
    });
  });

  it('a pagination that never ends is bounded: counted at the window’s page bound, then on every tick at ZERO calls', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = (url) => {
      const token = url.searchParams.get('paginationToken');
      const i = token === null ? 0 : Number(token.slice(2));
      return respostaJson(200, { orders: [], pagination: { nextToken: `t-${String(i + 1)}` } });
    };
    const desfechos: string[] = [];
    for (let n = 0; n < 41; n += 1) {
      h.ir(AGORA_MS + n * INTERVALO_POLL_AMAZON_MS);
      desfechos.push((await umaConta(h)).desfecho);
    }
    // 40 ticks of five pages reach the bound; the 40th already counts.
    expect(desfechos.slice(0, 39).every((d) => d === 'truncado')).toBe(true);
    expect(desfechos.slice(39)).toEqual(['falha', 'falha']);
    expect(h.requisicoes).toHaveLength(200);
    expect(poll(h)).toMatchObject({
      cursorMs: CURSOR,
      falhasSeguidas: 2,
      ultimoErro: 'resposta-invalida',
      pendente: { paginationToken: 't-200', paginas: 200 },
    });
    expect(aviso(h)).toMatchObject({ resolvidoEm: null, params: { motivo: 'resposta-invalida' } });
    expect(linhasDoPoll(h)).toContainEqual(
      expect.objectContaining({ alerta: 'paginacao-sem-fim', paginas: 200, tokenRepetido: false }),
    );
  });

  it('a page announcing the very token it was asked with is a window that never ends: counted at once', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = (url) =>
      respostaJson(200, {
        orders: url.searchParams.has('paginationToken')
          ? []
          : [linha(PEDIDO_A, iso(CURSOR + MINUTO_MS))],
        pagination: { nextToken: 't-1' },
      });
    const c = await umaConta(h);
    expect(c).toMatchObject({
      desfecho: 'falha',
      motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida,
      paginas: 2,
      enfileiradas: 1,
    });
    expect(poll(h)).toMatchObject({
      cursorMs: CURSOR,
      falhasSeguidas: 1,
      pendente: { paginationToken: 't-1', paginas: 1 },
    });
    expect(linhasDoPoll(h)).toContainEqual(
      expect.objectContaining({ alerta: 'paginacao-sem-fim', tokenRepetido: true }),
    );
    // The next tick asks for that token again and gets it again: the aviso.
    h.ir(AGORA_MS + INTERVALO_POLL_AMAZON_MS);
    await umaConta(h);
    expect(poll(h).falhasSeguidas).toBe(2);
    expect(aviso(h)).toMatchObject({ params: { motivo: 'resposta-invalida' } });
  });
});

describe('the cursor candidate travels with the drain (the window’s max row, not one run’s)', () => {
  /** A row of a backlog: its order id and its stamp (ms). */
  interface Linha {
    readonly id: string;
    readonly ms: number;
  }

  /** `n` rows after the cursor, OLDEST first: row `i` is stamped `CURSOR + (i + 1) × 5 min`. */
  const backlog = (n: number, base = 200): readonly Linha[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `111-0000000-${String(base + i).padStart(7, '0')}`,
      ms: CURSOR + (i + 1) * 5 * MINUTO_MS,
    }));
  const maisNovasPrimeiro = (linhas: readonly Linha[]) => [...linhas].reverse();
  const umaPorPagina = (linhas: readonly Linha[]) => linhas.map((l) => [linha(l.id, iso(l.ms))]);

  /**
   * `searchOrders` honouring `lastUpdatedAfter`: of `linhas` (in that order),
   * only those stamped AFTER it, one per page, page `i` answered for `t-<i>`.
   */
  const porJanela =
    (linhas: readonly Linha[]) =>
    (url: URL): Response | Promise<Response> => {
      const depoisMs = Date.parse(url.searchParams.get('lastUpdatedAfter') ?? '');
      return paginado(umaPorPagina(linhas.filter((l) => l.ms > depoisMs)))(url);
    };

  const SEIS = backlog(6);

  it.each([
    // The finding: the newest row is on the FIRST run's pages.
    ['newest-first: the newest row is read by the FIRST run', maisNovasPrimeiro(SEIS), 30],
    // Near-miss: the newest row is read by the run that completes the window.
    ['oldest-first: the newest row is read by the LAST run', SEIS, 25],
  ])(
    '%s — the completion advances the cursor to it, and the next window skips the backlog',
    async (_caso, linhas, maiorDoPrimeiroRunMin) => {
      const h = montar();
      contaConectada(h);
      seedPoll(h);
      h.responder = porJanela(linhas);
      const maisNova = CURSOR + 30 * MINUTO_MS;

      expect(await umaConta(h)).toMatchObject({ desfecho: 'truncado', paginas: 5 });
      // The stored drain carries the first run's max beside its position.
      expect(poll(h)).toMatchObject({
        cursorMs: CURSOR,
        pendente: {
          paginationToken: 't-5',
          paginas: 5,
          maiorLinhaMs: CURSOR + maiorDoPrimeiroRunMin * MINUTO_MS,
        },
      });

      h.ir(AGORA_MS + HORA_MS);
      const completou = await umaConta(h);
      expect(completou).toMatchObject({
        desfecho: 'sucesso',
        retomada: true,
        paginas: 1,
        cursorAvancou: true,
      });
      expect(poll(h)).toMatchObject({ cursorMs: maisNova, pendente: null });

      // The next fresh window starts at that cursor minus the overlap: it re-reads
      // the overlap's two rows (already seen), never the backlog — one run, nothing enqueued.
      h.ir(AGORA_MS + 2 * HORA_MS);
      h.requisicoes.length = 0;
      const seguinte = await umaConta(h);
      expect(seguinte).toMatchObject({
        desfecho: 'sucesso',
        retomada: false,
        paginas: 2,
        enfileiradas: 0,
      });
      expect(h.requisicoes[0]?.searchParams.get('lastUpdatedAfter')).toBe('2027-01-15T13:20:00Z');
      expect(poll(h)).toMatchObject({ cursorMs: maisNova, pendente: null });
      expect(h.enfileirados).toHaveLength(6);
    },
  );

  it.each([
    // The finding: the second run reads only OLDER rows, so the stored max must stand.
    ['newest-first: the FIRST run reads the newest row', maisNovasPrimeiro(backlog(10, 300)), 50],
    // Its mirror: the MIDDLE run reads the newest row, so it must raise the stored max.
    ['oldest-first: the MIDDLE run reads the newest row', backlog(10, 300), 25],
  ])(
    'a window spanning THREE runs (%s): the stored max is max(stored, this run’s) and moves the cursor on the third',
    async (_caso, linhas, maiorDoPrimeiroRunMin) => {
      const h = montar();
      contaConectada(h);
      seedPoll(h);
      // Ten rows (CURSOR + 5 min … + 50 min) one per page, then an EMPTY last page.
      h.responder = paginado([...umaPorPagina(linhas), []]);
      const maisNova = CURSOR + 50 * MINUTO_MS;

      expect(await umaConta(h)).toMatchObject({ desfecho: 'truncado', paginas: 5 });
      expect(poll(h).pendente).toMatchObject({
        paginationToken: 't-5',
        maiorLinhaMs: CURSOR + maiorDoPrimeiroRunMin * MINUTO_MS,
      });

      h.ir(AGORA_MS + HORA_MS);
      expect(await umaConta(h)).toMatchObject({ desfecho: 'truncado', retomada: true, paginas: 5 });
      expect(poll(h)).toMatchObject({
        cursorMs: CURSOR,
        pendente: { paginationToken: 't-10', paginas: 10, maiorLinhaMs: maisNova },
      });

      // The third reads one EMPTY page and completes: the window itself was not empty.
      h.ir(AGORA_MS + 2 * HORA_MS);
      const completou = await umaConta(h);
      expect(completou).toMatchObject({
        desfecho: 'sucesso',
        retomada: true,
        paginas: 1,
        enfileiradas: 0,
        cursorAvancou: true,
      });
      expect(poll(h)).toMatchObject({ cursorMs: maisNova, pendente: null });
      expect(h.enfileirados).toHaveLength(10);
    },
  );

  it('the carried max is still capped at the STORED drain start − 5 min, never the completing run’s', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    // Newest-first, and the newest row is a minute before the FIRST run's start.
    const recente = { id: PEDIDO_A, ms: AGORA_MS - MINUTO_MS };
    h.responder = paginado(umaPorPagina([recente, ...maisNovasPrimeiro(backlog(5))]));

    expect(await umaConta(h)).toMatchObject({ desfecho: 'truncado' });
    expect(poll(h).pendente).toMatchObject({
      inicioDrenagemMs: AGORA_MS,
      maiorLinhaMs: recente.ms,
    });

    // An hour later: capped by the completing run's own start, the row would pass.
    h.ir(AGORA_MS + HORA_MS);
    expect(await umaConta(h)).toMatchObject({ desfecho: 'sucesso', cursorAvancou: true });
    expect(poll(h).cursorMs).toBe(AGORA_MS - 5 * MINUTO_MS);
  });

  it('a pendente stored BEFORE the field existed resumes with null: the completion advances from its own rows', async () => {
    const h = montar();
    contaConectada(h);
    // Raw, NOT through the schema: `maiorLinhaMs` is absent, as an older run stored it.
    h.db.seed(CAMINHO_POLL, {
      cursorMs: CURSOR,
      pendente: {
        paginationToken: 't-5',
        lastUpdatedAfter: JANELA_DO_CURSOR,
        marketplaceIds: 'A2Q3Y263D00KWC',
        inicioDrenagemMs: AGORA_MS - HORA_MS,
        tokenEmMs: AGORA_MS - HORA_MS,
        paginas: 5,
        linhaInvalida: false,
      },
      vistos: {},
      emExecucaoAteMs: 0,
      execucaoId: null,
      falhasSeguidas: 0,
    });
    h.responder = paginado(umaPorPagina(maisNovasPrimeiro(SEIS)));

    const c = await umaConta(h);
    expect(c).toMatchObject({ desfecho: 'sucesso', retomada: true, paginas: 1 });
    expect(h.requisicoes[0]?.searchParams.get('paginationToken')).toBe('t-5');
    // Only the oldest row (page 6) is known: what the older runs read is not.
    expect(poll(h)).toMatchObject({ cursorMs: CURSOR + 5 * MINUTO_MS, pendente: null });
  });

  it('an EXPIRED pendente (its token 23 h old) drops its running max with its window', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h, {
      pendente: {
        paginationToken: 'tok-velho',
        lastUpdatedAfter: JANELA_DO_CURSOR,
        marketplaceIds: 'A2Q3Y263D00KWC',
        inicioDrenagemMs: AGORA_MS - 23 * HORA_MS - 1,
        tokenEmMs: AGORA_MS - 23 * HORA_MS - 1,
        paginas: 5,
        maiorLinhaMs: CURSOR + 60 * MINUTO_MS,
      },
    });
    // The fresh window re-reads from the unmoved cursor: only what IT reads moves it.
    h.responder = paginado(umaPorPagina(backlog(1, 500)));

    expect(await umaConta(h)).toMatchObject({ desfecho: 'sucesso', retomada: false });
    expect(poll(h)).toMatchObject({ cursorMs: CURSOR + 5 * MINUTO_MS, pendente: null });
  });

  /*
   * Every stop before the window's end stores the running max, not only the
   * truncation: the newest row is read, the drain stops on another exit, and
   * the run completing the window reads only OLDER rows.
   */
  describe('every stop carries the running max', () => {
    /** A row stamped `CURSOR + min` minutes, its order id derived from `min`. */
    const aos = (min: number): Linha => ({
      id: `111-0000000-${String(400 + min).padStart(7, '0')}`,
      ms: CURSOR + min * MINUTO_MS,
    });
    const pagina = (...linhas: Linha[]) => linhas.map((l) => linha(l.id, iso(l.ms)));

    /** The next tick completes the window from older rows only: the cursor still reaches `maisNovaMs`. */
    const completa = async (h: Harness, maisNovaMs: number) => {
      h.custoDoEnfileiramentoMs = 0;
      h.ir(AGORA_MS + INTERVALO_POLL_AMAZON_MS);
      expect(await umaConta(h)).toMatchObject({
        desfecho: 'sucesso',
        retomada: true,
        cursorAvancou: true,
      });
      expect(poll(h)).toMatchObject({ cursorMs: maisNovaMs, pendente: null });
    };

    it('a counted page failure (a 429) after the newest row', async () => {
      const h = montar();
      contaConectada(h);
      seedPoll(h);
      const paginas = paginado([pagina(aos(15)), pagina(aos(10)), pagina(aos(5))]);
      let limitar = true;
      h.responder = (url) => {
        if (url.searchParams.get('paginationToken') === 't-1' && limitar) {
          limitar = false;
          return respostaJson(429, { errors: [{ code: 'QuotaExceeded' }] });
        }
        return paginas(url);
      };
      expect(await umaConta(h)).toMatchObject({
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.limiteDeTaxa,
      });
      expect(poll(h).pendente).toMatchObject({ paginationToken: 't-1', maiorLinhaMs: aos(15).ms });
      await completa(h, aos(15).ms);
    });

    it('the deadline BETWEEN pages after the newest row', async () => {
      const h = montar();
      contaConectada(h);
      seedPoll(h);
      h.responder = paginado([pagina(aos(10)), pagina(aos(5))]);
      // The deadline is 180 s after the start: the first enqueue spends 190 s.
      h.custoDoEnfileiramentoMs = 190_000;
      expect(await umaConta(h)).toMatchObject({
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.orcamentoEsgotado,
      });
      expect(poll(h).pendente).toMatchObject({ paginationToken: 't-1', maiorLinhaMs: aos(10).ms });
      await completa(h, aos(10).ms);
    });

    it('the deadline MID-PAGE, a page after the newest row', async () => {
      const h = montar();
      contaConectada(h);
      seedPoll(h);
      h.responder = paginado([pagina(aos(20)), pagina(aos(10), aos(5))]);
      // 100 s per enqueue: the deadline falls before page 1's SECOND row.
      h.custoDoEnfileiramentoMs = 100_000;
      expect(await umaConta(h)).toMatchObject({
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.orcamentoEsgotado,
      });
      expect(poll(h).pendente).toMatchObject({ paginationToken: 't-1', maiorLinhaMs: aos(20).ms });
      await completa(h, aos(20).ms);
    });

    it('a repeated token after the newest row, until Amazon heals', async () => {
      const h = montar();
      contaConectada(h);
      seedPoll(h);
      let curado = false;
      h.responder = (url) => {
        if (url.searchParams.get('paginationToken') === null) {
          return respostaJson(200, { orders: pagina(aos(20)), pagination: { nextToken: 't-1' } });
        }
        // `t-1` announces itself until healed; then it is the window's last page.
        if (!curado) return respostaJson(200, { orders: [], pagination: { nextToken: 't-1' } });
        return respostaJson(200, { orders: pagina(aos(5)) });
      };
      expect(await umaConta(h)).toMatchObject({
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida,
      });
      expect(poll(h).pendente).toMatchObject({ paginationToken: 't-1', maiorLinhaMs: aos(20).ms });
      curado = true;
      await completa(h, aos(20).ms);
    });
  });
});

/* ===================================== lease ===================================== */

describe('the lease (tier 1)', () => {
  it('held by another run ⇒ exit: zero calls, nothing written', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h, { emExecucaoAteMs: AGORA_MS + 1, execucaoId: 'outra' });
    const c = await umaConta(h);
    expect(c.desfecho).toBe('lease-ocupado');
    expect(h.requisicoes).toHaveLength(0);
    expect(h.lwa).toBe(0);
    expect(h.db.escritasEm(CAMINHO_POLL)).toHaveLength(0);
  });

  it('ALREADY_EXISTS on the create ⇒ exit with zero calls', async () => {
    const h = montar();
    contaConectada(h);
    h.db.antesDaProximaEscrita(CAMINHO_POLL, () => {
      seedPoll(h, { emExecucaoAteMs: AGORA_MS + 1, execucaoId: 'outra' });
    });
    const c = await umaConta(h);
    expect(c.desfecho).toBe('lease-ocupado');
    expect(h.requisicoes).toHaveLength(0);
    expect(poll(h).execucaoId).toBe('outra');
  });

  it('FAILED_PRECONDITION on the expired-lease update ⇒ exit with zero calls (the update carries the stamp)', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.db.antesDaProximaEscrita(CAMINHO_POLL, () => {
      seedPoll(h, { emExecucaoAteMs: AGORA_MS + 1, execucaoId: 'outra' });
    });
    const c = await umaConta(h);
    expect(c.desfecho).toBe('lease-ocupado');
    expect(h.requisicoes).toHaveLength(0);
    expect(poll(h).execucaoId).toBe('outra');

    // Near-miss: with no race, the lease update lands — WITH its precondition.
    const g = montar();
    contaConectada(g);
    seedPoll(g);
    await umaConta(g);
    const [lease] = g.db.escritasEm(CAMINHO_POLL);
    expect(lease).toMatchObject({ verbo: 'update', comPrecondicao: true });
    expect(lease?.dados).toMatchObject({ execucaoId: 'exec-1' });
  });

  it('the bootstrap is anchored once, in the create, and NOT re-anchored by later failing runs', async () => {
    const h = montar();
    contaConectada(h);
    h.responder = () => respostaJson(503, { errors: [{ code: 'ServiceUnavailable' }] });
    await umaConta(h);
    expect(poll(h)).toMatchObject({ cursorMs: BOOTSTRAP, falhasSeguidas: 1 });
    h.ir(AGORA_MS + INTERVALO_POLL_AMAZON_MS);
    await umaConta(h);
    expect(poll(h)).toMatchObject({ cursorMs: BOOTSTRAP, falhasSeguidas: 2 });
    expect(h.requisicoes.map((u) => u.searchParams.get('lastUpdatedAfter'))).toEqual([
      JANELA_DO_BOOTSTRAP,
      JANELA_DO_BOOTSTRAP,
    ]);
  });

  it('W7 (cursorMs deleted) + an expired lease ⇒ the lease UPDATE anchors it exactly once; no window from a null cursor', async () => {
    const h = montar();
    contaConectada(h);
    h.db.seed(CAMINHO_POLL, {
      emExecucaoAteMs: AGORA_MS - 1,
      execucaoId: 'velha',
      falhasSeguidas: 2,
      ultimoErro: 'falha-transitoria',
      ultimaVarreduraEmMs: AGORA_MS - HORA_MS,
    });
    h.responder = () => respostaJson(503, {});
    await umaConta(h);
    const [lease] = h.db.escritasEm(CAMINHO_POLL);
    expect(lease).toMatchObject({ verbo: 'update', comPrecondicao: true });
    expect(lease?.dados?.cursorMs).toBe(BOOTSTRAP);
    expect(poll(h).cursorMs).toBe(BOOTSTRAP);
    expect(h.requisicoes[0]?.searchParams.get('lastUpdatedAfter')).toBe(JANELA_DO_BOOTSTRAP);

    // A failing run after that does not slide it.
    h.ir(AGORA_MS + INTERVALO_POLL_AMAZON_MS);
    await umaConta(h);
    expect(poll(h).cursorMs).toBe(BOOTSTRAP);
    expect(h.db.escritasEm(CAMINHO_POLL)[2]?.dados).not.toHaveProperty('cursorMs');
  });

  it('the final write loses to ANOTHER run’s lease ⇒ nothing written (and no aviso)', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = () => respostaJson(400, {});
    h.db.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
    h.db.antesDaProximaEscrita(CAMINHO_POLL, () => {
      seedPoll(h, { emExecucaoAteMs: AGORA_MS + LEASE_FUTURO, execucaoId: 'outra' });
    });
    const c = await umaConta(h);
    expect(c.desfecho).toBe('lease-perdido');
    expect(poll(h)).toMatchObject({ execucaoId: 'outra', falhasSeguidas: 0 });
    expect(aviso(h)).toBeUndefined();
    expect(linhasDoPoll(h)).toContainEqual(expect.objectContaining({ alerta: 'lease-perdido' }));
  });

  it('the final write loses while STILL ours ⇒ re-derived from the re-read and retried once', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = () => respostaJson(503, {});
    h.db.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
    h.db.antesDaProximaEscrita(CAMINHO_POLL, () => {
      const atual = h.db.ler(CAMINHO_POLL) ?? {};
      h.db.seed(CAMINHO_POLL, { ...atual, falhasSeguidas: 3 });
    });
    const c = await umaConta(h);
    expect(c.desfecho).toBe('falha');
    // 3 (the re-read) + 1 — never the lease's 0 + 1 re-applied.
    expect(poll(h)).toMatchObject({ falhasSeguidas: 4, execucaoId: null });
    expect(h.db.escritasEm(CAMINHO_POLL)).toHaveLength(2);
    // The aviso reads the count AS STORED: 4 reaches falha-transitoria's threshold.
    expect(aviso(h)).toMatchObject({ resolvidoEm: null, params: { motivo: 'falha-transitoria' } });
  });

  it('the re-derive identity: the same token with another tokenEmMs is NOT ours — our pendente is not applied', async () => {
    const guardado = {
      paginationToken: 'tok-g',
      lastUpdatedAfter: JANELA_DO_CURSOR,
      marketplaceIds: 'A2Q3Y263D00KWC',
      inicioDrenagemMs: AGORA_MS - HORA_MS,
      tokenEmMs: AGORA_MS - HORA_MS,
      paginas: 5,
      linhaInvalida: false,
      maiorLinhaMs: null as number | null,
    };
    const rodar = async (outro: typeof guardado, extra: Record<string, unknown> = {}) => {
      const h = montar();
      contaConectada(h);
      seedPoll(h, { pendente: guardado });
      // A 400 on the resumed page: this run wants `pendente: null`.
      h.responder = () => respostaJson(400, {});
      h.db.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
      h.db.antesDaProximaEscrita(CAMINHO_POLL, () => {
        const atual = h.db.ler(CAMINHO_POLL) ?? {};
        h.db.seed(CAMINHO_POLL, { ...atual, pendente: outro, ...extra });
      });
      await umaConta(h);
      return poll(h);
    };
    const outroDreno = await rodar({ ...guardado, tokenEmMs: guardado.tokenEmMs + 1 });
    expect(outroDreno.pendente).toEqual({ ...guardado, tokenEmMs: guardado.tokenEmMs + 1 });
    expect(outroDreno.execucaoId).toBeNull();
    // Near-miss: the SAME pendente (both scalars equal) re-read ⇒ ours is applied.
    const mesmo = await rodar(guardado, { ultimaVarreduraEmMs: 1 });
    expect(mesmo.pendente).toBeNull();
    // The two ACCUMULATORS are not identity: both scalars equal with another
    // flag and another running max is still the drain the lease read ⇒ ours.
    const acumulado = await rodar({ ...guardado, linhaInvalida: true, maiorLinhaMs: CURSOR });
    expect(acumulado.pendente).toBeNull();
  });
});

const LEASE_FUTURO = 10 * MINUTO_MS;

/* ===================================== errors ===================================== */

describe('errors → motivo', () => {
  it('an LWA refusal mid-drain PARKS the conta: nothing counted, the STORED vistos kept (this run’s dropped)', async () => {
    const h = montar();
    seedConta(h.db, ID, { nome: 'Conta Um', selling_partner_id: SPID_A });
    // Fresh at the start; a 10-s page pushes it under the 60-s refresh margin.
    seedCredencial(h.db, ID, { expirationDate: AGORA_MS + 65_000 });
    seedPoll(h, { vistos: { '999-0000000-0000009': us(CURSOR) } });
    h.latenciaMs = 10_000;
    h.responder = paginado([[linha(PEDIDO_A, iso(CURSOR + MINUTO_MS))], []]);
    h.respostaLwa = () => erroLwa(400, 'invalid_grant');
    const c = await umaConta(h);
    expect(c).toMatchObject({ desfecho: 'conta-parada', motivo: null, enfileiradas: 1 });
    expect(h.lwa).toBe(1);
    expect(poll(h)).toMatchObject({
      falhasSeguidas: 0,
      cursorMs: CURSOR,
      pendente: null,
      execucaoId: null,
      vistos: { '999-0000000-0000009': us(CURSOR) },
    });
    expect(h.db.ler(caminhoCredencial(ID))?.reconexaoPendente).toMatchObject({ status: 400 });
    expect(h.db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({ resolvidoEm: null });
    expect(aviso(h)).toBeUndefined();
  });

  it('an SP-API 401 that survives ONE forced refresh ⇒ sem-permissao (aviso at once), never a park', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = () => respostaJson(401, { errors: [{ code: 'Unauthorized' }] });
    const c = await umaConta(h);
    expect(c.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.semPermissao);
    expect(h.requisicoes).toHaveLength(2);
    expect(h.lwa).toBe(1);
    expect(h.db.ler(caminhoCredencial(ID))?.reconexaoPendente).toBeNull();
    expect(aviso(h)).toMatchObject({ resolvidoEm: null, params: { motivo: 'sem-permissao' } });
  });

  it('429 ⇒ limite-de-taxa: the conta stops, NO inline sleep, pendente kept; the aviso at the 4th', async () => {
    const h = montar();
    contaConectada(h);
    const guardado = {
      paginationToken: 'tok-g',
      lastUpdatedAfter: JANELA_DO_CURSOR,
      marketplaceIds: 'A2Q3Y263D00KWC',
      inicioDrenagemMs: AGORA_MS - HORA_MS,
      tokenEmMs: AGORA_MS - HORA_MS,
      paginas: 3,
    };
    seedPoll(h, { pendente: guardado });
    h.responder = () => respostaJson(429, { errors: [{ code: 'QuotaExceeded' }] });
    for (let n = 1; n <= 4; n += 1) {
      h.ir(AGORA_MS + (n - 1) * INTERVALO_POLL_AMAZON_MS);
      const c = await umaConta(h);
      expect(c.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.limiteDeTaxa);
      expect(poll(h)).toMatchObject({ falhasSeguidas: n, pendente: guardado, cursorMs: CURSOR });
      if (n < LIMIAR_AVISO_IMPORTACAO_PARADA_AMAZON['limite-de-taxa']) {
        expect(aviso(h), String(n)).toBeUndefined();
      }
    }
    expect(h.esperas).toEqual([]);
    expect(h.requisicoes).toHaveLength(4);
    expect(aviso(h)).toMatchObject({ resolvidoEm: null, params: { motivo: 'limite-de-taxa' } });
  });

  it.each([
    ['a 5xx', () => respostaJson(500, { errors: [{ code: 'InternalFailure' }] })],
    [
      'the network',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('%s ⇒ falha-transitoria, counted', async (_caso, responder) => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = responder;
    const c = await umaConta(h);
    expect(c.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria);
    expect(poll(h)).toMatchObject({ falhasSeguidas: 1, ultimoErro: 'falha-transitoria' });
  });

  it('the per-call timeout ⇒ falha-transitoria', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = (_url, init) =>
      new Promise((_resolve, rejeitar) => {
        init?.signal?.addEventListener('abort', () => {
          rejeitar(init.signal?.reason);
        });
      });
    const corrida = umaConta(h);
    await vi.advanceTimersByTimeAsync(20_000);
    const c = await corrida;
    expect(c.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria);
  });

  it('the park losing its precondition three times (EstacionamentoAmazonEmConflitoError) ⇒ falha-transitoria', async () => {
    const h = montar();
    seedConta(h.db, ID, { nome: 'Conta Um', selling_partner_id: SPID_A });
    seedCredencial(h.db, ID, { expirationDate: AGORA_MS - 1 });
    seedPoll(h);
    h.respostaLwa = () => erroLwa(400, 'invalid_grant');
    for (let i = 0; i < 3; i += 1) {
      h.db.antesDaProximaEscrita(caminhoCredencial(ID), () => {
        h.db.seed(caminhoCredencial(ID), credencialDoc({ expirationDate: AGORA_MS - 1 }));
      });
    }
    const c = await umaConta(h);
    expect(c.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria);
  });

  it('a page outside its schema ⇒ resposta-invalida, the aviso at the SECOND', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = () => respostaJson(200, { pedidos: [] });
    await umaConta(h);
    expect(poll(h)).toMatchObject({ falhasSeguidas: 1, ultimoErro: 'resposta-invalida' });
    expect(aviso(h)).toBeUndefined();
    h.ir(AGORA_MS + INTERVALO_POLL_AMAZON_MS);
    await umaConta(h);
    expect(aviso(h)).toMatchObject({ params: { motivo: 'resposta-invalida' } });
  });

  it('an invalid row is counted and blocks the advance; the valid rows still go', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    const a = CURSOR + MINUTO_MS;
    h.responder = paginado([
      [
        linha(PEDIDO_A, iso(a)),
        linha('não-é-um-pedido', iso(a)),
        linha(PEDIDO_B, '2027-01-15T13:02:00'),
      ],
    ]);
    const c = await umaConta(h);
    expect(c).toMatchObject({
      motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida,
      enfileiradas: 1,
    });
    expect(poll(h)).toMatchObject({
      cursorMs: CURSOR,
      pendente: null,
      vistos: { [PEDIDO_A]: us(a) },
    });
  });

  it('our own misconfiguration is rethrown: the LWA pair missing fails the tick, nothing written', async () => {
    const h = montar();
    contaConectada(h);
    const ambiente = { ...AMBIENTE_LIGADO, AMAZON_LWA_CLIENT_SECRET: undefined };
    await expect(tick(h, { ambiente })).rejects.toBeInstanceOf(ConfigAmazonAusenteError);
    expect(h.db.ler(CAMINHO_POLL)).toBeUndefined();
    expect(h.requisicoes).toHaveLength(0);
  });

  it('a package config error leaves SANITIZED (class + motivo, no cause); the lease simply expires', async () => {
    const h = montar();
    seedConta(h.db, ID, { nome: 'Conta Um', selling_partner_id: SPID_A });
    seedCredencial(h.db, ID, { access_token: 'tok|TESTE\nquebrado' });
    seedPoll(h);
    const erro = await tick(h).then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(FalhaTarefaAmazonError);
    expect(erro).toMatchObject({ classe: 'AmazonConfigError', detalhe: 'token' });
    expect((erro as Error).cause).toBeUndefined();
    expect(poll(h)).toMatchObject({ execucaoId: 'exec-1', cursorMs: CURSOR, falhasSeguidas: 0 });
    expect(h.db.escritasEm(CAMINHO_POLL)).toHaveLength(1);
  });

  it('a bug in the producer is rethrown untouched', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = paginado([[linha(PEDIDO_A, iso(CURSOR + MINUTO_MS))]]);
    const bug = new RangeError('bug');
    h.enfileirar = () => Promise.reject(bug);
    await expect(tick(h)).rejects.toBe(bug);
  });

  it('an app-secret refusal (invalid_client) ABORTS the tick after its conta’s final write', async () => {
    const h = montar();
    for (const [id, spid, nome] of [
      ['conta-a', SPID_A, 'Conta A'],
      ['conta-b', SPID_B, 'Conta B'],
    ] as const) {
      seedConta(h.db, id, { nome, selling_partner_id: spid });
      seedCredencial(h.db, id, { expirationDate: AGORA_MS - 1 });
    }
    h.respostaLwa = () => erroLwa(401, 'invalid_client');
    const r = await tick(h);
    const [primeira] = ordemDoTickAmazon(['conta-a', 'conta-b'], AGORA_MS);
    expect(r.abortado).toBe('segredo-recusado');
    expect(r.contas.map((c) => [c.integracaoId, c.desfecho])).toEqual([
      [primeira, 'segredo-recusado'],
    ]);
    expect(h.lwa).toBe(1);
    expect(h.db.ler(caminhoAviso(chaveSegredoRecusado()))).toMatchObject({ resolvidoEm: null });
    expect(poll(h, `pollPedidosAmazon/${primeira ?? ''}`)).toMatchObject({
      execucaoId: null,
      falhasSeguidas: 0,
    });
    const outra = primeira === 'conta-a' ? 'conta-b' : 'conta-a';
    expect(h.db.ler(`pollPedidosAmazon/${outra}`)).toBeUndefined();
  });
});

/* ===================================== enqueue ===================================== */

describe('the enqueue', () => {
  it('a named transient ⇒ a poll: failure document (handed off), and the cursor may advance', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    const a = CURSOR + MINUTO_MS;
    h.responder = paginado([[linha(PEDIDO_A, iso(a))]]);
    h.enfileirar = () => rejeicaoDoTransporte(falhaDoFunctions('unavailable', 503));
    const c = await umaConta(h);
    expect(c).toMatchObject({ desfecho: 'sucesso', persistidas: 1, enfileiradas: 0 });
    const docs = h.db.caminhos().filter((p) => p.startsWith(`${COLECAO_NOTIFICACOES}/poll:`));
    expect(docs).toEqual([`${COLECAO_NOTIFICACOES}/poll:${ID}:${PEDIDO_A}:${String(us(a))}`]);
    expect(h.db.ler(docs[0] ?? '')?.erro).toBe(
      'enfileiramento/AmazonTarefasTransitoriasError/functions/unavailable',
    );
    expect(poll(h)).toMatchObject({ cursorMs: a, vistos: { [PEDIDO_A]: us(a) } });
  });

  it('a DEPLOY-shaped failure (the SDK class, no httpResponse) ⇒ fila-indisponivel: no advance, no handoff, the aviso at once', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = paginado([[linha(PEDIDO_A, iso(CURSOR + MINUTO_MS))]]);
    h.enfileirar = () =>
      rejeicaoDoTransporte(
        new FirebaseFunctionsError({ code: 'permission-denied', message: 'sem permissão' }),
      );
    const c = await umaConta(h);
    expect(c).toMatchObject({
      desfecho: 'falha',
      motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.filaIndisponivel,
      persistidas: 0,
    });
    expect(h.db.caminhos().some((p) => p.startsWith(`${COLECAO_NOTIFICACOES}/`))).toBe(false);
    expect(poll(h)).toMatchObject({ cursorMs: CURSOR, vistos: {}, falhasSeguidas: 1 });
    expect(aviso(h)).toMatchObject({ params: { motivo: 'fila-indisponivel' } });
    expect(linhasDoPoll(h)).toContainEqual(
      expect.objectContaining({
        alerta: 'fila-indisponivel',
        classe: 'FirebaseFunctionsError/functions/permission-denied',
      }),
    );
  });

  it('a failed persist ⇒ the run aborts with nothing more written (the lease expires)', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    const a = CURSOR + MINUTO_MS;
    h.responder = paginado([[linha(PEDIDO_A, iso(a))]]);
    h.enfileirar = () => rejeicaoDoTransporte(falhaDoFunctions('unavailable', 503));
    h.db.falharEscrita(
      `${COLECAO_NOTIFICACOES}/poll:${ID}:${PEDIDO_A}:${String(us(a))}`,
      grpc(14, 'UNAVAILABLE'),
    );
    const c = await umaConta(h);
    expect(c).toMatchObject({ desfecho: 'erro-firestore', codigoGrpc: 14 });
    expect(poll(h)).toMatchObject({ execucaoId: 'exec-1', cursorMs: CURSOR, vistos: {} });
    expect(h.db.escritasEm(CAMINHO_POLL)).toHaveLength(1);
  });

  it('a missing queue region (MissingRegionError) is deploy-shaped too ⇒ fila-indisponivel', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = paginado([[linha(PEDIDO_A, iso(CURSOR + MINUTO_MS))]]);
    h.enfileirar = () =>
      Promise.reject(new MissingRegionError('região ausente', ['AMAZON_TASKS_REGION']));
    const c = await umaConta(h);
    expect(c.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.filaIndisponivel);
    expect(poll(h)).toMatchObject({ cursorMs: CURSOR, vistos: {} });
    expect(linhasDoPoll(h)).toContainEqual(
      expect.objectContaining({ alerta: 'fila-indisponivel', classe: 'MissingRegionError' }),
    );
  });
});

/* ===================================== refusals ===================================== */

describe('refusals — a counted record, no lease, aviso at once', () => {
  it('two active contas on ONE seller ⇒ neither is polled, both record vendedor-duplicado', async () => {
    const h = montar();
    contaConectada(h, 'conta-a', SPID_A, 'Conta A');
    contaConectada(h, 'conta-b', SPID_A, 'Conta B');
    const r = await tick(h);
    expect(r.contas.map((c) => c.motivo)).toEqual(['vendedor-duplicado', 'vendedor-duplicado']);
    expect(h.requisicoes).toHaveLength(0);
    for (const id of ['conta-a', 'conta-b']) {
      expect(poll(h, `pollPedidosAmazon/${id}`)).toMatchObject({
        falhasSeguidas: 1,
        ultimoErro: 'vendedor-duplicado',
        cursorMs: null,
        execucaoId: null,
      });
      expect(aviso(h, id)).toMatchObject({ params: { motivo: 'vendedor-duplicado' } });
    }
  });

  it('an invalid look-back refuses a CURSORLESS conta — never the default; a conta with a cursor still polls', async () => {
    const ambiente = { ...AMBIENTE_LIGADO, [LOOKBACK_POLL_ENV_AMAZON]: '1e2' };
    const h = montar();
    contaConectada(h);
    const c = await umaConta(h, { ambiente });
    expect(c.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.lookbackInvalido);
    expect(h.requisicoes).toHaveLength(0);
    expect(poll(h)).toMatchObject({ cursorMs: null, falhasSeguidas: 1 });

    const g = montar();
    contaConectada(g);
    seedPoll(g);
    const d = await umaConta(g, { ambiente });
    expect(d.desfecho).toBe('janela-vazia');
  });

  it('a valid look-back anchors the bootstrap at now − H', async () => {
    const h = montar();
    contaConectada(h);
    await umaConta(h, { ambiente: { ...AMBIENTE_LIGADO, [LOOKBACK_POLL_ENV_AMAZON]: '72' } });
    expect(poll(h).cursorMs).toBe(AGORA_MS - 72 * HORA_MS);
  });

  it('the credential missing, or unreadable, on a connected conta ⇒ its refusal; zero requests', async () => {
    const h = montar();
    seedConta(h.db, ID, { nome: 'Conta Um', selling_partner_id: SPID_A });
    const c = await umaConta(h);
    expect(c.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.credencialAusente);
    const g = montar();
    seedConta(g.db, ID, { nome: 'Conta Um', selling_partner_id: SPID_A });
    seedCredencial(g.db, ID, { refresh_token: 42 });
    const d = await umaConta(g);
    expect(d.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.credencialInvalida);
    expect([...h.requisicoes, ...g.requisicoes]).toHaveLength(0);
  });

  it('a conta id outside the grammar ⇒ id-de-conta-invalido, before any context', async () => {
    const h = montar();
    contaConectada(h, 'conta.1');
    const c = await umaConta(h);
    expect(c.motivo).toBe(MOTIVO_IMPORTACAO_PARADA_AMAZON.idDeContaInvalido);
    expect(poll(h, 'pollPedidosAmazon/conta.1')).toMatchObject({ falhasSeguidas: 1 });
    expect(h.lwa).toBe(0);
  });

  it('on an EXISTING poll document with a free lease: ONE preconditioned update of the counter alone', async () => {
    const h = montar();
    // Connected, but its credential is gone.
    seedConta(h.db, ID, { nome: 'Conta Um', selling_partner_id: SPID_A });
    const pendente = {
      paginationToken: 'tok-g',
      lastUpdatedAfter: JANELA_DO_CURSOR,
      marketplaceIds: 'A2Q3Y263D00KWC',
      inicioDrenagemMs: AGORA_MS - HORA_MS,
      tokenEmMs: AGORA_MS - HORA_MS,
      paginas: 2,
    };
    const vistos = { [PEDIDO_A]: us(CURSOR) };
    // An EXPIRED lease is a free one; the refusal never touches it.
    seedPoll(h, {
      falhasSeguidas: 2,
      ultimoErro: 'falha-transitoria',
      vistos,
      pendente,
      emExecucaoAteMs: AGORA_MS - 1,
      execucaoId: 'velha',
    });
    const c = await umaConta(h);
    expect(c).toMatchObject({ desfecho: 'recusa', motivo: 'credencial-ausente' });
    const escritas = h.db.escritasEm(CAMINHO_POLL);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]).toMatchObject({ verbo: 'update', comPrecondicao: true });
    expect(Object.keys(escritas[0]?.dados ?? {}).sort()).toEqual([
      'falhasSeguidas',
      'ultimaVarreduraEmMs',
      'ultimoErro',
    ]);
    expect(poll(h)).toEqual(
      pollPedidosAmazonSchema.parse({
        cursorMs: CURSOR,
        pendente,
        vistos,
        emExecucaoAteMs: AGORA_MS - 1,
        execucaoId: 'velha',
        falhasSeguidas: 3,
        ultimoErro: 'credencial-ausente',
        ultimaVarreduraEmMs: AGORA_MS,
      }),
    );
    // Clocked by THAT write's commit time.
    const commit = escritas[0]?.writeTime;
    expect(aviso(h)).toMatchObject({
      params: { motivo: 'credencial-ausente' },
      relogioEvento:
        (commit?.seconds ?? 0) * 1_000_000 + Math.floor((commit?.nanoseconds ?? 0) / 1000),
    });
  });

  it('a refusal update that LOSES its precondition is deferred: nothing written, no aviso', async () => {
    const h = montar();
    seedConta(h.db, ID, { nome: 'Conta Um', selling_partner_id: SPID_A });
    seedPoll(h, { falhasSeguidas: 2 });
    // Another writer lands between the read and the update.
    h.db.antesDaProximaEscrita(CAMINHO_POLL, () => {
      seedPoll(h, { falhasSeguidas: 2, ultimaVarreduraEmMs: 1 });
    });
    const c = await umaConta(h);
    expect(c).toMatchObject({ desfecho: 'recusa-adiada', motivo: 'credencial-ausente' });
    expect(h.db.escritasEm(CAMINHO_POLL)).toHaveLength(0);
    expect(poll(h)).toMatchObject({ falhasSeguidas: 2, ultimoErro: null });
    expect(aviso(h)).toBeUndefined();
  });

  it('a refusal that persists counts from the STORED count: two duplicate-seller ticks ⇒ 2', async () => {
    const h = montar();
    contaConectada(h, 'conta-a', SPID_A, 'Conta A');
    contaConectada(h, 'conta-b', SPID_A, 'Conta B');
    await tick(h);
    h.ir(AGORA_MS + INTERVALO_POLL_AMAZON_MS);
    await tick(h);
    for (const id of ['conta-a', 'conta-b']) {
      const caminho = `pollPedidosAmazon/${id}`;
      expect(poll(h, caminho)).toMatchObject({
        falhasSeguidas: 2,
        ultimoErro: 'vendedor-duplicado',
      });
      expect(h.db.escritasEm(caminho).map((e) => [e.verbo, e.comPrecondicao])).toEqual([
        ['create', false],
        ['update', true],
      ]);
    }
  });

  it('a stored seller id outside its grammar ⇒ vendedor-invalido, contained to that conta; no seller query, no request', async () => {
    const h = montar();
    // Only a hand edit or a legacy row stores one: the callback refuses it.
    contaConectada(h, 'conta-a', 'A seller', 'Conta A');
    contaConectada(h, 'conta-b', SPID_B, 'Conta B');
    seedPoll(h, {}, 'pollPedidosAmazon/conta-b');
    const r = await tick(h);
    expect(
      Object.fromEntries(r.contas.map((c) => [c.integracaoId, [c.desfecho, c.motivo]])),
    ).toEqual({
      'conta-a': ['recusa', 'vendedor-invalido'],
      'conta-b': ['janela-vazia', null],
    });
    expect(poll(h, 'pollPedidosAmazon/conta-a')).toMatchObject({
      falhasSeguidas: 1,
      ultimoErro: 'vendedor-invalido',
      cursorMs: null,
    });
    expect(aviso(h, 'conta-a')).toMatchObject({ params: { motivo: 'vendedor-invalido' } });
    expect(h.db.consultas.some((q) => q.filtros.some(([, valor]) => valor === 'A seller'))).toBe(
      false,
    );
    // Near-miss: a valid seller id is polled (one request, for conta-b only).
    expect(h.requisicoes).toHaveLength(1);
  });

  it('a refusal while another run holds the lease is deferred: nothing written', async () => {
    const h = montar();
    contaConectada(h, 'conta-a', SPID_A, 'Conta A');
    contaConectada(h, 'conta-b', SPID_A, 'Conta B');
    seedPoll(
      h,
      { emExecucaoAteMs: AGORA_MS + 1, execucaoId: 'outra' },
      'pollPedidosAmazon/conta-a',
    );
    const r = await tick(h);
    const a = r.contas.find((c) => c.integracaoId === 'conta-a');
    expect(a?.desfecho).toBe('recusa-adiada');
    expect(h.db.escritasEm('pollPedidosAmazon/conta-a')).toHaveLength(0);
  });

  it('inactive, unconnected and parked contas are skipped with nothing written', async () => {
    const h = montar();
    seedConta(h.db, 'inativa', { nome: 'Inativa', selling_partner_id: SPID_A, ativo: false });
    seedConta(h.db, 'solta', { nome: 'Solta', selling_partner_id: null });
    seedConta(h.db, 'parada', { nome: 'Parada', selling_partner_id: SPID_B });
    seedCredencial(h.db, 'parada', {
      reconexaoPendente: {
        desdeMs: AGORA_MS - HORA_MS,
        status: 400,
        codigoLwa: 'invalid_grant',
        refCredencial: refDe(REFRESH_TOKEN_A, AUTORIZADO_EM_MS),
      },
    });
    const r = await tick(h);
    expect(Object.fromEntries(r.contas.map((c) => [c.integracaoId, c.desfecho]))).toEqual({
      inativa: 'inativa',
      solta: 'nao-conectada',
      parada: 'conta-parada',
    });
    expect(h.db.caminhos().filter((p) => p.startsWith('pollPedidosAmazon/'))).toEqual([]);
    // An inactive conta writes no line at all (it is skipped every tick).
    expect(linhasDoPoll(h).map((l) => l.conta)).not.toContain('inativa');
  });
});

/* ===================================== the aviso ===================================== */

describe('the aviso', () => {
  it('pins the per-motivo thresholds', () => {
    expect(LIMIAR_AVISO_IMPORTACAO_PARADA_AMAZON).toEqual({
      'id-de-conta-invalido': 1,
      'credencial-ausente': 1,
      'credencial-invalida': 1,
      'vendedor-duplicado': 1,
      'vendedor-invalido': 1,
      'lookback-invalido': 1,
      'sem-permissao': 1,
      'requisicao-recusada': 1,
      'fila-indisponivel': 1,
      'resposta-invalida': 2,
      'limite-de-taxa': 4,
      'falha-transitoria': 4,
      'orcamento-esgotado': 4,
    });
  });

  it('is raised ONLY after the final write landed: a final write that fails ⇒ no raise', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = () => respostaJson(400, {});
    h.db.antesDaProximaEscrita(CAMINHO_POLL, () => undefined);
    h.db.antesDaProximaEscrita(CAMINHO_POLL, () => {
      throw grpc(14, 'UNAVAILABLE');
    });
    const c = await umaConta(h);
    expect(c).toMatchObject({ desfecho: 'erro-firestore', codigoGrpc: 14 });
    expect(aviso(h)).toBeUndefined();
  });

  it('is raised critico on the conta page, clocked by the LEASE’s commit time', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = () => respostaJson(400, {});
    await umaConta(h);
    const [lease] = h.db.escritasEm(CAMINHO_POLL);
    const commit = lease?.writeTime;
    expect(aviso(h)).toMatchObject({
      tipo: TIPO_AVISO.amazonImportacaoParada,
      severidade: 'critico',
      canal: 'amazon',
      params: { loja: 'Conta Um', motivo: 'requisicao-recusada' },
      urlInterna: { rota: `/canais/amazon/${ID}`, campo: null },
      relogioEvento:
        (commit?.seconds ?? 0) * 1_000_000 + Math.floor((commit?.nanoseconds ?? 0) / 1000),
    });
  });

  it('a clean run over a stored count above 0 resolves it and resets the count', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h, { falhasSeguidas: 2, ultimoErro: 'resposta-invalida' });
    await levantarImportacaoParadaAmazon(
      asDb(h.db),
      {
        integracaoId: ID,
        lojaNome: 'Conta Um',
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida,
        commit: { seconds: 1, nanoseconds: 0 },
      },
      { increment, nowMs: AGORA_MS },
    );
    const c = await umaConta(h);
    expect(c.desfecho).toBe('janela-vazia');
    expect(aviso(h)).toMatchObject({ resolucaoMotivo: 'importacao-retomada' });
    expect(aviso(h)?.resolvidoEm).not.toBeNull();
    expect(poll(h)).toMatchObject({ falhasSeguidas: 0, ultimoErro: null });
  });

  it('near-miss: a clean run over a count of 0 never touches the aviso', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    await umaConta(h);
    expect(h.db.escritasEm(caminhoAviso(chaveImportacaoParada(ID)))).toHaveLength(0);
  });

  it('a resolve that FAILED leaves the count, so the next clean run resolves again', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h, { falhasSeguidas: 2, ultimoErro: 'resposta-invalida' });
    await levantarImportacaoParadaAmazon(
      asDb(h.db),
      {
        integracaoId: ID,
        lojaNome: 'Conta Um',
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida,
        commit: { seconds: 1, nanoseconds: 0 },
      },
      { increment, nowMs: AGORA_MS },
    );
    h.db.falharEscrita(caminhoAviso(chaveImportacaoParada(ID)), grpc(14, 'UNAVAILABLE'));
    await umaConta(h);
    expect(poll(h)).toMatchObject({ falhasSeguidas: 2 });
    expect(linhasDoPoll(h)).toContainEqual(
      expect.objectContaining({ alerta: 'aviso-nao-gravado', passo: 'resolver' }),
    );
  });
});

/* ===================================== the log ===================================== */

describe('the lines', () => {
  it('one line per conta run, and never the seller id', async () => {
    const h = montar();
    contaConectada(h);
    seedPoll(h);
    h.responder = paginado([[linha(PEDIDO_A, iso(CURSOR + MINUTO_MS))]]);
    await umaConta(h);
    const contas = linhasDoPoll(h).filter((l) => l.desfecho !== undefined);
    expect(contas).toEqual([
      expect.objectContaining({
        evento: 'poll',
        conta: ID,
        fluxo: 'poll',
        desfecho: 'sucesso',
        enfileiradas: 1,
        persistidas: 0,
        paginas: 1,
        retomada: false,
        cursorAvancou: true,
      }),
    ]);
    expect(JSON.stringify(h.log.linhas)).not.toContain(SPID_A);
  });

  it('resumirTickPollAmazon is FLAT: one key per desfecho, primitives only', () => {
    const conta = (desfecho: ResultadoContaPollAmazon['desfecho'], enfileiradas = 0) =>
      ({
        integracaoId: 'x',
        desfecho,
        motivo: null,
        enfileiradas,
        persistidas: 1,
        paginas: 0,
        retomada: false,
        cursorAvancou: false,
        lastUpdatedBeforeEcoado: false,
        codigoGrpc: null,
      }) satisfies ResultadoContaPollAmazon;
    const resumo = resumirTickPollAmazon({
      portao: null,
      abortado: null,
      contas: [conta('sucesso', 2), conta('sucesso', 1), conta('falha')],
    });
    expect(resumo).toEqual({
      portao: null,
      abortado: null,
      contas: 3,
      enfileiradas: 3,
      persistidas: 3,
      desfecho_sucesso: 2,
      desfecho_falha: 1,
    });
    for (const v of Object.values(resumo)) expect(typeof v === 'object' && v !== null).toBe(false);
  });
});
