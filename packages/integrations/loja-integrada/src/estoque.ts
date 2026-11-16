/**
 * The STOCK reads of master-plan step 12, over the GET-only client:
 *
 *  - {@link lerPaginaEstoqueLi} — ONE page of `GET /v1/produto_estoque`, the
 *    store's whole stock list, with the validated offset of the next page and
 *    the rows it could not read (below). The list has no filter, so the daily
 *    reconcile reads all of it, a checkpoint after each page. It goes through
 *    the one-page reader `lerPaginaLi` (`produtos.ts`), never through
 *    `paginarLi`: that pager's page cap is a ceiling a large store's list can
 *    exceed, and it throws rather than truncate;
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
 * ## One odd row never costs the page
 *
 * The page is read in two layers. The ENVELOPE (`meta`, an `objects` array) is
 * the pager's, and a malformed one refuses the page (`LiSchemaError`). Each ROW
 * is then read on its own through `liEstoqueProdutoLinhaSchema`: a row it
 * refuses is returned in `ilegiveis` — its position, the produto its `produto`
 * leaf names when it names one, and the refused field paths, never a value —
 * beside every row that did read. So a single odd row in a store of thousands
 * hides nothing but itself, as on the produto list (`types.ts`), and a reconcile
 * that resumes at a page never stalls there on one row. What an unreadable row
 * means is the caller's call; nothing here guesses its leaves.
 *
 * The DETAIL ({@link buscarEstoqueProdutoLi}) is read whole and strict: a stock
 * write decides on it, so a detail that does not parse refuses the read
 * (`LiSchemaError`) and nothing is decided from it.
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
 * ⚠️ Unproven until the captures: the document's path keys are known NOT to be
 * the request form elsewhere (it keys `/v1/produto` and `/v1/categoria`, while
 * the captured reads that answered 200 were `/v1/produto/` and
 * `/v1/categoria/`). The change that adds the stock captures settles it: they
 * are requested in exactly these two forms, the fixture records the request
 * path it was taken with, and a test pins {@link CAMINHO_ESTOQUE_LI} against
 * it. If only the slash form answers there, both GETs move to it, as the other
 * reads use; the stock write keeps the document's key, as the order writes do.
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
import { camposInvalidos } from '@delfrance/core/wire';
import { idDoRecursoLi, RECURSO_URI_LI } from '@delfrance/schemas';
import { z } from 'zod';

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
 *
 * ⚠️ The ONE bound. A caller that keeps a page size — read from its
 * environment, or stored in a resumable cursor — bounds it by THIS constant,
 * never by a copy of its own: a stored size above it refuses every page read
 * from it (`LiConfigError('limite')`), so a cursor that accepted one would stall
 * its run at every resume.
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
 * One row of a stock page that `liEstoqueProdutoLinhaSchema` refused: REPORTED
 * beside the rows that read, never thrown for the page, never dropped in silence
 * and never guessed at (module header, "One odd row never costs the page").
 */
export interface LinhaIlegivelEstoqueLi {
  /** Its 0-based position in the page's `objects`. */
  readonly indice: number;
  /**
   * The produto its `produto` leaf names ({@link produtoIdDoEstoqueLi}), or
   * `null` when that leaf names none: absent, of another form or type, or a row
   * that is not an object at all.
   */
  readonly produtoId: number | null;
  /** The field paths the row schema refused (`camposInvalidos`): paths only, never a value. */
  readonly campos: readonly string[];
}

/** One page of the stock list: the rows that read, and the ones that did not. */
export interface PaginaEstoqueLi extends PaginaUnicaLi<EstoqueProdutoLinhaLi> {
  /** The rows the row schema refused, in page order; `[]` when every row read. */
  readonly ilegiveis: readonly LinhaIlegivelEstoqueLi[];
}

/**
 * One page of `GET /v1/produto_estoque` with exactly `{ limit, offset }`, as
 * given, `meta` as the provider answered it and the next offset validated
 * (`lerPaginaLi`). Every row is read on its own through
 * `liEstoqueProdutoLinhaSchema`: the ones that parse are `linhas`, in the order
 * received; the ones that do not are `ilegiveis` (module header). Only a
 * malformed envelope refuses the page (`LiSchemaError`).
 *
 * Refused before anything is read or fetched: a `limite` outside 1 to
 * {@link MAX_LIMITE_PAGINA_ESTOQUE_LI} (`LiConfigError('limite')`), an `offset`
 * that is not a non-negative safe integer (`LiConfigError('offset')`), an
 * already-aborted `sinal` (its reason).
 */
export async function lerPaginaEstoqueLi(
  cliente: LiLeituraClient,
  opts: OpcoesPaginaEstoqueLi,
): Promise<PaginaEstoqueLi> {
  const operacao = 'lerPaginaEstoque';
  const { limite } = opts;
  if (!Number.isSafeInteger(limite) || limite <= 0 || limite > MAX_LIMITE_PAGINA_ESTOQUE_LI) {
    throw new LiConfigError('limite', { operacao, refCredencial: null });
  }
  const pagina = await lerPaginaLi(cliente, {
    operacao,
    caminho: CAMINHO_ESTOQUE_LI,
    // The envelope alone can refuse the page; each row is read below.
    esquema: z.unknown(),
    offset: opts.offset,
    limite,
    sinal: opts.sinal,
  });
  const linhas: EstoqueProdutoLinhaLi[] = [];
  const ilegiveis: LinhaIlegivelEstoqueLi[] = [];
  for (const [indice, bruta] of pagina.linhas.entries()) {
    const lida = liEstoqueProdutoLinhaSchema.safeParse(bruta);
    if (lida.success) {
      linhas.push(lida.data);
    } else {
      ilegiveis.push({
        indice,
        produtoId: produtoIdDoEstoqueLi(produtoDaLinhaBruta(bruta)),
        campos: camposInvalidos(lida.error.issues),
      });
    }
  }
  return { ...pagina, linhas, ilegiveis };
}

/** The raw `produto` leaf of a row the schema refused, or `undefined` when it has none. */
function produtoDaLinhaBruta(bruta: unknown): unknown {
  return typeof bruta === 'object' && bruta !== null && 'produto' in bruta
    ? bruta.produto
    : undefined;
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
