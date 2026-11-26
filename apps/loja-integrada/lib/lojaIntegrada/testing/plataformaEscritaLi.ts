/**
 * A stateful Loja Integrada for the write suites, **for tests only** (the
 * `fakeDb.ts` rule: nothing outside a `*.test.ts` imports this) — shared by the
 * status write-back's run suite (`rastreio/processarRastreio.test.ts`), its
 * pipeline's (`rastreio/notificacaoEscrita.test.ts`) and the write engine's
 * stock suite (`core/escritaEstoque.test.ts`) and its price suite
 * (`core/escritaPreco.test.ts`).
 *
 * One order, its situação history and the two order write routes:
 *
 *  - a code PUT stores the code and, as the painel does, moves the order to
 *    `pedido_enviado` (unless told not to), writing a history row;
 *  - a situação PUT moves the order and writes a history row
 *    (`situacao_anterior` filled), so the check after a write reads `conferido`
 *    unless a test scripts otherwise.
 *
 * And the store's stock rows (`estoque`, none unless given), keyed by PRODUCT id:
 *
 *  - `GET /v1/produto_estoque/{produto id}` answers the row; an unknown id —
 *    a stock row's OWN id included — answers 404 with an empty body;
 *  - `PUT` on the same path sets exactly the four leaves a stock write sends
 *    and recomputes the available quantity by the formula the store's GET rows
 *    show (`quantidade_disponivel = quantidade − quantidade_reservada`,
 *    unfloored). What a real PUT does with pending reservations is an
 *    assumption here, unproven until the first canary write: no engine outcome
 *    depends on it, since the engine compares only the four leaves it writes.
 *
 * And the store's stock LIST, `GET /v1/produto_estoque?limit=&offset=` (the
 * daily reconcile's walk, PR 12-g): the rows of `estado.lista` in order — at
 * start, the `estoque` rows, the very objects the detail answers, so a PUT moves
 * both — one page per call, `meta` as the owner's stock captures show it
 * (`limit`, `offset`, `total_count`, and `next` =
 * `/api/v1/produto_estoque?limit=<same>&offset=<offset + limit>` before the last
 * page, `null` on it and past it). A test edits the list in place: a row
 * inserted at the front mid-walk shifts every row after it
 * ({@link inserirNaListaLi}), a row the store deleted leaves both
 * ({@link removerDaLojaLi}), and a raw row that is not a stock row at all can be
 * pushed straight into `estado.lista` (the list answers it; no detail does).
 *
 * Only the no-slash form is modelled, though the store answers the slash GET
 * identically: the engine never asks it, so a path regression answers 500 here.
 *
 * And the store's produto details (`produtos`, none unless given), keyed by
 * their `id`, as a price write decides on them (master plan step 13; invented
 * values only, `testing/precoLi.ts`):
 *
 *  - `GET /v1/produto/{produto id}/` — the SLASH form only, the one the engine
 *    asks; the no-slash form answers 500 — answers the detail; an unknown id
 *    answers 404 with an empty body;
 *  - `PUT /v1/produto_preco/{produto id}` — the NO-slash form only — answers 404
 *    with an empty body for an unknown id; otherwise it stores the body
 *    (`gravacaoPreco`, default {@link gravarPrecoPadraoLi}) and answers its echo
 *    (`ecoPreco`, default {@link ecoPrecoPadraoLi}: the price row, its amounts as
 *    TEXT). Both are scriptable, so a test can model a store that coerces what
 *    it stores (a promotion truncated to whole reais) or answers another echo.
 *    That an omitted custo keeps the stored one is this fake's ASSUMPTION,
 *    unproven until the first canary write; no engine outcome depends on it, as
 *    the engine never compares the custo.
 *
 * Every request is recorded, and so is every pacer wait, on ONE timeline; the raw
 * text of every PUT body too (`textosDosPuts`), so a test can pin unquoted numbers.
 * A one-shot override queue (`fila`) answers the next request it claims. Nothing
 * here reaches a network: the platform IS the `fetch` the context's clients get
 * (D17), and any route it does not model answers 500.
 */
import type { DocData, FakeDb } from './fakeDb';
import { carimboLi, pedidoLiBruto, ID_ENVIO_LI, ID_PRODUTO_LI, NUMERO_LI } from './pedidosLi';
import { idDaLinhaDePrecoLi, uriLinhaPrecoLi, uriProdutoPrecoLi } from './precoLi';

