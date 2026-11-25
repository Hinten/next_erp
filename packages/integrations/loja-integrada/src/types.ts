/**
 * Loja Integrada REST v1 wire schemas — RESPONSE shapes only, and only the ones
 * something consumes: the Tastypie paging envelope, the pedido search row (the
 * order poller, master-plan step 3), the catalogue rows the catalogue reads
 * parse (`catalogo.ts`, master-plan step 10): categoria, marca, grade, and a
 * grade's detail with its options; the produto list row, detail and image
 * the product import reads (`produtos.ts`, master-plan step 9); the stock
 * row, its detail and the stock write's echo (`estoque.ts`, `estoqueEscrita.ts`,
 * master-plan step 12); and the price row of the by-id read, its envelope, the
 * produto detail a price write decides on and the price write's echo
 * (`preco.ts`, `precoEscrita.ts`, master-plan step 13).
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
 * The stock schemas (`produto_estoque`, master-plan step 12), at the very end,
 * were written against the public document's schema and examples, and are
 * pinned against the owner's read-only stock captures (both stores' lists and
 * details; `apps/loja-integrada/lib/lojaIntegrada/estoque/capturasEstoque.test.ts`).
 *
 * The price schemas (`produto_preco`, master-plan step 13), after the stock
 * ones, were written against the public document's examples and the facts the
 * owner's read-only price capture (2026-11-24, both stores) measured; that
 * capture's sanitized pages are replayed in a later change.
 *
 * Every other resource (imagem, envio) arrives with its first consumer,
 * written against captured responses rather than the public document's
 * examples (the pedido detail and situação are in `pedidoTipos.ts`).
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
 * that use Zod for RESPONSE numbers, and every one goes through `wireInt()` /
 * `wireNumber()` from `@delfrance/core/wire`: a serializer that quotes ONE
 * field must not cost the whole page (#1087). The price leaves read here are
 * no Zod number at all: they are carried raw and judged by the shared price
 * fold (`valorPrecoLi`, `@delfrance/schemas`). The only other Zod numbers under
 * `src/` are REQUEST leaves, all in `rotasEscrita.ts`: the stock write's
 * `quantidade`, the price write's price and its echoed custo. Strict on
 * purpose, because a quoted number must never be forwarded, and each carved
 * out by its exact line in the guard below.
 * Enforced by
 * `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`,
 * which scans every file under `src/` and anchors on three lines of this file.
 * ⚠️ Keep each anchored field on its own short line, so Prettier never wraps it
 * out of the guard's line-based scan.
 */
import { wireInt, wireNumber } from '@delfrance/core/wire';
import { valorPrecoLi } from '@delfrance/schemas';
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
 * converts neither: it carries both as sent. The store's units are kilograms and
 * centimetres, as the owner confirmed (decided 2026-11-09); the product import
 * reads them as such in ONE place, its `medidasErpDoDetalheLi`, and any other
 * reader must do the same rather than guess.
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

/* -------------------------------------------------------------------------- */
/*                  The stock (master-plan step 12, `estoque.ts`)             */
/* -------------------------------------------------------------------------- */

/**
 * One row of `GET /v1/produto_estoque` and, leaf for leaf, the answer of
 * `GET /v1/produto_estoque/{produto_id}`: the public document gives both (and
 * the stock write's echo) the same nine leaves — `gerenciado`, `id`, `produto`,
 * `quantidade`, `quantidade_disponivel`, `quantidade_reservada`, `resource_uri`,
 * `situacao_em_estoque`, `situacao_sem_estoque`.
 *
 * Checked against the owner's read-only stock captures (header): every list row
 * and every detail carried exactly these nine leaves, every integer a JSON
 * number (never text) and `gerenciado` a boolean; a detail equals its list row
 * leaf for leaf; the row's own `id` differs from the produto id in every row;
 * and `quantidade_disponivel` equals `quantidade − quantidade_reservada` in
 * every row.
 *
 * Declared: the leaves a stock decision reads, each REQUIRED, because a row
 * without one cannot be judged by anyone.
 *
 *  - `produto`: the produto's resource URI (`/api/v1/produto/<id>` in the
 *    document), a string. It is read into an id by `produtoIdDoEstoqueLi`
 *    (`estoque.ts`), never here. The document's examples give the row an `id`
 *    of its own, different from the produto id in `produto` and in
 *    `resource_uri`, so the produto is never read from `id`.
 *  - `gerenciado`: a boolean — whether the store manages the product's stock.
 *  - `quantidade`, `quantidade_reservada`, `situacao_em_estoque`,
 *    `situacao_sem_estoque`: integers through `wireInt()`, so a quoted one
 *    (`'5'`) reads as the number and never costs the page. Any sign: the
 *    document's own rows carry `quantidade: -2` and `-4`, and
 *    `situacao_sem_estoque: -1`; the captured rows hold negative quantities in
 *    both stores, and positive situações (lead times) in one. Never a fraction.
 *
 * Not declared, and kept by `.passthrough()`: the row's own `id`,
 * `resource_uri` (`/api/v1/produto_estoque/<produto id>`) and
 * `quantidade_disponivel`. Nothing here reads them, and a declared leaf can
 * only add a way to refuse a row.
 *
 * A LIST row whose declared leaf is missing or of another type costs only
 * itself: `lerPaginaEstoqueLi` reads the rows one by one and reports such a row
 * in `ilegiveis` (its position, the produto it names, the field paths), so one
 * odd row never hides the rows beside it, as on the produto list above. The
 * DETAIL is read whole (below).
 */
