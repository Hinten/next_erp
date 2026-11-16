/**
 * The STOCK reads of master-plan step 12, over the GET-only client:
 *
 *  - {@link lerPaginaEstoqueLi} — ONE page of `GET /v1/produto_estoque`, the
 *    store's whole stock list, with the validated offset of the next page. The
 *    list has no filter, so the daily reconcile reads all of it, a checkpoint
 *    after each page. It goes through the one-page reader `lerPaginaLi`
 *    (`produtos.ts`), never through `paginarLi`: that pager's page cap is a
 *    ceiling a large store's list can exceed, and it throws rather than
 *    truncate;
 *  - {@link buscarEstoqueProdutoLi} — `GET /v1/produto_estoque/{produto_id}`,
 *    one product's stock;
 *  - {@link produtoIdDoEstoqueLi} — the produto id a stock row's `produto` URI
 *    names, or `null`. Pure.
 *
 * The stock WRITE is `estoqueEscrita.ts`, over the write client.
 *
 * Each one only reads and parses: no retry, no decision. Every error is the
 * client's or the pager's, rethrown as-is (a 404 is `LiNotFoundError`, a 403
 * `LiAuthError`, a malformed body `LiSchemaError`, a `next` that cannot be
 * followed `LiSchemaError` or `LiPaginacaoError`). What a row means — whether it
 * is reflected, which ERP product it belongs to, what a missing row says — is
 * the caller's call (`apps/loja-integrada`).
 *
 * ## Written ahead of the captures
 *
 * The schemas (`types.ts`, the stock section) follow the public document
 * alone: the owner's read-only stock captures are not in yet, and the change
 * that adds them pins real rows against these reads before anything consumes
 * them. Four things only those captures can settle, so nothing here assumes
 * them:
 *
 *  - the largest `limit` the stock list honours ({@link MAX_LIMITE_PAGINA_ESTOQUE_LI}
 *    is a bound, not a measurement), and whether it lists parents or the trash;
 *  - the order of the rows (nothing here relies on any);
 *  - whether the path id of the detail is the PRODUTO id. The document says so
 *    (its path parameter is `produto_id`, and its examples' `resource_uri`
 *    carries the produto id, while the row's own `id` differs), and this module
 *    sends the produto id;
 *  - the path form (below).
 *
 * ## Paths: the document's own keys, NO trailing slash
 *
 * `/v1/produto_estoque` and `/v1/produto_estoque/{produto_id}`, exactly as the
 * public document keys them, which is also the stock write's route
 * (`rotasEscrita.ts`). The other reads use the slash form because their
 * captures were requested that way; none exists here yet. The client never
 * follows a redirect, so a wrong form fails VISIBLY — a 3xx `LiHttpError`,
 * never a silent second call.
 *
 * ## The next offset
 *
 * Exactly as {@link lerPaginaLi} returns it: the caller stores the offset and
 * asks again; the page is always requested at {@link CAMINHO_ESTOQUE_LI} with
 * exactly `limit` and `offset`, whatever `next` says (the document's `next` is
 * `/api/v1/produto_estoque?limit=20&offset=20`). An offset list edited while
 * it is read can repeat or skip a row: the caller must tolerate both.
 *
 * ## Ids are checked before anything is built
 *
 * The produto id goes through `idsDeCaminho.ts`, as every other path id does:
 * a positive safe integer, a number or its plain decimal text. Anything else
 * (`'0123'`, `'1/2'`) is `LiConfigError('caminho')` and NOTHING is fetched.
 *
 * ## The produto a row names
 *
 * {@link produtoIdDoEstoqueLi} is the shared Loja Integrada resource-URI reader
 * of `@delfrance/schemas` (`idDoRecursoLi`), bound to `produto` — the same one
 * that reads a parent's `filhos` and a child's `pai` for the product import, so
 * a stock row and a product link can never disagree about which produto an id
 * names. It keeps no rule of its own.
 */
import { idDoRecursoLi, RECURSO_URI_LI } from '@delfrance/schemas';

import type { LiLeituraClient, RespostaLi } from './client';
import { LiConfigError } from './errors';
import { idOuRecusa } from './idsDeCaminho';
import type { OpcoesLeituraLi } from './pedidos';
import { lerPaginaLi, type PaginaUnicaLi } from './produtos';
import {
  type EstoqueProdutoDetalheLi,
  type EstoqueProdutoLinhaLi,
  liEstoqueProdutoDetalheSchema,
  liEstoqueProdutoLinhaSchema,
} from './types';

/**
 * The stock list; one product's stock is `${CAMINHO_ESTOQUE_LI}/<produto id>`,
 * which is also the stock write's path. No trailing slash (module header).
 */
