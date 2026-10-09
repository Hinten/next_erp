/**
 * Loja Integrada REST v1 wire schemas — RESPONSE shapes only, and only the ones
 * something consumes today: the Tastypie paging envelope and the categoria row
 * (the validating GET lists categorias).
 *
 * Every other resource (pedido, situação, produto, estoque, preço, imagem,
 * marca, grades, envio, pagamento) arrives with its first consumer, written
 * against captured responses rather than the public document's examples.
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
 * Tastypie's `meta` block.
 *
 * ⚠️ `limit` is read back, never assumed: the provider may cap a requested limit
 * (the public document's own `pedido/search` example answers `limit: 15`).
 * `next` / `previous` are RELATIVE paths under `/api/v1/…`, never followed
 * verbatim — `paginacao.ts` takes only their query string.
 */
export const liMetaSchema = z
  .object({
    limit: wireInt(),
    next: z.string().nullable(),
    offset: wireInt(),
    previous: z.string().nullable(),
    total_count: wireInt().nullable().optional(),
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
