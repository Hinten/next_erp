/**
 * The three read operations of the ORDER import (master-plan steps 5 and 6),
 * over the GET-only client:
 *
 *  - {@link buscarPedidoLi} — `GET /v1/pedido/{numero}/`, the detail the task
 *    re-fetches for every notification (D13);
 *  - {@link listarHistoricoSituacaoLi} — `GET /v1/situacao_historico/search/`
 *    for one `numero`, every page, which yields the approval and cancellation
 *    dates;
 *  - {@link buscarProdutoPorIdExternoLi} — `GET /v1/produto/{id}/?id_externo=1`,
 *    the produto an order line names by the store's external id.
 *
 * Each one only reads and parses: no retry, no mapping, no decision. Every
 * error is the client's or the pager's, rethrown as-is (a 404 is
 * `LiNotFoundError`, a malformed body `LiSchemaError`); the importer decides
 * what each one means for the order.
 *
 * ## Paths
 *
 * The SLASH form, as the validating GET uses it: the owner's captures of the
 * order detail and of the situação history were both requested that way. The
 * client never follows a redirect, so a wrong form would surface as a visible
 * `LiHttpError`, never as a silent second call.
 *
 * ## Ids are checked before anything is built
 *
 * `numero` and the produto id must each be a positive safe integer — a number,
 * or its plain decimal text (no sign, no leading zero, no space). Anything else
 * is refused with `LiConfigError('caminho')` and NOTHING is fetched: the value
 * would not name one resource, and interpolated into a path it could name
 * another one. The reader is `idsDeCaminho.ts`, shared with the write-back
 * operations (`pedidosEscrita.ts`).
 */
import type { LiLeituraClient, RespostaLi } from './client';
import { idOuRecusa } from './idsDeCaminho';
import { paginarLi } from './paginacao';
import {
  liPedidoSchema,
  liProdutoIdentidadeSchema,
  liSituacaoHistoricoLinhaSchema,
  type PedidoLi,
  type ProdutoIdentidadeLi,
  type SituacaoHistoricoLinhaLi,
} from './pedidoTipos';

/** The history listing path; the order is selected by the `numero` query key. */
export const CAMINHO_HISTORICO_SITUACAO_LI = '/v1/situacao_historico/search/';

/**
 * The page size the history listing ASKS for. Sent explicitly because the
 * provider's default is 20; `meta.limit` is still read back, never assumed.
 */
export const LIMITE_HISTORICO_SITUACAO_LI = 50;

/**
 * The most history pages one order may take before the listing throws
 * `LiPaginacaoError('limite-de-paginas')`: 500 situação changes at the limit
 * asked for, far beyond any real order. A filter the provider ignored would
 * otherwise read the whole store's history, page by page, inside one task.
 */
export const MAX_PAGINAS_HISTORICO_SITUACAO_LI = 10;

export interface OpcoesLeituraLi {
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

/**
 * `GET /v1/pedido/{numero}/`, parsed by `liPedidoSchema`.
 *
 * ⚠️ The answer is not checked against `numero` here: the importer compares
 * `corpo.numero` with the order it was asked to import, and refuses a mismatch.
 */
export async function buscarPedidoLi(
  cliente: LiLeituraClient,
  numero: number | string,
  opts: OpcoesLeituraLi = {},
): Promise<RespostaLi<PedidoLi>> {
  const operacao = 'buscarPedido';
  const id = idOuRecusa(numero, operacao);
  return cliente.get({
    operacao,
    caminho: `/v1/pedido/${id}/`,
    schema: liPedidoSchema,
    sinal: opts.sinal,
  });
}

export interface HistoricoSituacaoLi {
  /** Every row of every page, in the order received — never sorted here. */
  readonly linhas: readonly SituacaoHistoricoLinhaLi[];
  /** One per page read, in order, for the caller's log lines. */
  readonly correlationIds: readonly string[];
}

export interface OpcoesHistoricoLi extends OpcoesLeituraLi {
  /** Defaults to {@link MAX_PAGINAS_HISTORICO_SITUACAO_LI}. */
  readonly maxPaginas?: number;
}

/**
 * The whole situação history of one order: `paginarLi` over
 * {@link CAMINHO_HISTORICO_SITUACAO_LI} with `{ numero, limit: 50 }`, every page
 * read before returning.
 *
 * ⚠️ The rows are returned as received. The caller checks that each one is
 * about `numero` (a provider that ignored the filter would answer another
 * order's rows) and puts them in time order; neither is assumed here.
 */
export async function listarHistoricoSituacaoLi(
  cliente: LiLeituraClient,
  numero: number | string,
  opts: OpcoesHistoricoLi = {},
): Promise<HistoricoSituacaoLi> {
  const operacao = 'listarHistoricoSituacao';
  const id = idOuRecusa(numero, operacao);
  const linhas: SituacaoHistoricoLinhaLi[] = [];
  const correlationIds: string[] = [];
  for await (const pagina of paginarLi(cliente, {
    operacao,
    caminho: CAMINHO_HISTORICO_SITUACAO_LI,
    query: { numero: id, limit: LIMITE_HISTORICO_SITUACAO_LI },
    schemaLinha: liSituacaoHistoricoLinhaSchema,
    maxPaginas: opts.maxPaginas ?? MAX_PAGINAS_HISTORICO_SITUACAO_LI,
    sinal: opts.sinal,
  })) {
    linhas.push(...pagina.objetos);
    correlationIds.push(pagina.correlationId);
  }
  return { linhas, correlationIds };
}

/**
 * `GET /v1/produto/{idExterno}/?id_externo=1`: the produto whose EXTERNAL id
 * (the store's own id for it, an integer) is `idExterno`, read for its LI id.
 * A 404 is `LiNotFoundError`, which the importer turns into an unmatched line.
 */
export async function buscarProdutoPorIdExternoLi(
  cliente: LiLeituraClient,
  idExterno: number | string,
  opts: OpcoesLeituraLi = {},
): Promise<RespostaLi<ProdutoIdentidadeLi>> {
  const operacao = 'buscarProdutoPorIdExterno';
  const id = idOuRecusa(idExterno, operacao);
  return cliente.get({
    operacao,
    caminho: `/v1/produto/${id}/`,
    query: { id_externo: 1 },
    schema: liProdutoIdentidadeSchema,
    sinal: opts.sinal,
  });
}
