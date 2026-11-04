/**
 * A stateful Loja Integrada for the status write-back suites, **for tests only**
 * (the `fakeDb.ts` rule: nothing outside a `*.test.ts` imports this) — shared
 * by the run's suite (`rastreio/processarRastreio.test.ts`) and the pipeline's
 * (`rastreio/notificacaoEscrita.test.ts`).
 *
 * One order, its situação history and the two write routes:
 *
 *  - a code PUT stores the code and, as the painel does, moves the order to
 *    `pedido_enviado` (unless told not to), writing a history row;
 *  - a situação PUT moves the order and writes a history row
 *    (`situacao_anterior` filled), so the check after a write reads `conferido`
 *    unless a test scripts otherwise.
 *
 * Every request is recorded, and so is every pacer wait, on ONE timeline. A
 * one-shot override queue (`fila`) answers the next request it claims. Nothing
 * here reaches a network: the platform IS the `fetch` the context's clients get
 * (D17), and any route it does not model answers 500.
 */
import type { DocData, FakeDb } from './fakeDb';
import { carimboLi, pedidoLiBruto, ID_ENVIO_LI, NUMERO_LI } from './pedidosLi';

export interface RequisicaoLi {
  readonly metodo: string;
  readonly caminho: string;
  readonly corpo: unknown;
}

/** A one-shot answer for the first request it claims (a non-null result). */
export type SobrescritaLi = (r: RequisicaoLi) => Response | Error | null;

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

export interface OpcoesPlataformaEscritaLi {
  /** The order's situação codigo at start. */
  readonly codigo?: string;
  /** The order's envio objeto at start. */
  readonly objeto?: string | null;
  /** Whether a code PUT moves the order to `pedido_enviado` (default: yes). */
  readonly moverAoEscreverObjeto?: boolean;
}

export function criarPlataformaEscritaLi(o: OpcoesPlataformaEscritaLi = {}) {
  const codigoInicial = o.codigo ?? 'pedido_pago';
  const pedido = pedidoLiBruto({ situacao: { codigo: codigoInicial } });
  (pedido.envios as DocData[])[0]!.objeto = o.objeto ?? null;
  const estado: { pedido: DocData; historico: DocData[] } = {
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
  };
  let proximaLinha = 2;
  const requisicoes: RequisicaoLi[] = [];
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

  function padrao(r: RequisicaoLi): Response {
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
    return respostaJson(500, { erro: 'rota nao roteirizada' });
  }

  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    const metodo = init?.method ?? 'GET';
    const r: RequisicaoLi = {
      metodo,
      caminho: url.pathname,
      corpo: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    };
    requisicoes.push(r);
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

  /** The requests, as `METODO caminho` (no waits). */
  const chamadas = () => requisicoes.map((r) => `${r.metodo} ${r.caminho}`);
  const puts = () => requisicoes.filter((r) => r.metodo === 'PUT');

  return {
    estado,
    requisicoes,
    eventos,
    fila,
    fetch,
    esperar,
    esperas,
    chamadas,
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
