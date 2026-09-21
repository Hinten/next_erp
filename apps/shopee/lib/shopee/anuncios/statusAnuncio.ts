/**
 * **The `estadoAnuncio` fold** (#1519, step 11) — one reading of one Shopee
 * listing → what this ERP says that listing IS.
 *
 * Shopee's `item_status` is a six-member RESPONSE enum
 * (`shopeeItemStatusSchema`). `estadoAnuncio` is this app's reading of it, and
 * it carries two facts the wire cannot state on its own: an `UNLIST` whose
 * `scheduled_publish_time` is still in the future is **`agendado`**, not
 * paused; and an `item_status` nobody here recognises is **`desconhecido`**, a
 * real member rather than a hole. The vocabulary itself lives in
 * `packages/schemas` so `apps/web` and this backend cannot disagree about what
 * a stored reading means; only the FOLD lives here.
 *
 * ## ⚠️ PURE and CLOCK-FREE — `agoraMs` is a parameter
 *
 * Nothing under `lib/shopee/anuncios/` reads the ambient clock, and a raw-text
 * test in this folder's suite pins it. One arm of the table compares against
 * `agoraMs`; every other arm ignores it. A module that read `Date` here would
 * make the `agendado`/`pausado` boundary untestable at exactly the instant it
 * matters.
 *
 * ## ⚠️ `deboost` is ORTHOGONAL, which is why the fold answers a PAIR
 *
 * `push 18`'s own sample carries `item_status: "NORMAL"` beside
 * `deboost: true`: the listing is live and sellable, and only its search
 * ranking is lowered. A fold that collapsed that into one value would either
 * kill a live listing (reading the deboost as "dead") or throw away the only
 * signal Shopee sent. So {@link estadoDoAnuncio} returns
 * {@link EstadoDeAnuncio} — the estado AND the deboost — and both are stored
 * as separate link fields.
 *
 * ## ⚠️ `deboostDeWire` is never truthiness
 *
 * The sandbox sends `deboost` as the STRING `"FALSE"` (`types.ts` declares the
 * field as `boolean | string` for that reason). `Boolean("FALSE")` is `true`
 * and `Boolean("0")` is `true`, so a truthiness read would write
 * `deboost: true` onto every healthy listing in the shop. The fold is
 * `trim().toLowerCase() === 'true'` on a string, the value itself on a boolean,
 * and **nothing else** — the `has_model === true` EXACTLY precedent
 * (`produtos/itemLido.ts`).
 *
 * ## ⚠️ No second seconds→ms converter
 *
 * {@link agendadoParaMsDe} routes through `segundosShopeeUtilizaveis`
 * (`pedidos/orderMapping.ts`), the ONE reader that knows Shopee zero-fills an
 * absent timestamp with `0` and that anything below 2020-01-01 is absence, not
 * a date. It multiplies by 1000 and stops: this produces MILLISECONDS, the unit
 * every stamp on a produto link doc is in, so it is **not** a microsecond site
 * and this folder names no microsecond converter at all.
 */
import {
  ESTADO_ANUNCIO_SHOPEE,
  SHOPEE_ITEM_STATUS,
  type EstadoAnuncioShopee,
} from '@delfrance/schemas';

import { segundosShopeeUtilizaveis } from '../pedidos/orderMapping';

/**
 * The pre-2024 deletion spelling (`announcement 769`/`841`, effective
 * 2024-01-18). The live wire no longer emits it and `shopeeItemStatusSchema`
 * deliberately omits it, but the MIGRATED corpus still holds it and the pause
 * pre-check folds a STORED reading — so the fold has to know the alias or a
 * migrated deleted listing reads as `desconhecido` and looks movable.
 *
 * ⚠️ An EXACT match. `DELETE` (no `D`) is not this value and folds to
 * `desconhecido`, like any other string Shopee may invent.
 */
const ITEM_STATUS_REMOVIDO_PRE_2024 = 'DELETED';

/**
 * A reading of ONE listing — from a `get_item_base_info` row, or from a stored
 * link document (the pause pre-check reads what it last stored).
 */
