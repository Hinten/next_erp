/**
 * Loja Integrada REST v1 wire schemas — RESPONSE shapes only, and only the ones
 * something consumes: the Tastypie paging envelope, the pedido search row (the
 * order poller, master-plan step 3), the catalogue rows the catalogue reads
 * parse (`catalogo.ts`, master-plan step 10): categoria, marca, grade, and a
 * grade's detail with its options; and the produto list row, detail and image
 * the product import reads (`produtos.ts`, master-plan step 9).
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
 * The produto schemas, at the end of this file, follow the same rules. They were
 * written against the public document's examples and checked against the
 * shapes of the owner's produto capture C10 (the list with and without
 * `removido`, its trash, a parent's and a child's detail).
 *
 * Every other resource (estoque, preço, imagem, envio) arrives with its first
 * consumer, written against captured responses rather than the public
 * document's examples (the pedido detail and situação are in `pedidoTipos.ts`).
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
import { wireInt, wireNumber } from '@delfrance/core/wire';
import { z } from 'zod';

import { inteiroOpcional, numeroOpcional, vazioComoNulo } from './vazio';

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

/* -------------------------------------------------------------------------- */
/*                   The produto (master-plan step 9, `produtos.ts`)          */
/* -------------------------------------------------------------------------- */

/**
 * A list leaf the import reads as a list: absent, `null` and `''` are the
 * provider's three spellings of "none", and all read as `[]` (a child row
 * carries no `filhos` and no `grades` key at all). An element that is not an
 * `item` still refuses the body.
 */
function listaOuVazia<T extends z.ZodType>(item: T) {
  return vazioComoNulo(z.array(item)).transform((v) => v ?? []);
}

/**
 * A leaf kept AS SENT, a string or a number: `peso` (a decimal STRING,
 * `"0.200"`, sometimes with float noise, `"0.450000000000000011…"`). A string is
 * never converted here: what it means (a plain decimal, a comma decimal, noise)
 * is the reader's call, made in one place, so the text reaches it verbatim. A
 * number must be one (`wireNumber()`), `''` reads as `null`, anything else (an
 * object, a boolean) refuses the body.
 */
function textoOuNumeroComoVeio() {
  return vazioComoNulo(z.union([z.string(), wireNumber()]));
}

/**
 * One image of a produto detail (`imagem_principal`, `imagens[]`). Every leaf
 * is a leaf the reader JUDGES (the header's rule), so every one is carried RAW
 * (`z.unknown()`, `''` read as `null`), whatever its type: an image whose `id`
 * is not an integer or whose `caminho` is not text still parses, and what it is
 * worth (kept, or discarded and counted) is the reader's call. One odd image
 * never costs its product, nor the other images beside it.
 *
 * ⚠️ That tolerance is per LEAF: an element of `imagens` that is not an object
 * at all (a string, a number, a list) is a drift of the list itself and still
 * refuses the body, at `imagens[]` (`listaOuVazia`).
 *
 *  - `id`: the image's own id; `imagem_id` (another one) is unread.
 *  - `caminho`: the CDN path, RELATIVE — the only address a photo is ever
 *    fetched from, under the pinned CDN host (`cdn.ts` checks it again before
 *    any fetch). The absolute URLs beside it (`grande`, `media`, `pequena`,
 *    `icone`) are never read: a host named in a body is not one this package
 *    contacts.
 *  - `principal`: judged by the reader (the brand's `ativo` rule).
 *  - `posicao`: as sent (`"0"`, or `null` in the document's second image).
 *  - `mime`: `"image/jpeg"`, `"image/png"` or `null` in the document.
 *    Informational only: a fetched photo's type is decided from its bytes.
 */
export const liImagemProdutoSchema = z
  .object({
    id: vazioComoNulo(z.unknown()),
    caminho: vazioComoNulo(z.unknown()),
    principal: vazioComoNulo(z.unknown()),
    posicao: vazioComoNulo(z.unknown()),
    mime: vazioComoNulo(z.unknown()),
  })
  .passthrough();

