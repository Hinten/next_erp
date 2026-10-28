import { z } from 'zod';

import { textoUtilizavelShopee } from './faixaShopee';
import type { MarcaRascunhoShopee } from './produto/collection/shopeeRascunho';
import type { MarcaDto } from './taxonomiaShopeeDto';

/**
 * A Shopee conta's BRAND SHORTLIST (#1911, D10, P9) —
 * `integracao/{integracaoId}/brandshopee`, the brands an operator registered
 * so a draft's brand picker never waits on Shopee's slow brand API. This module
 * is the typed stored row, the ONE reader of a conta's rows, the pair a draft
 * stores when a row is picked, and the row a registration writes.
 *
 * ## Why a file of its own
 *
 * The collection's RULES surface is `brandShopeeSchema` / `brandShopeeMeta` in
 * `integracao.ts`, a loose pass-through that stays byte-identical: that file is
 * on the NF-e live lane's `--only-paths`, so typing the rows there would cost a
 * SEFAZ homologação emission on every push, and the rules validate no field of
 * this subcollection anyway. Same split as `prodshopee` (a typed const beside a
 * loose rules domain). Not a `registry.ts` entry: the domain already is one.
 *
 * ## Who reads it
 *
 * `apps/web` only: the Marcas section of `/canais/shopee/[id]` and the draft
 * editor's brand picker, both through {@link marcasDaContaShopee} (#1369 — one
 * reader). The publisher NEVER reads the shortlist (its brand cascade is the
 * link's stored name, then `get_brand_list`), so no `apps/shopee` file imports
 * this module. ⚠️ If one ever does, `ci-shopee.yml`'s `push: paths:` must gain
 * this file in the same commit, or a change here stops running that lane.
 *
 * ## Identity is the integer `brand_id`, and nothing else
 *
 * No fold decides which rows are one brand:
 * - **ONE brand:** rows with the same `brand_id`, whatever their names —
 *   `'Nike'` and `'NIKE'` at id 7 are one brand (legacy duplicates).
 * - **DISTINCT:** two `'Nike'` rows at ids 1 and 2 are two brands; `123` is not
 *   `1234`; a STRING `'123'` is not `123` — it is unreadable (the legacy model
 *   read `brand_id as num`, so a string is a foreign writer, not a legacy shape).
 *
 * "No name" is the draft write's own test, {@link textoUtilizavelShopee}
 * (blank or whitespace-only ⇒ absent), so this reader and the draft route agree
 * on which rows carry a name. A name that has one is kept VERBATIM.
 *
 * ## Legacy rows, new rows
 *
 * The legacy app wrote auto-id docs `{brand_id, original_brand_name (may be
 * ''), display_brand_name (explicit null)}` plus its `docId` / `createTime` /
 * `updateTime` / `readTime` stamps, and nothing stopped two docs naming one
 * brand. A NEW row is written at the deterministic id
 * {@link docIdDaMarcaShopee} and never carries a blank name
 * ({@link linhaDeMarcaParaGravarShopee}), so a second registration of a brand
 * lands on the same document instead of adding a duplicate.
 *
 * Pure and total — no clock, no network, no Firestore.
 */

/* -------------------------------------------------------------------------- */
/*                               The stored row                               */
/* -------------------------------------------------------------------------- */

/**
 * One `brandshopee` document as stored, LEGACY-TOLERANT. The web handle's
 * schema; a reader still goes through {@link marcasDaContaShopee}, because a
 * soft-read hands back the raw document when this schema refuses it.
 *
 * - `brand_id` — a non-negative safe integer NUMBER. Shopee ids exceed int32,
 *   still safe JS integers; `.int()` refuses anything past `MAX_SAFE_INTEGER`
 *   (Zod 4), so an id that lost precision is refused, never mis-read. `0` is
 *   Shopee's "No Brand" (read apart, {@link LeituraMarcasShopee.semMarca}).
 * - `original_brand_name` — a string; `''` is a legal LEGACY value.
 * - `display_brand_name` — the legacy app wrote it as an explicit `null`.
 * - `.passthrough()` — the legacy stamps and any stray key survive a write.
 */
export const marcaShopeeArmazenadaSchema = z
  .object({
    brand_id: z.number().int().nonnegative(),
    original_brand_name: z.string(),
    display_brand_name: z.string().nullable().default(null),
  })
  .passthrough();
