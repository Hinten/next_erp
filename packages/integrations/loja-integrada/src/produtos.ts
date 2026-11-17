/**
 * The reads of the PRODUCT import (master-plan step 9), over the GET-only
 * client:
 *
 *  - {@link lerPaginaLi} — ONE page of any Tastypie list, with the validated
 *    offset of the next one. The import is a resumable job that checkpoints
 *    after every page, so it reads page by page instead of walking a whole list
 *    (`paginarLi`). It serves the produto list below and the catalogue lists of
 *    step 10 alike (`CAMINHO_CATEGORIAS_LI`, `CAMINHO_MARCAS_LI`, with the row
 *    schemas `types.ts` declares for them);
 *  - {@link lerPaginaProdutosLi} — one page of `GET /v1/produto/`, the live
 *    list (`removido=false`) or the trash (`removido=true`);
 *  - {@link buscarProdutoLi} — `GET /v1/produto/{id}/`, one product's detail.
 *
 * Each one only reads and parses: no retry, no decision. Every error is the
 * client's or the pager's, rethrown as-is (a 404 is `LiNotFoundError`, a 403
 * `LiAuthError`, a malformed body `LiSchemaError`, a `next` that cannot be
 * followed `LiSchemaError` or `LiPaginacaoError`); what each one means for a
 * product is the caller's call.
 *
 * ## The next offset
 *
 * `lerPaginaLi` returns the next page's offset, never its request: the caller
 * stores the offset and asks again with its OWN options, so every key it sends
 * (`removido`, `limit`) goes out again whether or not `next` carried it. The
 * offset is validated by `proximaPaginaLi` (`paginacao.ts`), the one copy of the
 * paging rules: read from `next` ALONE, strictly past both the page's
 * `meta.offset` and the offset sent, a repeated caller key refused, every other
 * key and any host in `next` ignored. `next: null` is the end
 * (`proximoOffset: null`). The caller never parses `meta.next` itself.
 *
 * The order of the rows is the provider's, undocumented, and nothing here relies
 * on it. An offset list edited while it is read can repeat or skip a row: a
 * caller must not rely on the order either, and must tolerate both.
 *
 * ## Page size
 *
 * `limite` (sent as `limit`) is the caller's, required, and read back in
 * `meta.limit`, never assumed. The produto list refuses more than
 * {@link MAX_LIMITE_PAGINA_PRODUTOS_LI} before anything is fetched: the owner's
 * capture C10 measured `limit=100` answered in full and `limit=200`, `500` and
 * `1000` each refused with a 400 whose body is an API-gateway JSON
 * (`{Code, OperationId, Message}`), which the client classifies like any other
 * 400 (`LiHttpError`, not transient; no body text in the error).
 *
 * ## What is never sent, and never returned
 *
 *  - Never sent: `id_externo` (it would make the path id the store's EXTERNAL
 *    id), `sku`, `ativo`, a date filter (`data_modificacao__gte` and the rest),
 *    `description_html`, `descricao_completa` (C10: the detail answered the same
 *    bytes with and without it). The produto list sends exactly `limit`,
 *    `removido` and `offset`; the detail sends no query at all.
 *  - Never returned: price and stock (`preco_*`, `estoque_*`), `seo`, `tags`,
 *    `url`, an image's absolute URLs. The produto schemas are passthrough (the
 *    package convention), so both produto reads return an explicit PROJECTION
 *    ({@link PRODUTO_LINHA_CAMPOS_LI}, {@link PRODUTO_DETALHE_CAMPOS_LI},
 *    {@link IMAGEM_PRODUTO_CAMPOS_LI}) instead of the parse: the product import
 *    never brings price or stock into the ERP, so neither ever reaches it.
 *
 * ## Ids are checked before anything is built
 *
 * The produto id goes through `idsDeCaminho.ts`, as the order reads' ids do: a
 * positive safe integer, a number or its plain decimal text. Anything else
 * (`'0123'`, `'1/2'`) is `LiConfigError('caminho')` and NOTHING is fetched.
 */
import type { z } from 'zod';

import type { LiLeituraClient, RespostaLi } from './client';
import { LiConfigError } from './errors';
import { idOuRecusa } from './idsDeCaminho';
import { proximaPaginaLi } from './paginacao';
import type { OpcoesLeituraLi } from './pedidos';
import {
  liEnvelopeSchema,
  type liImagemProdutoSchema,
  liProdutoDetalheSchema,
  liProdutoLinhaSchema,
  type MetaLi,
} from './types';

/** The produto list; one product's detail is `${CAMINHO_PRODUTOS_LI}<id>/`. */
export const CAMINHO_PRODUTOS_LI = '/v1/produto/';

/**
 * The largest page the produto list is asked for. C10: 100 answered in full,
 * 200 and above answered 400 (module header, "Page size").
 */
export const MAX_LIMITE_PAGINA_PRODUTOS_LI = 100;

/* -------------------------------------------------------------------------- */
/*                         The one-page reader                                */
/* -------------------------------------------------------------------------- */

