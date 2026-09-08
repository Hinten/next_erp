/**
 * ONE page of `get_brand_list`, projected.
 *
 * ⚠️ **No paging loop, here or anywhere.** The package fetches one page and
 * surfaces the cursor; this reader does the same, and the caller decides whether
 * to ask for another. Auto-paging would hide an unbounded number of provider
 * calls behind one `await` — and Shopee's brand API is slow enough that an
 * operator feels the difference. It is also the reason `brandshopee` exists as a
 * curated shortlist rather than as a mirror of this list.
 *
 * ⚠️ `nextOffset` is echoed VERBATIM. It is Shopee's cursor, not
 * `offset + pageSize`, and computing it would be a second source of truth for a
 * value the provider already sent.
 */
import { type ShopeeTaxonomiaCtx, lerMarcasCached } from './cache';
import { type MarcaDto, projetarMarcas } from './dto';

/** One page, as the route answers it. */
export interface PaginaDeMarcas {
  readonly categoryId: number;
  readonly status: number;
  readonly offset: number;
  readonly pageSize: number;
  readonly marcas: readonly MarcaDto[];
  readonly hasNextPage: boolean;
  /**
   * Shopee's cursor, echoed verbatim — feed it back as the next call's
   * `offset`. ⚠️ Page on `hasNextPage`, never on this being non-null: Shopee's
   * page documents the field only as "if `has_next_page` is true, this value
   * need set to next request.offset" and promises nothing about the last page,
   * so a loop that stopped on `null` could re-request the same page forever.
   */
  readonly nextOffset: number | null;
  readonly isMandatory: boolean | null;
  readonly inputType: string | null;
}

/** The request half of a page read — the same four values that key its cache entry. */
export interface LeituraDeMarcas {
  readonly categoryId: number;
  readonly status: number;
  readonly offset: number;
  readonly pageSize: number;
}

/**
 * The empty page a non-leaf category answers with.
 *
 * ⚠️ Built HERE rather than spelled out in the route, so the gated and ungated
 * answers cannot drift apart: a caller that renders one must be able to render
 * the other without checking which branch produced it.
 */
export function paginaDeMarcasVazia(p: LeituraDeMarcas): PaginaDeMarcas {
  return {
    categoryId: p.categoryId,
    status: p.status,
    offset: p.offset,
    pageSize: p.pageSize,
    marcas: [],
    hasNextPage: false,
    nextOffset: null,
    isMandatory: null,
    inputType: null,
  };
}

/** Read (and cache) one page of a leaf category's brands. */
export async function lerPaginaDeMarcas(
  ctx: ShopeeTaxonomiaCtx,
  p: LeituraDeMarcas,
): Promise<PaginaDeMarcas> {
  const pagina = await lerMarcasCached(ctx, p);
  return {
    categoryId: p.categoryId,
    status: p.status,
    offset: p.offset,
    pageSize: p.pageSize,
    // ⚠️ `brand_id: 0` — Shopee's "No Brand" — survives the projection as the
    // value it is. Anything that reads it as absent picks a brand the operator
    // did not choose.
    marcas: projetarMarcas(pagina.brand_list),
    hasNextPage: pagina.has_next_page,
    nextOffset: pagina.next_offset,
    isMandatory: pagina.is_mandatory,
    inputType: pagina.input_type,
  };
}