export const liEstoqueProdutoLinhaSchema = z
  .object({
    produto: z.string(),
    gerenciado: z.boolean(),
    quantidade: wireInt(),
    quantidade_reservada: wireInt(),
    situacao_em_estoque: wireInt(),
    situacao_sem_estoque: wireInt(),
  })
  .passthrough();

export type EstoqueProdutoLinhaLi = z.infer<typeof liEstoqueProdutoLinhaSchema>;

/**
 * `GET /v1/produto_estoque/{produto_id}`: the row's leaves (above). One schema
 * under two names, so a capture that shows the detail to differ changes this
 * line and no caller. A stock write decides on this read, so a detail without a
 * leaf the write decides on refuses the read (`LiSchemaError`), and nothing is
 * written.
 */
export const liEstoqueProdutoDetalheSchema = liEstoqueProdutoLinhaSchema;

export type EstoqueProdutoDetalheLi = z.infer<typeof liEstoqueProdutoDetalheSchema>;

/**
 * The echo of `PUT /v1/produto_estoque/{produto_id}`: per the public document,
 * the stock row as stored. Diagnostic only, so EVERY field is optional, as on
 * the order write echoes (`pedidoTipos.ts`): whether a stock write took effect
 * is never read from its echo (a fresh `GET` decides), and an echo that does
 * not parse is reported, never thrown (`escrita.ts`). Only `quantidade` is
 * typed; `.passthrough()` keeps the rest as received.
 */
export const liEcoEstoqueProdutoSchema = z
  .object({
    quantidade: inteiroOpcional(),
  })
  .passthrough();

export type EcoEstoqueProdutoLi = z.infer<typeof liEcoEstoqueProdutoSchema>;

/* -------------------------------------------------------------------------- */
/*                  The price (master-plan step 13, `preco.ts`)               */
/* -------------------------------------------------------------------------- */

/**
 * A price leaf a decision reads, REQUIRED and readable by the ONE price fold:
 * present (an absent key is drift, never "no promotion") and anything
 * `valorPrecoLi` (`@delfrance/schemas`) does not read as `ilegivel` — the
 * store's 4-decimal text (`'160.0000'`), a JSON number (`160`), `null`. A
 * negative, a comma decimal (`'1,50'`), an object or a boolean refuses it. The
 * value comes out RAW, never converted (`'160.0000'` stays `'160.0000'`): the
 * price decisions take raw values and read them through the same fold.
 *
 * No grammar of its own: the wire counts no decimals (a 5-decimal text is read
 * by the fold, as the fold reads it). ⚠️ Zod 4 already refuses an ABSENT key
 * under `z.unknown()`, but not a key present with the value `undefined`, which
 * the fold alone reads as `vazio`: the explicit `undefined` check refuses both,
 * whatever Zod does with an absent key.
 */
function valorDePrecoLegivel() {
  return z
    .unknown()
    .refine((v) => v !== undefined && valorPrecoLi(v) !== 'ilegivel', 'preço ilegível');
}

/**
 * One row of the by-id price read, `GET /v1/produto_preco/set/{id;id;…}`
 * (`preco.ts`): one product's prices. The owner's read-only price capture
 * (2026-11-24, both stores) found every row with exactly seven keys — `id`,
 * `produto`, `resource_uri`, `cheio`, `promocional`, `custo` and
 * `sob_consulta` — the three amounts as text with four decimals or `null`, and
 * the row's own `id` different from the produto id in every row.
 *
 * Declared, each REQUIRED: what a price decision reads.
 *
 *  - `produto`: the produto's resource URI, a string, read into an id by
 *    `produtoIdDoPrecoLi` (`preco.ts`), never here. The row is matched to the
 *    id asked for by the produto it names, never by its own `id` or its place.
 *  - `cheio`, `promocional`: {@link valorDePrecoLegivel}, judged at the wire by
 *    the fold itself. A value the fold cannot read makes the row UNREADABLE:
 *    the by-id read reports it (`ilegivel`) and never reads it as "no row", and
 *    no decision is taken on it.
 *
 * Not declared, so kept by `.passthrough()` and never able to refuse a row:
 * the row's own `id`, `resource_uri`, `sob_consulta` and `custo`. ⚠️ The
 * custo is OPAQUE on purpose: no decision reads the store's resource custo (a
 * price write echoes the PRODUTO DETAIL's, {@link liProdutoComPrecoDetalheSchema}),
 * and the sanitized capture fixtures replace every custo text with the fake
 * text `'REDACTED'`, which the price fold cannot read, so a judged custo would
 * make every such row unreadable.
 *
 * ⚠️ Deliberately unlike {@link liProdutoComPrecoDetalheSchema}, which carries
 * its price leaves RAW and unjudged: here an unreadable value is a finding the
 * read reports per id; there it is a decision outcome the send logs with a
 * restore line. The same fold judges both; only who reports "unreadable"
 * differs. Do not unify them.
 */