export interface RequisicaoLi {
  readonly metodo: string;
  readonly caminho: string;
  readonly corpo: unknown;
}

/** A request as the routes and the overrides see it: with its query, as sent (`''` when none). */
export interface RequisicaoComBuscaLi extends RequisicaoLi {
  readonly busca: string;
}

/** A one-shot answer for the first request it claims (a non-null result). */
export type SobrescritaLi = (r: RequisicaoComBuscaLi) => Response | Error | null;

export function respostaJson(status: number, corpo: unknown, tipo = 'application/json'): Response {
  return new Response(corpo === undefined ? '' : JSON.stringify(corpo), {
    status,
    headers: { 'content-type': tipo },
  });
}

export const CAMINHO_PEDIDO_LI = `/v1/pedido/${String(NUMERO_LI)}/`;
export const CAMINHO_SITUACAO_LI = `/v1/situacao/pedido/${String(NUMERO_LI)}`;
export const CAMINHO_ENVIO_LI = `/v1/pedido_envio/${String(ID_ENVIO_LI)}`;
export const CAMINHO_HISTORICO_LI = '/v1/situacao_historico/search/';

/** One product's stock detail, in the no-slash form the engine asks (`ID_PRODUTO_LI`'s). */
export const CAMINHO_ESTOQUE_PRODUTO_LI = `/v1/produto_estoque/${String(ID_PRODUTO_LI)}`;

/** A stock row's OWN id: never the product's, and never a path key (the store answers it 404). */
export function idDaLinhaDeEstoqueLi(produtoId: number): number {
  return produtoId + 90_000;
}

/** `ID_PRODUTO_LI`'s stock row id. */
export const ID_LINHA_ESTOQUE_LI = idDaLinhaDeEstoqueLi(ID_PRODUTO_LI);

/** The available quantity by the formula the store's GET rows show, unfloored (test data only). */
function recalcularDisponivel(linha: DocData): void {
  const { quantidade, quantidade_reservada: reserva } = linha;
  if (typeof quantidade === 'number' && typeof reserva === 'number') {
    linha.quantidade_disponivel = quantidade - reserva;
  }
}

/**
 * One product's stock row, with the nine keys of a stock detail in the store's
 * order: managed, the fixed situações, quantity and reservation 0 unless `over`
 * says otherwise, and the available quantity recomputed from them unless `over`
 * sets it. No floor: a negative row round-trips.
 */
export function linhaEstoqueLi(produtoId: number, over: DocData = {}): DocData {
  const linha: DocData = {
    gerenciado: true,
    id: idDaLinhaDeEstoqueLi(produtoId),
    produto: `/api/v1/produto/${String(produtoId)}`,
    quantidade: 0,
    quantidade_disponivel: 0,
    quantidade_reservada: 0,
    resource_uri: `/api/v1/produto_estoque/${String(produtoId)}`,
    situacao_em_estoque: 0,
    situacao_sem_estoque: -1,
    ...over,
  };
  if (!Object.hasOwn(over, 'quantidade_disponivel')) recalcularDisponivel(linha);
  return linha;
}

/** The product id a stock row names (its `produto` URI), or `null`. */
function produtoDaLinha(linha: DocData): number | null {
  const produto = linha.produto;
  const m =
    typeof produto === 'string' ? /^\/api\/v1\/produto\/([1-9][0-9]*)$/.exec(produto) : null;
  return m === null ? null : Number(m[1]);
}

const ESTOQUE_DETALHE = /^\/v1\/produto_estoque\/([1-9][0-9]*)$/;

const PRODUTO_DETALHE = /^\/v1\/produto\/([1-9][0-9]*)\/$/;
const PRECO_PRODUTO = /^\/v1\/produto_preco\/([1-9][0-9]*)$/;

/** One produto detail, in the slash form the engine's price reader asks. */
export function caminhoProdutoDetalheLi(produtoId: number): string {
  return `/v1/produto/${String(produtoId)}/`;
}

/** One product's price write path, in the no-slash form the package's route accepts. */
export function caminhoPrecoProdutoLi(produtoId: number): string {
  return `/v1/produto_preco/${String(produtoId)}`;
}