export type MarcaShopeeArmazenada = z.infer<typeof marcaShopeeArmazenadaSchema>;

/**
 * The document id a brand's row is WRITTEN at: `String(brandId)`. The one
 * spelling of it — the writer uses it, and the reader prefers the row stored
 * there as the brand's canonical one. Legacy rows sit at auto ids instead.
 */
export function docIdDaMarcaShopee(brandId: number): string {
  return String(brandId);
}

/* -------------------------------------------------------------------------- */
/*                         The reader — one conta's rows                      */
/* -------------------------------------------------------------------------- */

/** One brand of a conta's shortlist, its duplicate rows collapsed. */
export interface MarcaDaContaShopee {
  /** A POSITIVE safe integer (`0` never reaches this type). */
  readonly brandId: number;
  /** The canonical row's `original_brand_name`, VERBATIM; blank ⇒ `null`. */
  readonly originalBrandName: string | null;
  /** The canonical row's `display_brand_name`, VERBATIM; blank ⇒ `null`. */
  readonly displayBrandName: string | null;
  /**
   * The label to show: the display name, else the original name (each
   * trimmed, blank skipped), else `Marca <id>`. DISPLAY ONLY — it decides no
   * identity, and it is the list's sort key.
   */
  readonly rotulo: string;
  /**
   * EVERY document of this brand, the canonical one first, then the others in
   * code-unit order. A removal deletes them all — deleting only one would let a
   * legacy duplicate bring the brand back on the next read.
   */
  readonly docIds: readonly string[];
}

/** A conta's shortlist as {@link marcasDaContaShopee} reads it. */
export interface LeituraMarcasShopee {
  /** One per `brand_id`, sorted by `rotulo` (pt-BR), then by `brandId`. */
  readonly marcas: readonly MarcaDaContaShopee[];
  /**
   * The doc ids of rows storing `brand_id: 0`, code-unit order. "Sem marca" is
   * the picker's own explicit option, never a shortlist row.
   */
  readonly semMarca: readonly string[];
  /** The doc ids of rows {@link marcaShopeeArmazenadaSchema} refuses, code-unit order. */
  readonly ilegiveis: readonly string[];
}

/** One readable stored row, with the doc id it sits at. */
interface LinhaLegivel {
  readonly id: string;
  readonly marca: MarcaShopeeArmazenada;
}

/** A brand's rows, doc-id code-unit order — never empty (the row that opened it). */
type GrupoDaMarca = [LinhaLegivel, ...LinhaLegivel[]];

/** Code-unit order, never locale order: it decides which row is canonical. */
function porCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The stored name if it carries one ({@link textoUtilizavelShopee}), VERBATIM; else `null`. */
function nomeGuardado(nome: string | null): string | null {
  return textoUtilizavelShopee(nome) === null ? null : nome;
}

/**
 * The row whose names stand for the brand: the one at
 * {@link docIdDaMarcaShopee}, else the first (doc-id code-unit order) that
 * carries an `original_brand_name`, else the first.
 */
function linhaCanonica(brandId: number, grupo: Readonly<GrupoDaMarca>): LinhaLegivel {
  return (
    grupo.find((l) => l.id === docIdDaMarcaShopee(brandId)) ??
    grupo.find((l) => nomeGuardado(l.marca.original_brand_name) !== null) ??
    grupo[0]
  );
}

/**
 * Read a conta's `brandshopee` rows — THE reader (#1369). Each element is one
 * document: its id and its RAW data (a soft-read may hand back an unparsed
 * one). The result depends on the SET of rows, never on their order.
 *
 * - A row the schema refuses (`brand_id: '123'`, `-1`, `1.5`, no name, not an
 *   object) is listed in `ilegiveis` and merged into nothing.
 * - A `brand_id: 0` row is listed in `semMarca`.
 * - Every other row joins the brand of its `brand_id` (exact integer identity),
 *   and the brand takes the names of its canonical row — the one at
 *   {@link docIdDaMarcaShopee}, else the first that carries a name, else the
 *   first (doc-id code-unit order).
 */