export const liPrecoProdutoLinhaSchema = z
  .object({
    produto: z.string(),
    cheio: valorDePrecoLegivel(),
    promocional: valorDePrecoLegivel(),
  })
  .passthrough();

export type PrecoProdutoLinhaLi = z.infer<typeof liPrecoProdutoLinhaSchema>;

/**
 * The envelope of the by-id price read: `objects`, and the ids it could not
 * find. Measured (the owner's read-only price capture, both stores): `objects`
 * is the only root key, with NO `meta`; `not_found` is ABSENT when every id
 * came back, and otherwise a list of id STRINGS naming exactly the unknown ids.
 *
 *  - `objects`: a list, REQUIRED. Each row is read on its own by `preco.ts`
 *    through {@link liPrecoProdutoLinhaSchema}, so one odd row costs only
 *    itself.
 *  - `not_found`: absent, `null` and `''` all mean none (the package's three
 *    spellings of "none"), read as `[]`. A value that is not a list refuses the
 *    answer. Each element is carried raw and read by the shared positive-id
 *    reader in `preco.ts`, so `123` ≡ `'123'` and one odd element costs only
 *    itself.
 *
 * Passthrough keeps any other root key (a `meta` the store might add).
 */
export const liSetPrecoSchema = z
  .object({
    objects: z.array(z.unknown()),
    not_found: listaOuVazia(z.unknown()),
  })
  .passthrough();

export type SetPrecoLi = z.infer<typeof liSetPrecoSchema>;

/**
 * The produto detail `GET /v1/produto/{id}/` as a price write DECIDES on it
 * (master-plan step 13): the guard (`tipo`, `removido`, `bloqueado`), `ativo`
 * (kept for the restore line: an inactive child is still priced) and the four
 * price leaves. The owner's read-only price capture found the
 * detail's prices (JSON numbers) equal to the price resource's (text) on every
 * leaf, custo included, in every pair it read, so this read is the merge base.
 *
 * Every judged leaf is carried RAW (`z.unknown()`), whatever its type, and
 * every one is REQUIRED (a bare `z.unknown()` refuses an absent key): a write
 * restores from this read, so a detail without one of them cannot be restored
 * and is no base. Nothing is folded here — `''` stays `''`, `'abc'` stays
 * `'abc'` — because "a current value present but unreadable" is a DECISION
 * outcome of the send (skipped, with its restore line), never a refused read.
 * Deliberately unlike {@link liPrecoProdutoLinhaSchema} (see there).
 *
 * Minimal and independent of {@link liProdutoDetalheSchema}: an odd weight or
 * image must never block a price decision. It is read through the WRITE
 * client's deciding read only (`lerAntesDeEscreverLi`), never by the product
 * import, whose reads stay price-free (`produtos.ts`).
 *
 * `id` through `wireInt()`, so a quoted id reads as the number; `tipo` a plain
 * string, never an enum.
 */
export const liProdutoComPrecoDetalheSchema = z
  .object({
    id: wireInt(),
    tipo: z.string(),
    ativo: z.unknown(),
    bloqueado: z.unknown(),
    removido: z.unknown(),
    preco_cheio: z.unknown(),
    preco_promocional: z.unknown(),
    preco_custo: z.unknown(),
    preco_sob_consulta: z.unknown(),
  })
  .passthrough();

export type ProdutoComPrecoDetalheLi = z.infer<typeof liProdutoComPrecoDetalheSchema>;

/**
 * The echo of `PUT /v1/produto_preco/{produto_id}`: per the public document,
 * the price row as stored, its amounts as TEXT (`"32.84"`). Diagnostic only, so
 * EVERY field is optional, as on the other write echoes: whether a price write
 * took effect is read through the price fold from a fresh read, never by
 * comparing an echo whole, and an echo that does not parse is reported, never
 * thrown (`escrita.ts`). `cheio` and `promocional` are carried raw.
 */
export const liEcoPrecoProdutoSchema = z
  .object({
    cheio: z.unknown().optional(),
    promocional: z.unknown().optional(),
  })
  .passthrough();

export type EcoPrecoProdutoLi = z.infer<typeof liEcoPrecoProdutoSchema>;
