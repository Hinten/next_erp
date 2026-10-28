/**
 * Loja Integrada REST v1 wire schemas — RESPONSE shapes only, and only the ones
 * something consumes: the Tastypie paging envelope, the pedido search row (the
 * order poller, master-plan step 3) and the catalogue rows the catalogue reads
 * parse (`catalogo.ts`, master-plan step 10): categoria, marca, grade, and a
 * grade's detail with its options.
 *
 * The catalogue rows were written against the leaf shapes of the owner's
 * catalogue capture C9 (every list and both kinds of grade detail answered 200
 * on the slash path) and the public document's examples. They read only what a
 * consumer decides on, as tolerantly as the provider's quirks require:
 *
 *  - ids through `wireInt()`, so one quoted id never costs a page;
 *  - optional text through `vazioComoNulo` (`vazio.ts`), so the provider's
 *    `''` reads as `null` and never refuses a page;
 *  - `id_externo` deliberately unread (the document types it `null`, and
 *    nothing here keys on it); ids come from `id`, never from a `resource_uri`;
 *  - every resource URI carried VERBATIM as a string, whatever its form:
 *    whether one names a parent or a grade is the reader's call, never a
 *    reason to refuse the page here.
 *
 * Every other resource (the produto, estoque, preço, imagem, envio) arrives
 * with its first consumer, written against captured responses rather than the
 * public document's examples (the pedido detail and situação are in
 * `pedidoTipos.ts`).
 *
 * ## Passthrough
 *
 * Every object is `.passthrough()`: Loja Integrada adds fields without notice,
 * and a schema that stripped them would hide exactly the drift a later step
 * needs to see.
 *
 * ## Numbers
 *
 * ⚠️ This file, `pedidoTipos.ts` and `vazio.ts` are the only ones under `src/`
 * that use Zod for numbers, and every one goes through `wireInt()` /
 * `wireNumber()` from `@delfrance/core/wire`: a serializer that quotes ONE
 * field must not cost the whole page (#1087).
 * Enforced by
 * `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`,
 * which scans every file under `src/` and anchors on three lines of this file.
 * ⚠️ Keep each anchored field on its own short line, so Prettier never wraps it
 * out of the guard's line-based scan.
 */
import { wireInt } from '@delfrance/core/wire';
import { z } from 'zod';

import { inteiroOpcional, vazioComoNulo } from './vazio';

/**
 * Tastypie's `meta` block.
 *
 * ⚠️ `limit` is read back, never assumed: the provider may cap a requested limit
 * (the public document's own `pedido/search` example answers `limit: 15`).
 * `next` / `previous` are RELATIVE paths under `/api/v1/…`, never followed
 * verbatim — `paginacao.ts` takes only their query string.
 *
 * `total_count` absent, `null` and `''` are one outcome: no total announced
 * (`inteiroOpcional()`, `vazio.ts`) — never `0`. `limit` and `offset` are
 * required, and so are a row's `id` and `numero` below: an empty one is refused
 * at its own path.
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
 * One categoria row (`GET /v1/categoria/`, also the validating GET's list).
 *
 *  - `categoria_pai`: the parent's resource URI, carried VERBATIM, or no parent
 *    — `null`, `''` (read as `null`) or an absent key (`undefined`) is a root.
 *    The document writes the URI as `/api/v1/categoria/<id>`; the captured
 *    form did not match `/api/v1/…`, so no form is assumed here, and a URI the
 *    reader cannot place is ITS finding (never a root, never a refused page).
 *  - `resource_uri`: optional, since nothing derives an id from it.
 *
 * ⚠️ `id: wireInt(),` stays on its own line: it is one of this file's three
 * guard anchors (header, "Numbers").
 */
export const liCategoriaSchema = z
  .object({
    id: wireInt(),
    nome: z.string(),
    categoria_pai: vazioComoNulo(z.string()),
    resource_uri: z.string().optional(),
  })
  .passthrough();

export type CategoriaLi = z.infer<typeof liCategoriaSchema>;

/**
 * One marca row (`GET /v1/marca/`). The listing carries every brand, inactive
 * ones included: `ativo` says which, and `null` (`''` included) or `undefined`
 * means the row did not say. Only the exact `''` reads as `null`; a string
 * `'true'` or a number is NOT folded into a boolean, it is refused.
 * `apelido`, `descricao` (sometimes the STRING `"null"`), `destaque`, `imagem`
 * and `resource_uri` are unread and kept.
 */
export const liMarcaSchema = z
  .object({
    id: wireInt(),
    nome: z.string(),
    ativo: vazioComoNulo(z.boolean()),
  })
  .passthrough();

export type MarcaLi = z.infer<typeof liMarcaSchema>;

/**
 * One grade row (`GET /v1/grades/`): the store's own grades and the platform's
 * alike, which no field tells apart. `nome` is the grade's identity label;
 * `nome_visivel` is what a storefront shows, often `''` (read as `null`) or
 * `null`. Only the exact `''` is empty: a blank `' '` is kept as sent.
 * `specification_id` and `resource_uri` are unread and kept.
 */
export const liGradeSchema = z
  .object({
    id: wireInt(),
    nome: z.string(),
    nome_visivel: vazioComoNulo(z.string()),
  })
  .passthrough();

export type GradeLi = z.infer<typeof liGradeSchema>;

/**
 * One option of a grade (`variacoes[]` of `GET /v1/grades/{id}/`). Its id is
 * `id`. `grade` is the URI of the grade it belongs to (the document writes it
 * `/api/v1/grades/<g>`, plural), carried VERBATIM and optional: whether it
 * names THIS grade is the reader's check, and an option without one is still
 * an option. Its `resource_uri` (`/api/v1/grade/<g>/variacao/<v>`, singular,
 * in the document) is unread and kept.
 */
export const liOpcaoGradeSchema = z
  .object({
    id: wireInt(),
    nome: z.string(),
    grade: z.string().optional(),
  })
  .passthrough();

export type OpcaoGradeLi = z.infer<typeof liOpcaoGradeSchema>;

/**
 * One grade with its options (`GET /v1/grades/{id}/`). `variacoes` is
 * REQUIRED: the options are the read's whole point, so a detail without them
 * is refused rather than read as a grade with none (`[]` is a grade with none).
 */
export const liGradeDetalheSchema = liGradeSchema.extend({
  variacoes: z.array(liOpcaoGradeSchema),
});

export type GradeDetalheLi = z.infer<typeof liGradeDetalheSchema>;

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