export function marcasDaContaShopee(
  linhas: readonly { readonly id: string; readonly data: unknown }[],
): LeituraMarcasShopee {
  const ordenadas = [...linhas].sort((a, b) => porCodeUnit(a.id, b.id));
  const porMarca = new Map<number, GrupoDaMarca>();
  const semMarca: string[] = [];
  const ilegiveis: string[] = [];

  for (const { id, data } of ordenadas) {
    const lida = marcaShopeeArmazenadaSchema.safeParse(data);
    if (!lida.success) {
      ilegiveis.push(id);
      continue;
    }
    const marca = lida.data;
    if (marca.brand_id === 0) {
      semMarca.push(id);
      continue;
    }
    const grupo = porMarca.get(marca.brand_id);
    if (grupo === undefined) porMarca.set(marca.brand_id, [{ id, marca }]);
    else grupo.push({ id, marca });
  }

  const marcas: MarcaDaContaShopee[] = [];
  for (const [brandId, grupo] of porMarca) {
    const canonica = linhaCanonica(brandId, grupo);
    const originalBrandName = nomeGuardado(canonica.marca.original_brand_name);
    const displayBrandName = nomeGuardado(canonica.marca.display_brand_name);
    marcas.push({
      brandId,
      originalBrandName,
      displayBrandName,
      rotulo:
        textoUtilizavelShopee(displayBrandName) ??
        textoUtilizavelShopee(originalBrandName) ??
        `Marca ${String(brandId)}`,
      docIds: [canonica.id, ...grupo.filter((l) => l !== canonica).map((l) => l.id)],
    });
  }
  marcas.sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR') || a.brandId - b.brandId);

  return { marcas, semMarca, ilegiveis };
}

/* -------------------------------------------------------------------------- */
/*                     A picked row → the pair a draft stores                  */
/* -------------------------------------------------------------------------- */

/**
 * The brand PAIR a draft stores when the operator picks this shortlist row
 * (D10 — `brand_id` and `original_brand_name` always together): the row's
 * name whenever the row has one, `null` only when it has none. It is exactly
 * the `marca` the draft route's write accepts.
 *
 * ⚠️ It knows nothing of what the draft already stores. A tab that keeps a
 * stored name when a NAMELESS row with the SAME id is re-picked applies that
 * rule itself, on top of this pair — it is a browser rule, not this one's.
 */
export function marcaParaRascunhoShopee(m: MarcaDaContaShopee): MarcaRascunhoShopee {
  return { brand_id: m.brandId, original_brand_name: m.originalBrandName };
}

/* -------------------------------------------------------------------------- */
/*                        A registered brand → its row                         */
/* -------------------------------------------------------------------------- */

/** The three fields a NEW `brandshopee` row stores — never a blank name. */
export type MarcaShopeeParaGravar = {
  readonly brand_id: number;
  readonly original_brand_name: string;
  readonly display_brand_name: string | null;
};

/** Where a registered brand is written, and what. */
export interface LinhaDeMarcaShopeeParaGravar {
  /** {@link docIdDaMarcaShopee} — two registrations of one brand land on one document. */
  readonly docId: string;
  readonly data: MarcaShopeeParaGravar;
}

/**
 * The row a registration writes for one brand of a `taxonomia/marcas` page,
 * or `null` when that brand cannot be registered:
 * - `brandId` not a POSITIVE safe integer — `0` is "Sem marca", which the
 *   picker always offers and the shortlist never holds;
 * - an `originalBrandName` with no text ({@link textoUtilizavelShopee}) — a new
 *   row never carries `''`, so the name a draft takes from it is always one
 *   publish can send.
 *
 * Names are kept VERBATIM (Shopee's own spelling, the one publish sends); a
 * blank `displayBrandName` is written `null`.
 */
export function linhaDeMarcaParaGravarShopee(dto: MarcaDto): LinhaDeMarcaShopeeParaGravar | null {
  if (!Number.isSafeInteger(dto.brandId) || dto.brandId <= 0) return null;
  if (textoUtilizavelShopee(dto.originalBrandName) === null) return null;
  return {
    docId: docIdDaMarcaShopee(dto.brandId),
    data: {
      brand_id: dto.brandId,
      original_brand_name: dto.originalBrandName,
      display_brand_name: nomeGuardado(dto.displayBrandName),
    },
  };
}
