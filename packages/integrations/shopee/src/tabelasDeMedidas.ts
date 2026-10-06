/**
 * Size charts (step 18, #1526) — the paths, request shapes, bound guards and
 * wire constants of the two `v2.product.*` READS {@link ShopeeClient} runs to
 * list a shop's size-chart TEMPLATES for a category and to read one, the
 * ONE reader of a list page, and — PR 5 — the `size_chart_info` block that
 * `add_item` / `update_item` carry to ATTACH one
 * ({@link ShopeeSizeChartInfoRequest}, one key: a template id or an image id).
 *
 * The operations themselves are `api.ts`'s (`getSizeChartList`,
 * `getSizeChartDetail`); their response schemas are `types.ts`'s section
 * "Size charts (step 18)". This module holds what they share — the
 * `logistica.ts` / `devolucoes.ts` split, for the same reason: `api.ts` must not
 * grow by another step's worth of request types and guards.
 *
 * ⚠️ **Read-only.** Templates are authored in Seller Centre; Shopee publishes no
 * authoring API, and `update_size_chart` was never one (it attached an IMAGE
 * to one item). Which template a listing carries is the app's record, never
 * derived from these reads.
 *
 * ⚠️ **Both reads are `GET` with the parameters in the QUERY STRING** — the
 * pages' own `method: 2` and every sample on them. The issue's "`POST` with a
 * body" came from the doc reader's `is_get_method` misreading. The page TYPES
 * `category_id` / `page_size` as strings: moot on a GET, where every query value
 * is text, and `String(n)` of a safe integer carries no exponent and no `.0`.
 * Neither page takes a `language` (only the GlobalProduct twin does).
 *
 * ⚠️ **The paths carry NO trailing space.** The list page's module listing is
 * named `"v2.product.get_size_chart_list "` and announcement 1404 links it with
 * a `%20`; the wire path is the page header's, without it.
 *
 * ⚠️ **This module never imports `api.ts`** — the edge runs the other way
 * (`api.ts` imports this one), which is why its numeric guard is a LOCAL copy,
 * exactly as `logistica.ts` and `devolucoes.ts` keep their own.
 *
 * ⚠️ **Every guard runs BEFORE the access token is asked for**, every branch is
 * a `ShopeeConfigError` (a caller bug, never a provider failure), and **no guard
 * message carries a VALUE** — each names the FIELD and a type.
 *
 * ⚠️ **`0` is refused for every id.** `size_chart_id: 0` is the DETACH sentinel
 * of `add_item` / `update_item`'s `size_chart_info`, and `0` is no category, so
 * neither read may ever be asked for one — and the list row reader in
 * `types.ts` refuses the same values (one value table, pinned by
 * `test/tabelasDeMedidas.test.ts`), so an id Shopee LISTS can always be
 * DETAILED.
 *
 * ⚠️ A stale id and a category Shopee will not take arrive as the SAME code —
 * `ShopeeApiError { code: 'product.error_param', kind: 'other' }` — told apart
 * only by `providerMessage` ("Size chart id not exist in this shop" vs
 * "Category id is invalid"). No classifier lives here: the app reads the
 * sentence (`apps/shopee/lib/shopee/tabelaMedidas/`), never `.message`.
 */
import { ShopeeConfigError } from './errors';
import type { ShopeeSizeChartList } from './types';

/* -------------------------------------------------------------------------- */
/*                                 The paths                                  */
/* -------------------------------------------------------------------------- */

/** `GET` — ONE page of this shop's TEMPLATE size charts for ONE category. Ids only — no names. */
export const SHOPEE_GET_SIZE_CHART_LIST_PATH = '/api/v2/product/get_size_chart_list';
/** `GET` — one template's table (column-oriented) and its NAME (names exist only here). */
export const SHOPEE_GET_SIZE_CHART_DETAIL_PATH = '/api/v2/product/get_size_chart_detail';

/* -------------------------------------------------------------------------- */
/*                             The wire constants                             */
/* -------------------------------------------------------------------------- */

/** `get_size_chart_list.page_size` — "Max=50", REQUIRED; no minimum stated (1). */
export const SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE = 50;

/**
 * `next_cursor` on the LAST page (the page's own sample). ⚠️ Never sent back:
 * `''` is ALSO the page's default for `cursor`, so sending it restarts at page
 * 1 and a walker that fed it back would loop — the guard refuses it.
 */
export const SHOPEE_SIZE_CHART_LIST_DRAINED = '';

/* -------------------------------------------------------------------------- */
/*                             The request shapes                             */
/* -------------------------------------------------------------------------- */

