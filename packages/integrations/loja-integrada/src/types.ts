/**
 * Loja Integrada REST v1 wire schemas — RESPONSE shapes only, and only the ones
 * something consumes today: the Tastypie paging envelope, the categoria row
 * (the validating GET lists categorias) and the pedido search row (the order
 * poller, master-plan step 3).
 *
 * Every other resource (the pedido detail, situação, produto, estoque, preço,
 * imagem, marca, grades, envio, pagamento) arrives with its first consumer,
 * written against captured responses rather than the public document's
 * examples.
 *
 * ## Passthrough
 *
 * Every object is `.passthrough()`: Loja Integrada adds fields without notice,
 * and a schema that stripped them would hide exactly the drift a later step
 * needs to see.
 *
 * ## Numbers
 *
 * ⚠️ This is the ONLY file under `src/` that uses Zod for numbers, and every one
 * goes through `wireInt()` / `wireNumber()` from `@delfrance/core/wire`: a
 * serializer that quotes ONE field must not cost the whole page (#1087).
 * Enforced by
 * `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`,
 * which scans every file under `src/` and anchors on three lines of this file.
 * ⚠️ Keep each anchored field on its own short line, so Prettier never wraps it
 * out of the guard's line-based scan.
 */
import { wireInt } from '@delfrance/core/wire';
import { z } from 'zod';

/**
 * An OPTIONAL leaf that also reads an exact `''` as `null`. The provider writes
 * `''` for "nothing" on other leaves of this API (the sanitized captures carry
 * it on text fields), and `wireInt()` alone refuses it — `.nullable()` does not
 * help, since `''` is not `null` — so one empty optional number would cost the
 * whole page.
 *
 *  - Only the exact `''`. A whitespace-only string is still handed to the
 *    schema and refused: the captures hold none, and a blank the provider
 *    never sends is a drift worth seeing.
 *  - A non-empty string that is not one integer (`'abc'`, `'2.5'`) is still
 *    refused by `wireInt()`.
 *  - A REQUIRED leaf never gets it (`limit`, `offset`, a row's `id` or
 *    `numero`), so an empty one is refused at its own path.
 *
 * ⚠️ The `.optional()` sits OUTSIDE the preprocess, so an absent key never
 * reaches it and stays `undefined`.
 */
function vazioComoNulo<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (v === '' ? null : v), schema.nullable()).optional();
}

/** {@link vazioComoNulo} over `wireInt()`: an optional count or id. */
const inteiroOpcional = () => vazioComoNulo(wireInt());

/**
 * Tastypie's `meta` block.
 *
 * ⚠️ `limit` is read back, never assumed: the provider may cap a requested limit
 * (the public document's own `pedido/search` example answers `limit: 15`).
 * `next` / `previous` are RELATIVE paths under `/api/v1/…`, never followed
 * verbatim — `paginacao.ts` takes only their query string.
 *
 * `total_count` absent, `null` and `''` are one outcome: no total announced.
 * ⚠️ Never `0` for `''` — a total of zero claims an EMPTY window, which is a
 * statement the provider did not make.
 */
export const liMetaSchema = z
  .object({
    limit: wireInt(),
    next: z.string().nullable(),
    offset: wireInt(),
    previous: z.string().nullable(),
    total_count: inteiroOpcional(),
  })
  .passthrough();

export type MetaLi = z.infer<typeof liMetaSchema>;

/** `{ meta, objects }` — every Tastypie list answer, with its row schema. */
export function liEnvelopeSchema<S extends z.ZodType>(linha: S) {
  return z
    .object({
      meta: liMetaSchema,
      objects: z.array(linha),
    })
    .passthrough();
}

/**
 * One categoria row. `categoria_pai` is the parent's resource URI
 * (`/api/v1/categoria/<id>`) or `null` for a root categoria.
 */
export const liCategoriaSchema = z
  .object({
    id: wireInt(),
    nome: z.string(),
    categoria_pai: z.string().nullable(),
    resource_uri: z.string(),
  })
  .passthrough();

export type CategoriaLi = z.infer<typeof liCategoriaSchema>;

/**
 * One row of `GET /v1/pedido/search` as the order poller reads it: only what it
 * decides on, everything else kept by `.passthrough()`. The poller never maps
 * an order (the importer re-fetches it by `numero`, D13).
 *
 *  - `numero`: the order key, a JSON number or a quoted one (`wireInt()`). A
 *    row without it costs the page, because nothing can be enqueued for it.
 *  - `data_modificacao`: deliberately `z.unknown().optional()`. Its shape is
 *    canonicalised by the app (`lerDataLi`), which turns anything unexpected —
 *    an absent key included — into a per-row `formato-de-data`: one odd stamp
 *    must never cost the whole page, or the other rows on it would not be
 *    enqueued either. ⚠️ The `.optional()` is load-bearing: Zod 4 rejects an
 *    ABSENT key under a bare `z.unknown()` (`expected nonoptional`), which
 *    would fail the page for one row.
 *
 * ⚠️ `numero` passes here as ANY safe integer, zero and negatives included; the
 * task payload's grammar (`numeroPedidoLiSchema`, positive decimal) is checked
 * where the payload is built.
 *
 * Written first against the public document's two example rows, then
 * CONFIRMED by the owner's C1 captures (the `pedido-search-*` fixtures of
 * `apps/loja-integrada`): every captured row passes it, its `data_modificacao`
 * is already a canonical stamp, and the filtered search lists no row below the
 * bound it was sent — pinned by
 * `apps/loja-integrada/lib/lojaIntegrada/pedidos/capturasBusca.test.ts`.
 * ⚠️ The captured rows come ordered by `numero`, NOT by `data_modificacao`;
 * the poller deliberately assumes no order (its cursor is the max stamp over
 * the whole drain).
 */
export const liPedidoBuscaLinhaSchema = z
  .object({
    numero: wireInt(),
    data_modificacao: z.unknown().optional(),
  })
  .passthrough();

export type PedidoBuscaLinhaLi = z.infer<typeof liPedidoBuscaLinhaSchema>;
