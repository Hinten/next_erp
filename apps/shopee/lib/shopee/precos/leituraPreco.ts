/**
 * The FRESH read of one Shopee listing for the price sync (#1521, step 13),
 * and its pure projection onto what the price decision needs: the listing's
 * status, whether it has models, and — per model, or for the listing's one
 * no-model entry — the price Shopee shows NOW and its currency.
 *
 * ⚠️ **The comparand is step 9's shelf price, and only that.** Every price read
 * here goes through `precoDePrateleiraDe` (`produtos/mapeamento.ts`) — the one
 * definition of "which of the two wire prices is the shelf price", shared with
 * step 9's import so the two can never disagree. This module names neither wire
 * price field: the shelf reader is the ONLY place that chooses between them.
 * During a promotion the shelf price is the positive original, so the
 * promotional price is never what a push compares against — the legacy's
 * comparand, deliberately not transcribed. The shelf reader's zero-fill
 * fallback (a non-positive original falls through to the other field) is
 * dormant on the sandbox (probe P2 measured no zero-fill) and correct if it
 * ever fires.
 *
 * ⚠️ **Positivity is judged AFTER rounding.** The shelf price is rounded with
 * `roundReais`; a result that is not above zero (a stored `0.004`) is "no
 * readable price" — `null` — never a zero price a later comparison would treat
 * as real. A `null` comparand is what the decision's guard reads as
 * `preco-atual-ilegivel`.
 *
 * ⚠️ **Only the FIRST `price_info` entry is read, and its currency is carried
 * verbatim** — no case fold, no pick. Step 9 picks the first `BRL` entry for its
 * import, but a price push must not quietly pick "a BRL row" out of a listing
 * that is not priced in BRL: the currency the listing actually carries is
 * judged downstream against the conta's (`moeda-divergente`). The SG sandbox
 * answers `SGD` (probe P2).
 *
 * ⚠️ **The item-level promotion flag is never read.** Probe P2 measured it
 * `true` on a fresh listing with no promotion at all, so it is not evidence of
 * anything; a promotion lock is learned from `update_price`'s own refusal.
 *
 * ⚠️ **`has_model === true` EXACTLY, never truthiness** (step 9's
 * `temModelosDe` rule): the field is nullable on the wire, and only the literal
 * `true` spends the per-item `get_model_list` call. A listing whose flag is
 * `false` or absent is read as a no-model listing from its base row alone —
 * `get_model_list` is never called for it (probe P3: it would answer zero
 * models anyway).
 *
 * Calls per item: the base row comes from the injected batched reader
 * (`leitorDeBase.ts` — one call per chunk, not per item, so it counts ZERO
 * here), plus ONE `get_model_list` for a has-model listing. Every error reaches
 * the caller as the same instance: the sender owns the ladder, and this module
 * catches nothing.
 */
import {
  ShopeeConfigError,
  type ShopeeClient,
  type ShopeeItemBaseInfoRow,
  type ShopeeModelList,
  type ShopeePriceInfo,
} from '@delfrance/integrations-shopee';
import { roundReais } from '@delfrance/core/money';

import { precoDePrateleiraDe } from '../produtos/mapeamento';
import { SHOPEE_PRECO_MODEL_ID_SEM_MODELO } from './constantesPreco';
import type { LeitorDeBase } from './leitorDeBase';

/** One model of the fresh read — or the no-model listing's single entry. */
export interface ModeloLido {
  /** The model's id; `SHOPEE_PRECO_MODEL_ID_SEM_MODELO` for the no-model entry. */
  readonly modelId: number;
  /**
   * The shelf price Shopee shows now, rounded to the centavo — `null` when the
   * first `price_info` entry is absent or carries no price above zero after
   * rounding.
   */
  readonly precoAnterior: number | null;
  /** The first `price_info` entry's `currency`, verbatim; `null` when absent. */
  readonly moeda: string | null;
  /** `model_status`, verbatim; always `null` for the no-model entry. */
  readonly status: string | null;
}