/** `get_size_chart_list` — ONE page; the client never auto-pages. */
export interface GetSizeChartListParams {
  /**
   * Positive safe integer. The page says "category id under this shop"; the
   * LEAF gate is the app's (step 10's `ehFolha`) — what a non-leaf id answers is
   * unverified (register 251).
   */
  readonly categoryId: number;
  /** 1…{@link SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE}, REQUIRED. */
  readonly pageSize: number;
  /**
   * The previous page's `next_cursor`, VERBATIM and OPAQUE — never trimmed,
   * never parsed (the sample `1683255510` looks like epoch seconds; it is
   * text). ABSENT on page 1, so no `cursor` key goes out. `''` is REFUSED
   * ({@link SHOPEE_SIZE_CHART_LIST_DRAINED}); a whitespace cursor is NOT — it
   * travels byte-identical.
   */
  readonly cursor?: string;
}

/** `get_size_chart_detail` — one template. */
export interface GetSizeChartDetailParams {
  /** Positive safe integer — exactly what the list row reader accepts. */
  readonly sizeChartId: number;
}

/* -------------------------------------------------------------------------- */
/*                                The guards                                  */
/* -------------------------------------------------------------------------- */

/** `typeof`, with `null` named — the only thing a refusal may say about the value. */
function tipoDe(valor: unknown): string {
  return valor === null ? 'null' : typeof valor;
}

/** A positive safe integer. Local copy of `api.ts`'s `assertIdPositivo`, without the value echo. */
function assertIdPositivo(nome: string, valor: unknown): void {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) {
    throw new ShopeeConfigError(
      `${nome} deve ser um inteiro positivo (recebido: ${tipoDe(valor)}).`,
    );
  }
}

/** Every `get_size_chart_list` bound, checked BEFORE the access token is asked for. */
export function assertSizeChartListParams(p: GetSizeChartListParams): void {
  assertIdPositivo('category_id', p.categoryId);

  const tamanho: unknown = p.pageSize;
  if (
    typeof tamanho !== 'number' ||
    !Number.isSafeInteger(tamanho) ||
    tamanho < 1 ||
    tamanho > SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE
  ) {
    throw new ShopeeConfigError(
      `page_size deve ser um inteiro de 1 a ${String(SHOPEE_SIZE_CHART_LIST_MAX_PAGE_SIZE)} (recebido: ${tipoDe(tamanho)}).`,
    );
  }

  // A JS caller (or a cast) can still pass anything; the type cannot.
  const cursor: unknown = p.cursor;
  if (cursor === undefined) return;
  if (typeof cursor !== 'string') {
    throw new ShopeeConfigError(
      `cursor deve ser um texto — o next_cursor anterior, verbatim (recebido: ${tipoDe(cursor)}).`,
    );
  }
  // ⚠️ ONLY the drained sentinel. A whitespace cursor is judged, never
  // rewritten: it travels as Shopee sent it.
  if (cursor === SHOPEE_SIZE_CHART_LIST_DRAINED) {
    throw new ShopeeConfigError(
      'cursor não pode ser vazio — "" é a última página (e o padrão da Shopee, que recomeçaria da primeira); omita a chave na página 1.',
    );
  }
}

/** The `get_size_chart_detail` bound, checked BEFORE the access token is asked for. */
export function assertSizeChartDetailParams(p: GetSizeChartDetailParams): void {
  assertIdPositivo('size_chart_id', p.sizeChartId);
}

/* -------------------------------------------------------------------------- */
/*                         The page — one reader                              */
/* -------------------------------------------------------------------------- */

/**
 * Where the list goes next. THREE values on purpose: an ABSENT cursor is not a
 * proof of exhaustion (register 249).
 */
export type ContinuacaoDaListaDeTabelas =
  /** `next_cursor === ''` exactly — the last page. */
  | { readonly estado: 'fim' }
  /** A non-empty cursor, VERBATIM — never trimmed. */
  | { readonly estado: 'seguinte'; readonly cursor: string }
  /** `next_cursor` absent or `null` — nothing to send; the walker decides `truncado`. */
  | { readonly estado: 'sem-cursor' };

/** One `get_size_chart_list` page, read. */
export interface PaginaDeTabelasDeMedidas {
  /** Readable ids, in Shopee's order, NOT deduplicated (dedupe across pages is the walker's). */
  readonly ids: readonly number[];
  /** Rows the schema could not read (the `null` sentinels) — counted, never dropped in silence. */
  readonly linhasIlegiveis: number;
  /** `total_count`, informative only — NEVER a terminator (`null` when absent/unreadable). */
  readonly total: number | null;
  readonly continuacao: ContinuacaoDaListaDeTabelas;
}

/** `next_cursor` → the continuation. Anything that is not a string reads `sem-cursor`. */
function continuacaoDe(cursor: unknown): ContinuacaoDaListaDeTabelas {
  if (typeof cursor !== 'string') return { estado: 'sem-cursor' };
  if (cursor === SHOPEE_SIZE_CHART_LIST_DRAINED) return { estado: 'fim' };
  return { estado: 'seguinte', cursor };
}

/**
 * The ONE reader of a list page. Pure and total: `size_chart_list` `null` or
 * absent → no ids; a `null` row (the schema's per-row sentinel) is COUNTED in
 * `linhasIlegiveis` and absent from `ids`; `next_cursor` → the three-valued
 * {@link ContinuacaoDaListaDeTabelas}. ⚠️ `total_count` never decides the
 * continuation — a short page with `total` met still says `seguinte` when a
 * cursor came back.
 */