/**
 * The default store of a price PUT: `cheio`, `promocional` and `sob_consulta`
 * from the body; `preco_custo` only when the body carries `custo` (an omitted
 * custo keeps the stored one — this fake's assumption, see the header).
 */
export function gravarPrecoPadraoLi(corpo: DocData, detalhe: DocData): void {
  detalhe.preco_cheio = corpo.cheio;
  detalhe.preco_promocional = corpo.promocional;
  detalhe.preco_sob_consulta = corpo.sob_consulta;
  if (Object.hasOwn(corpo, 'custo')) detalhe.preco_custo = corpo.custo;
}

/** A stored amount as the price row's text: a JSON number as `String` prints it, anything else as is. */
const comoTexto = (v: unknown): unknown => (typeof v === 'number' ? String(v) : v);

/**
 * The default echo of a price PUT: the price row as stored, its amounts as TEXT
 * (the public document's shape), its own `id` never the produto's.
 */
export function ecoPrecoPadraoLi(detalhe: DocData): Response {
  const id = Number(detalhe.id);
  return respostaJson(200, {
    cheio: comoTexto(detalhe.preco_cheio),
    custo: comoTexto(detalhe.preco_custo),
    id: idDaLinhaDePrecoLi(id),
    produto: uriProdutoPrecoLi(id),
    promocional: comoTexto(detalhe.preco_promocional),
    resource_uri: uriLinhaPrecoLi(id),
    sob_consulta: detalhe.preco_sob_consulta,
  });
}

/** The stock list (no slash), as the reconcile's walk asks it. */
export const CAMINHO_LISTA_ESTOQUE_LI = '/v1/produto_estoque';

/** `GET /v1/produto_estoque?limit=<limite>&offset=<offset>`, as `chamadasComBusca` records it. */
export function chamadaDaListaLi(offset: number, limite: number): string {
  return `GET ${CAMINHO_LISTA_ESTOQUE_LI}?limit=${String(limite)}&offset=${String(offset)}`;
}

export interface OpcoesPlataformaEscritaLi {
  /** The order's situação codigo at start. */
  readonly codigo?: string;
  /** The order's envio objeto at start. */
  readonly objeto?: string | null;
  /** Whether a code PUT moves the order to `pedido_enviado` (default: yes). */
  readonly moverAoEscreverObjeto?: boolean;
  /** The store's stock rows at start ({@link linhaEstoqueLi}), keyed by the product their `produto` names. */
  readonly estoque?: readonly DocData[];
  /** The store's produto details at start (`detalhePrecoLi`, `testing/precoLi.ts`), keyed by their `id`. */
  readonly produtos?: readonly DocData[];
  /** How a price PUT is stored on the detail (default {@link gravarPrecoPadraoLi}). */
  readonly gravacaoPreco?: (corpo: DocData, detalhe: DocData) => void;
  /** What a price PUT answers, after it is stored (default {@link ecoPrecoPadraoLi}). */
  readonly ecoPreco?: (detalhe: DocData) => Response;
}

