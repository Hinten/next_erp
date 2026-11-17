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
 * ## Checked against the captures
 *
 * The schemas (`types.ts`, the stock section) were written against the public
 * document, then checked against the owner's read-only stock captures (both
 * stores, read 2026-11-16; replayed through these reads by
 * `apps/loja-integrada/lib/lojaIntegrada/estoque/capturasEstoque.test.ts`).
 * What those captures settled:
 *
 *  - the page size: `limit` 20, 50 and 100 are honoured exactly, and 200 answers
 *    a 400 from the API gateway, as on the produto list
 *    ({@link MAX_LIMITE_PAGINA_ESTOQUE_LI});
 *  - membership: the list holds a row for EVERY product — live parents and
 *    their variations, the trash, and products created after the product
 *    captures; the rows read equal `total_count`, with no produto twice;
 *  - the order: the rows follow neither the row id nor the produto id, but a
 *    page re-read minutes later returned the same rows in the same positions.
 *    Nothing here relies on any order;
 *  - the detail key: the detail path id IS the produto id. The row's own `id`
 *    differs from it in every row, and asked as a detail path it answers 404
 *    with an empty body, the same as an id that is no product;
 *  - the path form (below).
 *
 * ## Paths: the document's own keys, NO trailing slash
 *
 * `/v1/produto_estoque` and `/v1/produto_estoque/{produto_id}`, exactly as the
 * public document keys them, which is also the stock write's route
 * (`rotasEscrita.ts`). The other reads use the slash form because their
 * captures were requested that way. The client never follows a redirect, so a
 * wrong form fails VISIBLY — a 3xx `LiHttpError`, never a silent second call.
 *
 * Proven for GET: the owner's read-only stock captures asked the list and a
 * detail in both forms, and each answered 200 with the same rows (the same
 * order, the same `total_count`) or the same body, with no redirect; a test
 * pins {@link CAMINHO_ESTOQUE_LI} against the captured request path. ⚠️ The
 * stock PUT's path form stays unproven: those captures are GET-only, and the
 * document's path keys are known NOT to be the request form elsewhere (it keys
 * `/v1/produto` and `/v1/categoria`, while the captured reads were
 * `/v1/produto/` and `/v1/categoria/`).
 *
 * ## The next offset
 *
 * Exactly as {@link lerPaginaLi} returns it: the caller stores the offset and
 * asks again; the page is always requested at {@link CAMINHO_ESTOQUE_LI} with
 * exactly `limit` and `offset`, whatever `next` says. The captured `next` of
 * every page before the last is
 * `/api/v1/produto_estoque?limit=<same>&offset=<offset + limit>` — the `/api`
 * prefix and no slash before `?` — and it is never followed as a path. The
 * last page answers `next` null, with offset + rows = `total_count`. A page
 * past the end answers 200 with no row, `next` null and the same
 * `total_count`. An offset list edited while it is read can repeat or skip a
 * row: the caller must tolerate both.
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
import { idDoRecursoLi, MAX_LIMITE_PAGINA_ESTOQUE_LI, RECURSO_URI_LI } from '@delfrance/schemas';
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
 * The largest page the stock list is asked for, as measured: the owner's
 * read-only stock captures saw `limit=100` honoured in full and `limit=200`
 * answered with a 400 from the API gateway, as on the produto list
 * (`produtos.ts`, "Page size"). It is `@delfrance/schemas`'
 * `MAX_LIMITE_PAGINA_ESTOQUE_LI`, re-exported here as the same binding, never a
 * copy: the reconcile cursor's stored `limite` is held to it, so a size a run
 * stored is never one this reader refuses at every resume. The page applied is
 * read back in `meta.limit`, never assumed.
 */
export { MAX_LIMITE_PAGINA_ESTOQUE_LI };

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