export function lerPaginaDeTabelasDeMedidas(p: ShopeeSizeChartList): PaginaDeTabelasDeMedidas {
  const ids: number[] = [];
  let linhasIlegiveis = 0;
  for (const linha of p.size_chart_list ?? []) {
    if (linha === null) linhasIlegiveis += 1;
    else ids.push(linha.size_chart_id);
  }
  return {
    ids,
    linhasIlegiveis,
    total: p.total_count ?? null,
    continuacao: continuacaoDe(p.next_cursor),
  };
}

/* -------------------------------------------------------------------------- */
/*                  The attach — `size_chart_info` (PR 5)                     */
/* -------------------------------------------------------------------------- */

/**
 * `add_item` / `update_item`'s `size_chart_info` — **EXACTLY ONE key**: a
 * TEMPLATE id (`size_chart_id`, what the `/medidas` pick stores) or an IMAGE id
 * (`size_chart`, an `upload_image` id — the legacy fallback to the tabela's
 * first photo). The same block on both pages, verbatim.
 *
 * ⚠️ **One key, enforced by the type.** The pages say "if both are filled, only
 * the template will be kept" — so a body carrying both would upload a picture
 * Shopee then throws away, and whoever reads the request later cannot tell
 * which one the publisher meant. A plain `{ size_chart_id } | { size_chart }`
 * union would NOT say so (excess-property checks run against the union as a
 * whole, so `{ size_chart_id, size_chart }` would compile); the `?: never` on
 * each arm is what makes "both" a type error, and requiring the arm's own key
 * is what makes "neither" one. `test/api.test.ts` pins both with
 * `@ts-expect-error`.
 *
 * ⚠️ **Never a detach.** `size_chart_id: 0` and `size_chart: ""` are the pages'
 * REMOVE sentinels. Nothing here ever sends one: an ERP publish with no match
 * OMITS the key, so a chart set in Seller Centre survives a field-wise update
 * ({@link assertSizeChartInfoRequest} refuses both sentinels).
 *
 * ⚠️ `size_chart_id` is a JSON **number** — the pages' `int64` and the legacy's
 * Dart `int`. Announcement 1404's table types it as a string; which one the
 * server accepts on write is unverified (register 262).
 */
export type ShopeeSizeChartInfoRequest =
  | {
      /** Positive safe integer — a template of this shop. Never `0` (detach). */
      readonly size_chart_id: number;
      readonly size_chart?: never;
    }
  | {
      /** A non-blank `upload_image` id. Never `''` (detach); never a URL (that is the READ side). */
      readonly size_chart: string;
      readonly size_chart_id?: never;
    };

/**
 * The `size_chart_info` bound, called by the add/update guards BEFORE the
 * access token is asked for.
 *
 * Counted over DEFINED values, never over keys — the `assertUpdateItemParams`
 * rule: `exactOptionalPropertyTypes` is off, so `{ size_chart_id: 7,
 * size_chart: undefined }` is legal TypeScript and `JSON.stringify` drops the
 * `undefined` one, which leaves exactly one key on the wire. A JS caller (or a
 * cast) can still pass anything, so `null`, a non-object and a non-string image
 * id are refused here rather than serialised.
 */
export function assertSizeChartInfoRequest(info: ShopeeSizeChartInfoRequest): void {
  const bloco: unknown = info;
  if (typeof bloco !== 'object' || bloco === null || Array.isArray(bloco)) {
    throw new ShopeeConfigError(
      `size_chart_info deve ser um objeto com size_chart_id OU size_chart (recebido: ${tipoDe(bloco)}).`,
    );
  }
  const { size_chart_id: modelo, size_chart: imagem } = bloco as Record<string, unknown>;
  const temModelo = modelo !== undefined;
  const temImagem = imagem !== undefined;
  if (temModelo && temImagem) {
    throw new ShopeeConfigError(
      'size_chart_info leva UMA chave — size_chart_id (modelo) OU size_chart (imagem), nunca as duas: a Shopee manteria só o modelo.',
    );
  }
  if (!temModelo && !temImagem) {
    throw new ShopeeConfigError(
      'size_chart_info precisa de size_chart_id (modelo) ou size_chart (imagem) — sem nenhum dos dois, omita a chave.',
    );
  }
  if (temModelo) {
    // ⚠️ `0` is the template DETACH sentinel — refused like every other non-id.
    assertIdPositivo('size_chart_info.size_chart_id', modelo);
    return;
  }
  // ⚠️ `''` is the image DETACH sentinel; a blank id is refused with it.
  if (typeof imagem !== 'string' || imagem.trim() === '') {
    throw new ShopeeConfigError(
      `size_chart_info.size_chart deve ser um image_id não vazio — "" removeria a tabela do anúncio (recebido: ${tipoDe(imagem)}).`,
    );
  }
}
