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
 *  - every leaf a reader JUDGES rather than parses (a category's parent, an
 *    option's grade, a brand's `ativo`) read as `z.unknown()` and carried RAW,
 *    whatever its form or type: whether it names a parent, names this grade or
 *    says "active" is the reader's call, and one odd row is never a reason to
 *    refuse the page here (the `data_modificacao` precedent below). A resource
 *    URI nothing reads (`resource_uri`) is not declared at all: passthrough
 *    keeps it, and declaring it would only add a way to refuse a row.
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
 *  - `categoria_pai`: the parent's resource URI, or no parent — `null`, `''`
 *    (read as `null`) or an absent key (`undefined`) is a root. Anything else
 *    is carried RAW, whatever its type. The public document writes the URI as
 *    `/api/v1/categoria/<id>`; the owner's capture C9 answered
 *    `/v1/categoria/<id>`, WITHOUT the `/api` prefix that the brand, grade and
 *    option URIs carry. No form is assumed here: a parent the reader cannot
 *    place (another form, an object, a number) is ITS finding, never a root
 *    and never a refused page.
 *  - `resource_uri` (the same `/v1/categoria/<id>` form in C9) is unread and
 *    kept: nothing derives an id from it.
 *
 * ⚠️ `id: wireInt(),` stays on its own line: it is one of this file's three
 * guard anchors (header, "Numbers").
 */
export const liCategoriaSchema = z
  .object({
    id: wireInt(),
    nome: z.string(),
    categoria_pai: vazioComoNulo(z.unknown()),
  })
  .passthrough();

export type CategoriaLi = z.infer<typeof liCategoriaSchema>;

/**
 * One marca row (`GET /v1/marca/`). The listing carries every brand, inactive
 * ones included: `ativo` says which. C9 answered a boolean on every row;
 * `null` (`''` included) or `undefined` means the row did not say. Anything
 * else (a string `'true'`, a number) is carried RAW and is NOT folded into a
 * boolean here: what a non-boolean means is the reader's call, and one odd row
 * never hides the brand list, which a published product needs.
 * `apelido`, `descricao` (sometimes the STRING `"null"`), `destaque`, `imagem`
 * and `resource_uri` are unread and kept.
 */
export const liMarcaSchema = z
  .object({
    id: wireInt(),
    nome: z.string(),
    ativo: vazioComoNulo(z.unknown()),
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
 * `id`. `grade` is the URI of the grade it belongs to (`/api/v1/grades/<g>`,
 * plural, in the document and in C9), carried RAW whatever its type, absent
 * included: whether it names THIS grade is the reader's check, and an option
 * whose `grade` is absent, `null` or unreadable is still an option, never a
 * refused detail. Its `resource_uri` (`/api/v1/grade/<g>/variacao/<v>`,
 * singular) is unread and kept.
 *
 * ⚠️ The `.optional()` is load-bearing: Zod 4 rejects an ABSENT key under a
 * bare `z.unknown()` (`data_modificacao`, below).
 */
export const liOpcaoGradeSchema = z
  .object({
    id: wireInt(),
    nome: z.string(),
    grade: z.unknown().optional(),
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