export type LeituraDeAnuncio =
  | {
      readonly kind: 'lido';
      /**
       * The RAW wire string, never the request enum: a status Shopee invents
       * tomorrow must cost ONE field, never an item (`itemStatusDeLink`'s rule).
       */
      readonly itemStatus: string | null;
      /**
       * ⚠️ `boolean | string | null` on the wire — the sandbox sends `"FALSE"`.
       * It is deliberately `unknown` here so every caller goes through
       * {@link deboostDeWire} instead of reaching for truthiness.
       */
      readonly deboost: unknown;
      /**
       * MILLISECONDS, already through {@link agendadoParaMsDe}. `null` = the
       * listing carries no usable schedule.
       */
      readonly agendadoParaMs: number | null;
    }
  /** `error_item_not_found`, or a batch that answered no row for an id we asked for. */
  | { readonly kind: 'ausente' };

/** What one reading MEANS. Two fields, because `deboost` is orthogonal. */
export interface EstadoDeAnuncio {
  readonly estado: EstadoAnuncioShopee;
  readonly deboost: boolean;
}

/**
 * The fold. Pure, total, clock-free.
 *
 * | reading | ⇒ estado |
 * |---|---|
 * | `ausente` | `removido` (and `deboost: false` — nothing was read) |
 * | `SELLER_DELETE` / `SHOPEE_DELETE` / `DELETED` | `removido` |
 * | `BANNED` | `banido` |
 * | `REVIEWING` | `em_revisao` |
 * | `UNLIST` + `agendadoParaMs` **>** `agoraMs` | `agendado` |
 * | `UNLIST` otherwise (past, equal or absent) | `pausado` |
 * | `NORMAL` | `ativo` — with or without a deboost |
 * | anything else, `null` or `''` | `desconhecido` |
 *
 * ⚠️ The schedule comparison is **strictly `>`**. A schedule due at exactly
 * `agoraMs` has not fired yet in Shopee's minute-resolution world, and `>=`
 * would report a publish that just failed as "scheduled" for a whole minute.
 */
export function estadoDoAnuncio(leitura: LeituraDeAnuncio, agoraMs: number): EstadoDeAnuncio {
  // ⚠️ `deboost: false` on an ABSENT reading is not a fold of anything: there
  // was no body to read. A `true` here would be an invention.
  if (leitura.kind === 'ausente') {
    return { estado: ESTADO_ANUNCIO_SHOPEE.removido, deboost: false };
  }

  const deboost = deboostDeWire(leitura.deboost);

  switch (leitura.itemStatus) {
    case SHOPEE_ITEM_STATUS.sellerDelete:
    case SHOPEE_ITEM_STATUS.shopeeDelete:
    case ITEM_STATUS_REMOVIDO_PRE_2024:
      return { estado: ESTADO_ANUNCIO_SHOPEE.removido, deboost };
    case SHOPEE_ITEM_STATUS.banned:
      return { estado: ESTADO_ANUNCIO_SHOPEE.banido, deboost };
    case SHOPEE_ITEM_STATUS.reviewing:
      return { estado: ESTADO_ANUNCIO_SHOPEE.emRevisao, deboost };
    case SHOPEE_ITEM_STATUS.unlist:
      return {
        estado: agendadoNoFuturo(leitura.agendadoParaMs, agoraMs)
          ? ESTADO_ANUNCIO_SHOPEE.agendado
          : ESTADO_ANUNCIO_SHOPEE.pausado,
        deboost,
      };
    case SHOPEE_ITEM_STATUS.normal:
      return { estado: ESTADO_ANUNCIO_SHOPEE.ativo, deboost };
    // ⚠️ `null` is named beside the default rather than folded into it: an
    // ABSENT `item_status` and a status Shopee invents tomorrow are the same
    // verdict here, and saying so is what stops a later reader reading the
    // default as "everything else is an error".
    case null:
    default:
      return { estado: ESTADO_ANUNCIO_SHOPEE.desconhecido, deboost };
  }
}