export interface OpcoesPaginaLi<S extends z.ZodType> {
  /** The caller's label for the call; it names the call in messages and events. */
  readonly operacao: string;
  /** A path under `/v1/`: the page is requested at THIS path, whatever `next` says. */
  readonly caminho: string;
  /** The schema of ONE row of `objects`. */
  readonly esquema: S;
  /** The page's offset (sent as `offset`): a non-negative safe integer. */
  readonly offset: number;
  /** The page size ASKED for (sent as `limit`): a positive safe integer. */
  readonly limite: number;
  /**
   * The caller's own filter keys, sent on this page as given. `limit` and
   * `offset` are refused here: they are `limite` and `offset`, one value each.
   */
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

export interface PaginaUnicaLi<T> {
  /** The page's rows, in the order received — never sorted or de-duplicated. */
  readonly linhas: readonly T[];
  /** As the provider answered it: `meta.limit` is the page size it applied. */
  readonly meta: MetaLi;
  /** The next page's offset, validated; `null` when `next` is `null` (the end). */
  readonly proximoOffset: number | null;
  readonly correlationId: string;
}

/**
 * ONE page of the list at `caminho`: `GET` with `{ limit, ...query, offset }`,
 * every row through `esquema`, and the next offset (module header).
 *
 * Refused before anything is read or fetched: `limite` not a positive safe
 * integer, or a `limit` key in `query` (`LiConfigError('limite')`); `offset` not
 * a non-negative safe integer, or an `offset` key in `query`
 * (`LiConfigError('offset')`); an already-aborted `sinal` (its reason).
 */
export async function lerPaginaLi<S extends z.ZodType>(
  cliente: LiLeituraClient,
  opts: OpcoesPaginaLi<S>,
): Promise<PaginaUnicaLi<z.infer<S>>> {
  const { operacao, caminho, esquema, offset, limite, sinal } = opts;
  const extra = opts.query ?? {};
  if (!Number.isSafeInteger(limite) || limite <= 0 || Object.hasOwn(extra, 'limit')) {
    throw new LiConfigError('limite', { operacao, refCredencial: null });
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || Object.hasOwn(extra, 'offset')) {
    throw new LiConfigError('offset', { operacao, refCredencial: null });
  }
  // Before the client asks for the credential (a store read in the app).
  sinal?.throwIfAborted();

  const query = { limit: limite, ...extra, offset };
  const original: ReadonlyMap<string, string> = new Map(
    Object.entries(query).map(([k, v]) => [k, String(v)]),
  );
  const resposta = await cliente.get({
    operacao,
    caminho,
    query,
    schema: liEnvelopeSchema(esquema),
    sinal,
  });
  const { meta } = resposta.dados;
  const linhas: z.infer<S>[] = resposta.dados.objects;
  const { correlationId } = resposta;
  if (meta.next === null) return { linhas, meta, proximoOffset: null, correlationId };

  const proxima = proximaPaginaLi(meta.next, original, {
    operacao,
    caminho,
    correlationId,
    refCredencial: resposta.refCredencial,
    metodo: 'GET',
    status: resposta.status,
    offsetDaPagina: meta.offset,
    offsetEnviado: offset,
    paginas: 1,
  });
  return { linhas, meta, proximoOffset: proxima.offset, correlationId };
}

/* -------------------------------------------------------------------------- */
/*                            The projections                                 */
/* -------------------------------------------------------------------------- */

/** The leaves of a produto list row that leave the package. */
export const PRODUTO_LINHA_CAMPOS_LI = [
  'id',
  'tipo',
  'sku',
  'nome',
  'gtin',
  'ativo',
  'bloqueado',
  'removido',
  'filhos',
  'categorias',
  'grades',
  'variacoes',
] as const;

/** The leaves of a produto detail that leave the package: the row's, and these. */
export const PRODUTO_DETALHE_CAMPOS_LI = [
  ...PRODUTO_LINHA_CAMPOS_LI,
  'pai',
  'marca',
  'destaque',
  'usado',
  'peso',
  'altura',
  'largura',
  'profundidade',
  'descricao_completa',
  'imagem_principal',
  'imagens',
] as const;

/** The leaves of a produto image that leave the package: the CDN path, never a URL. */
export const IMAGEM_PRODUTO_CAMPOS_LI = ['id', 'caminho', 'principal', 'posicao', 'mime'] as const;

type LinhaLida = z.infer<typeof liProdutoLinhaSchema>;
type DetalheLido = z.infer<typeof liProdutoDetalheSchema>;
type ImagemLida = z.infer<typeof liImagemProdutoSchema>;

/** One image as the detail read returns it ({@link IMAGEM_PRODUTO_CAMPOS_LI}). */
export type ImagemDoProdutoLi = {
  readonly [K in (typeof IMAGEM_PRODUTO_CAMPOS_LI)[number]]: ImagemLida[K];
};

/** One produto list row as the list read returns it ({@link PRODUTO_LINHA_CAMPOS_LI}). */
export type ProdutoLinhaLi = {
  readonly [K in (typeof PRODUTO_LINHA_CAMPOS_LI)[number]]: LinhaLida[K];
};

type CampoEscalarDoDetalhe = Exclude<
  (typeof PRODUTO_DETALHE_CAMPOS_LI)[number],
  'imagem_principal' | 'imagens'
>;

/** One produto as the detail read returns it ({@link PRODUTO_DETALHE_CAMPOS_LI}). */
export type ProdutoDetalheLi = { readonly [K in CampoEscalarDoDetalhe]: DetalheLido[K] } & {
  readonly imagem_principal: ImagemDoProdutoLi | null | undefined;
  readonly imagens: readonly ImagemDoProdutoLi[];
};

function projetarImagem(i: ImagemLida): ImagemDoProdutoLi {
  return { id: i.id, caminho: i.caminho, principal: i.principal, posicao: i.posicao, mime: i.mime };
}

function projetarLinha(l: LinhaLida): ProdutoLinhaLi {
  return {
    id: l.id,
    tipo: l.tipo,
    sku: l.sku,
    nome: l.nome,
    gtin: l.gtin,
    ativo: l.ativo,
    bloqueado: l.bloqueado,
    removido: l.removido,
    filhos: l.filhos,
    categorias: l.categorias,
    grades: l.grades,
    variacoes: l.variacoes,
  };
}

function projetarDetalhe(d: DetalheLido): ProdutoDetalheLi {
  const principal = d.imagem_principal;
  return {
    ...projetarLinha(d),
    pai: d.pai,
    marca: d.marca,
    destaque: d.destaque,
    usado: d.usado,
    peso: d.peso,
    altura: d.altura,
    largura: d.largura,
    profundidade: d.profundidade,
    descricao_completa: d.descricao_completa,
    imagem_principal:
      principal === null || principal === undefined ? principal : projetarImagem(principal),
    imagens: d.imagens.map(projetarImagem),
  };
}

/* -------------------------------------------------------------------------- */
/*                             The produto reads                              */
/* -------------------------------------------------------------------------- */

export interface OpcoesPaginaProdutosLi {
  /** The page's offset: 0, then each page's `proximoOffset`. */
  readonly offset: number;
  /** The page size asked for: 1 to {@link MAX_LIMITE_PAGINA_PRODUTOS_LI}. */
  readonly limite: number;
  /** `false`: the live list; `true`: the trash. Sent on every page. */
  readonly removido: boolean;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

/**
 * One page of `GET /v1/produto/` with exactly `{ limit, removido, offset }`,
 * every row projected ({@link ProdutoLinhaLi}). A `limite` outside 1 to
 * {@link MAX_LIMITE_PAGINA_PRODUTOS_LI} is `LiConfigError('limite')` and nothing
 * is fetched.
 *
 * ⚠️ `removido` is a filter the provider applies; every row still carries its
 * own `removido`, for the caller to check.
 */
export async function lerPaginaProdutosLi(
  cliente: LiLeituraClient,
  opts: OpcoesPaginaProdutosLi,
): Promise<PaginaUnicaLi<ProdutoLinhaLi>> {
  const operacao = 'lerPaginaProdutos';
  const { limite } = opts;
  if (!Number.isSafeInteger(limite) || limite <= 0 || limite > MAX_LIMITE_PAGINA_PRODUTOS_LI) {
    throw new LiConfigError('limite', { operacao, refCredencial: null });
  }
  const pagina = await lerPaginaLi(cliente, {
    operacao,
    caminho: CAMINHO_PRODUTOS_LI,
    esquema: liProdutoLinhaSchema,
    offset: opts.offset,
    limite,
    query: { removido: opts.removido },
    sinal: opts.sinal,
  });
  return { ...pagina, linhas: pagina.linhas.map(projetarLinha) };
}

/**
 * `GET /v1/produto/{produtoId}/` with no query, projected
 * ({@link ProdutoDetalheLi}).
 *
 * A 404 is the client's `LiNotFoundError`, rethrown as-is, as the order reads
 * do (C10: an unknown id answers 404 with an empty body); what a product that
 * is gone means is the caller's call.
 *
 * ⚠️ The answer is not checked against `produtoId` here: the caller compares the
 * detail's `id` with the product it asked for.
 *
 * `async` on purpose: a refused id rejects the promise like every other
 * failure, rather than throwing before the caller holds one.
 */
export async function buscarProdutoLi(
  cliente: LiLeituraClient,
  produtoId: number | string,
  opts: OpcoesLeituraLi = {},
): Promise<RespostaLi<ProdutoDetalheLi>> {
  const operacao = 'buscarProduto';
  const id = idOuRecusa(produtoId, operacao);
  const resposta = await cliente.get({
    operacao,
    caminho: `${CAMINHO_PRODUTOS_LI}${id}/`,
    schema: liProdutoDetalheSchema,
    sinal: opts.sinal,
  });
  return {
    dados: projetarDetalhe(resposta.dados),
    status: resposta.status,
    correlationId: resposta.correlationId,
    refCredencial: resposta.refCredencial,
  };
}