export function criarPlataformaEscritaLi(o: OpcoesPlataformaEscritaLi = {}) {
  const codigoInicial = o.codigo ?? 'pedido_pago';
  const pedido = pedidoLiBruto({ situacao: { codigo: codigoInicial } });
  (pedido.envios as DocData[])[0]!.objeto = o.objeto ?? null;
  const estoque = new Map<number, DocData>();
  for (const linha of o.estoque ?? []) {
    const produtoId = produtoDaLinha(linha);
    if (produtoId === null) throw new TypeError('plataforma: linha de estoque sem produto');
    estoque.set(produtoId, structuredClone(linha));
  }
  const produtos = new Map<number, DocData>();
  for (const detalhe of o.produtos ?? []) {
    const id = detalhe.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      throw new TypeError('plataforma: detalhe de produto sem id');
    }
    produtos.set(id, structuredClone(detalhe));
  }
  const gravacaoPreco = o.gravacaoPreco ?? gravarPrecoPadraoLi;
  const ecoPreco = o.ecoPreco ?? ecoPrecoPadraoLi;
  const estado: {
    pedido: DocData;
    historico: DocData[];
    estoque: Map<number, DocData>;
    lista: DocData[];
    produtos: Map<number, DocData>;
  } = {
    pedido,
    historico: [
      {
        id: 1,
        numero: NUMERO_LI,
        data: carimboLi(0),
        situacao: { codigo: codigoInicial },
        situacao_anterior: { codigo: 'aguardando_pagamento' },
      },
    ],
    estoque,
    lista: [...estoque.values()],
    produtos,
  };
  let proximaLinha = 2;
  const requisicoes: RequisicaoLi[] = [];
  /** Each request's query, in step with `requisicoes`. */
  const buscas: string[] = [];
  const textosDosPuts: string[] = [];
  const eventos: string[] = [];
  const fila: SobrescritaLi[] = [];

  const envios = () => estado.pedido.envios as DocData[];
  const codigoAtual = () => (estado.pedido.situacao as { codigo: string }).codigo;

  /** Move the order to `codigo`, with its history row. */
  function mover(codigo: string): void {
    const anterior = codigoAtual();
    estado.pedido.situacao = { codigo };
    estado.historico.push({
      id: proximaLinha,
      numero: NUMERO_LI,
      data: carimboLi(10 + proximaLinha),
      situacao: { codigo },
      situacao_anterior: { codigo: anterior },
    });
    proximaLinha += 1;
  }

  function padrao(r: RequisicaoComBuscaLi): Response {
    if (r.metodo === 'GET' && r.caminho === CAMINHO_PEDIDO_LI) {
      return respostaJson(200, estado.pedido);
    }
    if (r.metodo === 'GET' && /^\/v1\/pedido\/\d+\/$/.test(r.caminho)) return respostaJson(404, {});
    if (r.metodo === 'GET' && r.caminho === CAMINHO_HISTORICO_LI) {
      return respostaJson(200, {
        meta: {
          limit: 50,
          offset: 0,
          next: null,
          previous: null,
          total_count: estado.historico.length,
        },
        objects: estado.historico,
      });
    }
    if (r.metodo === 'PUT' && r.caminho.startsWith('/v1/pedido_envio/')) {
      const id = Number(r.caminho.slice('/v1/pedido_envio/'.length));
      const envio = envios().find((e) => e.id === id);
      if (envio === undefined) return respostaJson(404, {});
      envio.objeto = (r.corpo as { objeto: string }).objeto;
      if (o.moverAoEscreverObjeto !== false && codigoAtual() !== 'pedido_enviado') {
        mover('pedido_enviado');
      }
      return respostaJson(200, envio);
    }
    if (r.metodo === 'PUT' && r.caminho === CAMINHO_SITUACAO_LI) {
      mover((r.corpo as { codigo: string }).codigo);
      return respostaJson(200, estado.pedido.situacao);
    }
    if (r.metodo === 'GET' && r.caminho === CAMINHO_LISTA_ESTOQUE_LI) {
      const busca = new URLSearchParams(r.busca);
      const limite = Number(busca.get('limit'));
      const offset = Number(busca.get('offset'));
      if (!Number.isSafeInteger(limite) || limite < 1 || !Number.isSafeInteger(offset)) {
        return respostaJson(400, { erro: 'limit/offset' });
      }
      const total = estado.lista.length;
      const fim = offset + limite;
      return respostaJson(200, {
        meta: {
          limit: limite,
          offset,
          total_count: total,
          next:
            fim < total
              ? `/api/v1/produto_estoque?limit=${String(limite)}&offset=${String(fim)}`
              : null,
          previous: null,
        },
        objects: estado.lista.slice(offset, fim),
      });
    }
    const estoqueDetalhe = ESTOQUE_DETALHE.exec(r.caminho);
    if (estoqueDetalhe !== null && (r.metodo === 'GET' || r.metodo === 'PUT')) {
      const linha = estado.estoque.get(Number(estoqueDetalhe[1]));
      // The store's 404 for an unknown product (a row's own id included): an empty body.
      if (linha === undefined) return respostaJson(404, undefined);
      if (r.metodo === 'PUT') {
        const corpo = r.corpo as DocData;
        linha.gerenciado = corpo.gerenciado;
        linha.quantidade = corpo.quantidade;
        linha.situacao_em_estoque = corpo.situacao_em_estoque;
        linha.situacao_sem_estoque = corpo.situacao_sem_estoque;
        recalcularDisponivel(linha);
      }
      return respostaJson(200, linha);
    }
    const produtoDetalhe = PRODUTO_DETALHE.exec(r.caminho);
    if (produtoDetalhe !== null && r.metodo === 'GET') {
      const detalhe = estado.produtos.get(Number(produtoDetalhe[1]));
      // The store's 404 for an unknown product: an empty body.
      if (detalhe === undefined) return respostaJson(404, undefined);
      return respostaJson(200, detalhe);
    }
    const precoProduto = PRECO_PRODUTO.exec(r.caminho);
    if (precoProduto !== null && r.metodo === 'PUT') {
      const detalhe = estado.produtos.get(Number(precoProduto[1]));
      if (detalhe === undefined) return respostaJson(404, undefined);
      gravacaoPreco(r.corpo as DocData, detalhe);
      return ecoPreco(detalhe);
    }
    return respostaJson(500, { erro: 'rota nao roteirizada' });
  }

  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    const metodo = init?.method ?? 'GET';
    const registrada: RequisicaoLi = {
      metodo,
      caminho: url.pathname,
      corpo: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    };
    const r: RequisicaoComBuscaLi = { ...registrada, busca: url.search };
    if (metodo === 'PUT' && typeof init?.body === 'string') textosDosPuts.push(init.body);
    requisicoes.push(registrada);
    buscas.push(url.search);
    eventos.push(`${metodo} ${url.pathname}`);
    const primeira = fila[0];
    const sobrescrita = primeira === undefined ? null : primeira(r);
    if (sobrescrita !== null) {
      fila.shift();
      if (sobrescrita instanceof Error) return Promise.reject(sobrescrita);
      return Promise.resolve(sobrescrita);
    }
    return Promise.resolve(padrao(r));
  };

  const esperas: number[] = [];
  const esperar = (ms: number) => {
    esperas.push(ms);
    eventos.push(`espera ${String(ms)}`);
    return Promise.resolve();
  };

  /** The requests, as `METODO caminho` (no waits; the list's query in {@link chamadasComBusca}). */
  const chamadas = () => requisicoes.map((r) => `${r.metodo} ${r.caminho}`);
  /** The requests, as `METODO caminho?busca`. */
  const chamadasComBusca = () =>
    requisicoes.map((r, n) => `${r.metodo} ${r.caminho}${buscas[n] ?? ''}`);

  /**
   * A row inserted into the store's list at `indice` (0 = the front): every row after it shifts
   * one place, as a product created mid-walk does. A row naming a product also answers its detail.
   */
  function inserirNaListaLi(indice: number, linha: DocData): void {
    estado.lista.splice(indice, 0, linha);
    const produtoId = produtoDaLinha(linha);
    if (produtoId !== null) estado.estoque.set(produtoId, linha);
  }

  /** The store deleted a product: its row leaves the list, and its detail answers 404. */
  function removerDaLojaLi(produtoId: number): void {
    const linha = estado.estoque.get(produtoId);
    estado.estoque.delete(produtoId);
    estado.lista = estado.lista.filter((l) => l !== linha);
  }
  const puts = () => requisicoes.filter((r) => r.metodo === 'PUT');

  return {
    estado,
    requisicoes,
    textosDosPuts,
    eventos,
    fila,
    fetch,
    esperar,
    esperas,
    chamadas,
    chamadasComBusca,
    inserirNaListaLi,
    removerDaLojaLi,
    puts,
    mover,
    codigoAtual,
  };
}

export type PlataformaEscritaLi = ReturnType<typeof criarPlataformaEscritaLi>;

/** Answer the next request on `caminho` (any method when `metodo` is null) with `resposta`. */
export function naProxima(
  caminho: string,
  metodo: string | null,
  resposta: () => Response | Error,
): SobrescritaLi {
  return (r) =>
    r.caminho === caminho && (metodo === null || r.metodo === metodo) ? resposta() : null;
}

/** Seed a pedido document as the order import leaves one. */
export function seedPedidoLi(
  db: FakeDb,
  pedidoId: string,
  contaId: string,
  freteInicial: DocData,
  over: DocData = {},
): void {
  db.seed(`pedidos/${pedidoId}`, {
    numero: String(NUMERO_LI),
    integracaoPedidoOuterRef: `integracao/${contaId}`,
    freteInicial: { externalId: String(ID_ENVIO_LI), ...freteInicial },
    ...over,
  });
}