/** Strictly in the future, and finite. A `NaN` reads as "no schedule". */
function agendadoNoFuturo(agendadoParaMs: number | null, agoraMs: number): boolean {
  return agendadoParaMs !== null && Number.isFinite(agendadoParaMs) && agendadoParaMs > agoraMs;
}

/**
 * The `deboost` equivalence fold — `boolean | string | null` → `boolean`.
 *
 * | input | ⇒ |
 * |---|---|
 * | `true` | `true` |
 * | `"true"`, `"True"`, `"TRUE"`, `" true "` | `true` |
 * | `false`, `"false"`, `"FALSE"`, `"False"` | `false` |
 * | `null`, `undefined`, `""` | `false` — absence is not a deboost |
 * | `"1"`, `"0"`, `1`, `0`, `"sim"`, `"yes"` | `false` |
 *
 * ⚠️ The last row is the whole point, and it is the NEAR-MISS a test pins: in
 * JavaScript `Boolean("FALSE")` and `Boolean("0")` are both `true`. Nothing
 * here is truthiness, and a numeric `1` is not a deboost either — Shopee has
 * never sent one, and inventing that reading would be a guess written onto a
 * seller's whole catalogue.
 *
 * No inventoried fold helper is reachable from here: this is a hand-rolled
 * two-line comparison, invisible to `equivalence-fold-inventory.test.js`, and
 * the #1372 obligation is discharged by the pair and the near-miss named in
 * this suite's titles.
 */
export function deboostDeWire(bruto: unknown): boolean {
  if (typeof bruto === 'boolean') return bruto;
  if (typeof bruto === 'string') return bruto.trim().toLowerCase() === 'true';
  return false;
}

/**
 * Shopee `scheduled_publish_time` (SECONDS) → MILLISECONDS, or `null`.
 *
 * ⚠️ Through `segundosShopeeUtilizaveis`, never a bare `* 1000`: Shopee
 * zero-fills every absent numeric, and a `0` multiplied out is 1970 — a
 * schedule fifty years in the past, which folds an `UNLIST` to `pausado` by
 * accident rather than by rule. The floor is 2020-01-01, so the sandbox's
 * `scheduled_publish_time: null` and its zero-filled twin answer the same
 * thing: there is no schedule.
 */
export function agendadoParaMsDe(segundos: number | null | undefined): number | null {
  const utilizaveis = segundosShopeeUtilizaveis(segundos);
  return utilizaveis === null ? null : utilizaveis * 1000;
}

/**
 * Is this stored `prodshopee` document a listing the ERP should still treat as
 * ALIVE? The predicate the `onProdutoShopeeLinkChanged` trigger scans survivors
 * with (S12).
 *
 * ⚠️ **Total and non-throwing over an UNVALIDATED document.** It is handed a
 * raw Firestore snapshot body — a migrated Flutter row, a half-written one, a
 * `null` — and it must answer a boolean for every one of them. A throw here
 * would abort a trigger whose whole job is to keep `integracoesComProduto`
 * honest.
 *
 * ⚠️ **An absent or `null` `estadoAnuncio` reads as VIVO.** `null` means NEVER
 * FOLDED — every link step 9 imported is one — and it is not evidence of
 * anything. The asymmetry is `integracoesComProduto.ts`'s verbatim: a false
 * positive costs one skipped sweep row, a false negative is a silent stock and
 * price outage. When in doubt, over-include.
 *
 * The `item_id` test is `typeof === 'number'` and `> 0`, so a link that has
 * never been published (`item_id: null`) is not a survivor. ⚠️ A STRINGIFIED id
 * therefore reads as NOT alive; the field is a typed `z.number().int()` and
 * nothing in this repo writes it as a string, but a corpus row that did would
 * take the false-negative direction — recorded rather than guessed around.
 */
export function anuncioShopeeVivo(link: Record<string, unknown> | null): boolean {
  if (link === null) return false;
  const itemId = link.item_id;
  if (typeof itemId !== 'number' || !Number.isFinite(itemId) || itemId <= 0) return false;
  return link.estadoAnuncio !== ESTADO_ANUNCIO_SHOPEE.removido;
}