export const CAMINHO_ESTOQUE_LI = '/v1/produto_estoque';

/**
 * The largest page the stock list is asked for: a BOUND, not a measurement. The
 * produto list answered `limit=100` in full and refused 200 and above with a 400
 * (`produtos.ts`, "Page size"); the stock list's own ceiling is not measured
 * yet, and nothing asks it for more than this. The page applied is read back in
 * `meta.limit`, never assumed.
 */
export const MAX_LIMITE_PAGINA_ESTOQUE_LI = 100;

export interface OpcoesPaginaEstoqueLi {
  /** The page's offset: 0, then each page's `proximoOffset`. */
  readonly offset: number;
  /** The page size asked for (sent as `limit`): 1 to {@link MAX_LIMITE_PAGINA_ESTOQUE_LI}. */
  readonly limite: number;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

/**
 * One page of `GET /v1/produto_estoque` with exactly `{ limit, offset }`, as
 * given, every row through `liEstoqueProdutoLinhaSchema`, `meta` as the provider
 * answered it and the next offset validated (`lerPaginaLi`).
 *
 * Refused before anything is read or fetched: a `limite` outside 1 to
 * {@link MAX_LIMITE_PAGINA_ESTOQUE_LI} (`LiConfigError('limite')`), an `offset`
 * that is not a non-negative safe integer (`LiConfigError('offset')`), an
 * already-aborted `sinal` (its reason).
 */
export async function lerPaginaEstoqueLi(
  cliente: LiLeituraClient,
  opts: OpcoesPaginaEstoqueLi,
): Promise<PaginaUnicaLi<EstoqueProdutoLinhaLi>> {
  const operacao = 'lerPaginaEstoque';
  const { limite } = opts;
  if (!Number.isSafeInteger(limite) || limite <= 0 || limite > MAX_LIMITE_PAGINA_ESTOQUE_LI) {
    throw new LiConfigError('limite', { operacao, refCredencial: null });
  }
  return lerPaginaLi(cliente, {
    operacao,
    caminho: CAMINHO_ESTOQUE_LI,
    esquema: liEstoqueProdutoLinhaSchema,
    offset: opts.offset,
    limite,
    sinal: opts.sinal,
  });
}

/**
 * `GET /v1/produto_estoque/{produtoId}` with no query, parsed by
 * `liEstoqueProdutoDetalheSchema`. `produtoId` is the PRODUTO's id (module
 * header), never the row's own `id`.
 *
 * A 404 is the client's `LiNotFoundError`, rethrown as-is; what a product with
 * no stock row means is the caller's call.
 *
 * ⚠️ The answer is not checked against `produtoId` here: the caller compares
 * the row's `produto` ({@link produtoIdDoEstoqueLi}) with the product it asked
 * for.
 *
 * `async` on purpose: a refused id rejects the promise like every other
 * failure, rather than throwing before the caller holds one.
 */
export async function buscarEstoqueProdutoLi(
  cliente: LiLeituraClient,
  produtoId: number | string,
  opts: OpcoesLeituraLi = {},
): Promise<RespostaLi<EstoqueProdutoDetalheLi>> {
  const operacao = 'buscarEstoqueProduto';
  const id = idOuRecusa(produtoId, operacao);
  return cliente.get({
    operacao,
    caminho: `${CAMINHO_ESTOQUE_LI}/${id}`,
    schema: liEstoqueProdutoDetalheSchema,
    sinal: opts.sinal,
  });
}

/**
 * The produto id a stock row's `produto` names, or `null` when it names none:
 * the shared resource-URI reader (`idDoRecursoLi`, `@delfrance/schemas`) bound
 * to `produto`, verbatim (module header).
 *
 * Equal (⇒ `123`): `/api/v1/produto/123` (the document's form) ≡
 * `/api/v1/produto/123/` ≡ `/v1/produto/123` — the shared reader's own equal
 * set, because the store was captured answering URIs both with and without the
 * `/api` prefix on other resources.
 * Distinct (⇒ `null`): a leading zero (`/api/v1/produto/0123`), an extra
 * segment (`/api/v1/produto/12/3`), trailing junk (`/api/v1/produto/123x`, two
 * trailing slashes, a query, a fragment), another resource
 * (`/api/v1/produto_estoque/123`, the row's own `resource_uri`), a zero id, an
 * id past the safe-integer range, `''`, and anything that is not a string (a
 * bare number `123` included).
 */
export function produtoIdDoEstoqueLi(produto: unknown): number | null {
  return idDoRecursoLi(produto, RECURSO_URI_LI.produto);
}