/**
 * One row of `GET /v1/produto/`: the live list (`removido=false`) and the trash
 * (`removido=true`) alike. Variations ARE rows (`tipo: atributo_opcao`),
 * between their parents (`atributo`) and simple products (`normal`), in an
 * order nothing relies on; a parent names its children in `filhos`, a child
 * names its options in `variacoes` and carries no `pai`.
 *
 *  - `id`: `wireInt()`, so a quoted id never costs a page.
 *  - `tipo`: a plain string, never an enum. A value this package does not know
 *    still parses: what it means is the importer's call, never a refused page.
 *  - `sku`, `nome`, `gtin`: text kept VERBATIM (`' X '` stays `' X '`: the SKU
 *    is an identity); `''` reads as `null` (`nome` is `null` on many children).
 *  - `ativo`, `bloqueado`, `removido`: carried raw and judged by the reader, as
 *    the brand's `ativo` is: one odd flag never hides a page of products.
 *  - `filhos`, `categorias`, `grades`, `variacoes`: resource URIs, each carried
 *    verbatim (`listaOuVazia`); which resource one names is the reader's call.
 *
 * `seo`, `url`, `tags`, `apelido`, `descricao_completa` and the rest ride
 * `.passthrough()`; the produto reads return a PROJECTION that leaves them
 * behind (`produtos.ts`).
 */
export const liProdutoLinhaSchema = z
  .object({
    id: wireInt(),
    tipo: z.string(),
    sku: vazioComoNulo(z.string()),
    nome: vazioComoNulo(z.string()),
    gtin: vazioComoNulo(z.string()),
    ativo: vazioComoNulo(z.unknown()),
    bloqueado: vazioComoNulo(z.unknown()),
    removido: vazioComoNulo(z.unknown()),
    filhos: listaOuVazia(z.string()),
    categorias: listaOuVazia(z.string()),
    grades: listaOuVazia(z.string()),
    variacoes: listaOuVazia(z.string()),
  })
  .passthrough();

/**
 * One produto, `GET /v1/produto/{id}/`: the row's leaves plus what only a
 * detail carries. A child's detail carries its own `peso` and dimensions, its
 * `pai` and its option URIs, and no images and no categories; a parent's, its
 * `marca`, its `grades` and its images.
 *
 *  - `pai`, `marca`: a resource URI, or `null`.
 *  - `peso`: as sent (`textoOuNumeroComoVeio`): a decimal STRING in the
 *    document and in C10, possibly with float noise; a number parses too.
 *  - `altura`, `largura`, `profundidade`: integers in both sources, read with
 *    `numeroOpcional()` so a quoted or fractional size still parses.
 *  - `destaque`, `usado`: carried raw, like the row's flags.
 *  - `descricao_completa`: the HTML description; `''` reads as `null`. The
 *    plain GET carries it (C10: the `descricao_completa=1` flag changed no
 *    byte), so the flag is never sent.
 *  - `imagem_principal` (one image or `null`) and `imagens` (a list, `[]` on a
 *    child): `liImagemProdutoSchema`.
 *
 * ⚠️ The document states no unit for the weight or the sizes, and this package
 * assumes none: it carries both as sent. Which unit the store means is still to
 * be confirmed, and converting either is the reader's call.
 *
 * ⚠️ Price and stock (`preco_*`, `estoque_*`) are deliberately NOT declared:
 * the import never reads either, and the read returns a projection without them
 * (`produtos.ts`).
 */
export const liProdutoDetalheSchema = liProdutoLinhaSchema.extend({
  pai: vazioComoNulo(z.string()),
  marca: vazioComoNulo(z.string()),
  destaque: vazioComoNulo(z.unknown()),
  usado: vazioComoNulo(z.unknown()),
  peso: textoOuNumeroComoVeio(),
  altura: numeroOpcional(),
  largura: numeroOpcional(),
  profundidade: numeroOpcional(),
  descricao_completa: vazioComoNulo(z.string()),
  imagem_principal: vazioComoNulo(liImagemProdutoSchema),
  imagens: listaOuVazia(liImagemProdutoSchema),
});