/** The projection of one listing's fresh read. */
export interface LeituraDePreco {
  /** `item_status`, verbatim (a status Shopee invents tomorrow arrives as itself). */
  readonly itemStatus: string | null;
  /** `has_model === true`, exactly. */
  readonly temModelos: boolean;
  /**
   * A has-model listing: one entry per model of `get_model_list`, in its order.
   * A no-model listing: EXACTLY one entry, `modelId` =
   * `SHOPEE_PRECO_MODEL_ID_SEM_MODELO`, priced from the base row.
   */
  readonly modelos: readonly ModeloLido[];
}

/** The ONE `has_model` test of this module — the projection and the read both use it. */
function temModelosNaBase(base: Pick<ShopeeItemBaseInfoRow, 'has_model'>): boolean {
  return base.has_model === true;
}

/** The first `price_info` entry, or `undefined` when the list is absent or empty. */
function primeiraEntrada(
  precos: readonly ShopeePriceInfo[] | null | undefined,
): ShopeePriceInfo | undefined {
  return precos?.[0];
}

/** The shelf price of an entry, rounded; `null` unless it is above zero AFTER rounding. */
function precoAnteriorDe(entrada: ShopeePriceInfo | undefined): number | null {
  if (entrada === undefined) return null;
  const prateleira = precoDePrateleiraDe(entrada);
  if (prateleira === null) return null;
  const arredondado = roundReais(prateleira);
  return arredondado > 0 ? arredondado : null;
}

/** One {@link ModeloLido} from a `price_info` list. */
function modeloLido(
  modelId: number,
  precos: readonly ShopeePriceInfo[] | null | undefined,
  status: string | null,
): ModeloLido {
  const entrada = primeiraEntrada(precos);
  return {
    modelId,
    precoAnterior: precoAnteriorDe(entrada),
    moeda: entrada?.currency ?? null,
    status,
  };
}

/**
 * Project a fresh read — PURE.
 *
 * `modelos` is read only when the base row says `has_model === true`; given
 * `null` there, the projection holds NO model (each linked model then reads as
 * absent downstream — never the base row's price, which Shopee does not carry
 * for a has-model listing). For a listing without models it is ignored, and the
 * single entry is priced from the base row.
 */
export function projetarLeitura(
  base: ShopeeItemBaseInfoRow,
  modelos: ShopeeModelList | null,
): LeituraDePreco {
  const temModelos = temModelosNaBase(base);
  const lidos: readonly ModeloLido[] = temModelos
    ? (modelos?.model ?? []).map((m) =>
        modeloLido(m.model_id, m.price_info, m.model_status ?? null),
      )
    : [modeloLido(SHOPEE_PRECO_MODEL_ID_SEM_MODELO, base.price_info, null)];
  return {
    itemStatus: base.item_status ?? null,
    temModelos,
    modelos: lidos,
  };
}

/**
 * Read one listing fresh: its base row through `lerBase`, then
 * `get_model_list` ONLY when `has_model === true`.
 *
 * `ausente: true` when the batched answer carried no readable row for the id
 * (the sender's `anuncio-inexistente`). `chamadas` counts the calls THIS
 * function issued — `0` for a no-model listing, `1` for a has-model one; the
 * batched base read is the surface's cost, not the item's. A throw carries no
 * count: a caller that must account for a `get_model_list` that failed knows
 * it was issued exactly when the listing has models.
 *
 * @throws ShopeeConfigError when `lerBase` answers a row of ANOTHER item — a
 *   reader that reconciled by position; the price of one listing must never be
 *   judged on another's read.
 */
export async function lerItemParaPreco(
  client: ShopeeClient,
  itemId: number,
  lerBase: LeitorDeBase,
): Promise<
  | { readonly ausente: true }
  | { readonly ausente: false; readonly leitura: LeituraDePreco; readonly chamadas: number }
> {
  const base = await lerBase(itemId);
  if (base === null) return { ausente: true };
  if (base.item_id !== itemId) {
    throw new ShopeeConfigError(
      `lerItemParaPreco: a leitura de base do item ${String(itemId)} devolveu a linha do item ` +
        `${String(base.item_id)} — reconcilie por item_id, nunca por posição.`,
    );
  }
  if (!temModelosNaBase(base)) {
    return { ausente: false, leitura: projetarLeitura(base, null), chamadas: 0 };
  }
  const modelos = await client.getModelList({ itemId });
  return { ausente: false, leitura: projetarLeitura(base, modelos), chamadas: 1 };
}
