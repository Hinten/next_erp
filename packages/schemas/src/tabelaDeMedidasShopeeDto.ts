import { z } from 'zod';

import { tabelaShopeeProjetadaSchema } from './tabelaDeMedidasShopeeProjecao';

/**
 * The ENVELOPES of the two Shopee size-chart routes (step 18, #1526) —
 * `GET /api/marketplace/shopee/tabela-medidas/lista` and `…/detalhe` in
 * `apps/shopee`, read by the `/medidas` Shopee tab in `apps/web`.
 *
 * ## Why here, and declared ONCE
 *
 * `apps/web` cannot import `apps/shopee`, so these shapes used to be written
 * twice — the route's `tabelaMedidas/dto.ts` and the browser's
 * `lib/shopee/wire.ts` — each with a comment saying the names matched the
 * other. That is the #1369 shape: two copies the compiler cannot compare, which
 * drift toward plausible and read correct while disagreeing. Both apps reach
 * this package, so the route builds its 200 against these types, its tests
 * parse that 200 with these schemas, and the browser parses the same bytes with
 * the same schemas — a renamed key is a compile error on both sides instead of
 * a `ShopeeClientRespostaInvalidaError` in production.
 *
 * ## Names
 *
 * A field carrying a PROVIDER value is Shopee's own name in camelCase —
 * `sizeChartId`, `sizeChartName`, `categoryId`, `totalCount` — never a
 * translation; a key the route INVENTS is pt-BR (`tabelas`, `truncado`,
 * `removidas`, `idsIlegiveis`, `legivel`, `tabela`), except `leaf`, kept from
 * the `taxonomia/variacoes` leaf-gate answer.
 *
 * ## Strict numbers, tolerant objects (deploy skew)
 *
 * `apps/web` and `apps/shopee` deploy separately, so the browser is routinely
 * one deploy OLDER or NEWER than the route answering it:
 * - every object is a plain `z.object` — an unknown key is STRIPPED, never a
 *   failure, so a newer route's extra field cannot cost an older browser;
 * - every field is REQUIRED — each route answers all of them on every 200, and
 *   a missing `truncado` read as "complete" would be a silent lie;
 * - every number is plain `z.number().int()`, never `wireInt()`: these describe
 *   OUR answers, whose provider ids already went through the package's tolerant
 *   wire readers, so a quoted number here is our own serialisation bug and must
 *   be loud.
 *
 * The projected chart inside `detalhe` is {@link tabelaShopeeProjetadaSchema},
 * the projector's own output schema — nested WHOLE under `tabela`, never
 * spread, never mirrored.
 */

/** One template in the list: its id, its name (from the detail read) and whether that read is usable. */
export const tabelaMedidasLinhaDtoSchema = z.object({
  /** Shopee's `size_chart_id` — a positive integer (the package's row reader refuses `0`). */
  sizeChartId: z.number().int(),
  /** `get_size_chart_detail.size_chart_name`, verbatim; `null` when absent or when `legivel` is `false`. */
  sizeChartName: z.string().nullable(),
  /**
   * `false` ⇒ the template's DETAIL is not usable — it did not parse, or it
   * answered for another `size_chart_id`. The row is still listed and still
   * pickable by id: attaching it needs only the id.
   */
  legivel: z.boolean(),
});

/** `GET …/tabela-medidas/lista` — 200. */
export const listaTabelasMedidasDtoSchema = z.object({
  /**
   * The category's leaf verdict. `false` ⇒ nothing was listed (`tabelas: []`,
   * zero Shopee list calls): Shopee attaches charts to LEAF categories only.
   */
  leaf: z.boolean(),
  /** The REQUESTED category id. */
  categoryId: z.number().int(),
  /** Shopee's order, deduplicated by NUMBER (the first sighting keeps its position). */
  tabelas: z.array(tabelaMedidasLinhaDtoSchema),
  /** The FIRST page's `total_count` — a diagnostic, never a loop bound; `null` when absent or unreadable. */
  totalCount: z.number().int().nullable(),
  /**
   * `true` ⇒ there may be templates this answer does not show: the page cap
   * stopped the walk, a cursor failed to advance, or the last page carried no
   * cursor and `totalCount` was not met.
   */
  truncado: z.boolean(),
  /** Listed, then "not exist" at detail time (deleted in Seller Centre in between) — dropped from `tabelas`. */
  removidas: z.number().int(),
  /** List rows whose id was unreadable (the package reader's `null` rows) — counted, never shown. */
  idsIlegiveis: z.number().int(),
});

/** `GET …/tabela-medidas/detalhe` — 200. The table nested WHOLE under one key, never spread. */
export const detalheTabelaMedidasDtoSchema = z.object({ tabela: tabelaShopeeProjetadaSchema });

export type TabelaMedidasLinhaDto = z.infer<typeof tabelaMedidasLinhaDtoSchema>;
export type ListaTabelasMedidasDto = z.infer<typeof listaTabelasMedidasDtoSchema>;
export type DetalheTabelaMedidasDto = z.infer<typeof detalheTabelaMedidasDtoSchema>;
