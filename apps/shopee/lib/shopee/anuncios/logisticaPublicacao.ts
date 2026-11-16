/**
 * Which Shopee logistics channels one item is published on (#1519, step 11).
 *
 * `logistic_info` is REQUIRED on `add_item`, and it is the one block of the
 * publish body the ERP has no field for: the shop's channels, their weight and
 * dimension limits, their fee types and their compulsory/auto-enable relations
 * all live on Shopee's side, in `get_channel_list`. So this module is a
 * RECONCILER between three things — what the shop offers, what the operator
 * already chose on the live listing, and what this parcel physically is.
 *
 * ## The two paths, and when the stored one wins
 *
 * On a REPUBLISH the link document may carry `logistic_info`. When THIS app
 * wrote it (Shopee's read-back of the live listing, an import's reading, the
 * body a publish sent, or the list the operator chose on a draft — #1911 P15),
 * it is the last list this app WROTE to this document —
 * for an item also the last it sent or read back; a kit republish sends a list
 * and writes none back (`../kits/vinculosKit.ts`). That may
 * include two values the ERP cannot produce at all: the `size_id` of a
 * `SIZE_SELECTION` channel and the `shipping_fee` of a `CUSTOM_PRICE` one. The
 * stamp records WHO wrote the list, never that it is current: a list a full
 * pass sent, a kit link's create-time body, or a draft's chosen list carries
 * neither value.
 * Rebuilding from scratch on every publish would silently overwrite them where
 * they exist. So a TRUSTED stored list is re-validated against the live channel
 * list and, when anything survives, it WINS — and its explicit offs count
 * (#1911 P15, D-12): an entry stored with the boolean `enabled: false` is not
 * sent, unless the channel is `force_enable` (`desligado-no-vinculo`). Only a
 * boolean `false` is an off; an absent, `null`, `'false'` or `0` reads ON.
 *
 * ⚠️ **The stored list is trusted only when this app wrote it (#2015).** The
 * legacy exporter rebuilt its own list from `get_channel_list` on every save,
 * sent THAT, and wrote back only `{item_id, item_status}` — so the
 * `logistic_info` a migrated link carries is whatever a legacy import or a
 * legacy screen last stored, not what the listing was given, and re-sending it
 * would put a stale `is_free`, fee or channel set back on a live listing.
 * Trust is the caller's {@link ArgsLogistica.armazenadoConfiavel}, which it
 * computes from the RAW link with `logisticaGravadaPeloErpShopee`
 * (`@delfrance/schemas`) — the provenance stamp `logisticaGravadaEm` that every
 * writer of the list in this app writes in the same patch. A DISTRUSTED list
 * never reaches the stored pass: the full pass runs, and only its own skips
 * are reported — and none of its offs is honoured, because nothing in this app
 * vouches for them.
 *
 * On a FIRST publish (or when nothing trusted survives) every SELECTABLE
 * channel ({@link canalSelecionavel}: shop-enabled, and not a fulfillment
 * channel) the parcel fits is enabled, minus a trusted list's explicit offs
 * (#1911 P15, D-11): the fallback never switches back on a channel the vínculo
 * switched off, and when nothing else is left the refusal says so — sentence
 * (3b) in {@link construirLogistica}.
 *
 * ## The two refusals a distrusted list adds
 *
 * The full pass has no `size_id` or `shipping_fee` to send, so it skips every
 * `SIZE_SELECTION` / `CUSTOM_PRICE` channel. On an ordinary channel that is a
 * skip and nothing more. On a COMPULSORY one it is a refusal, and when there is
 * a listing an import would re-read ({@link ArgsLogistica.itemIdImportavel})
 * the import is its remedy, whatever the distrusted list holds:
 *
 * - `logistica-nao-confirmada` (#2015) — the list holds a READABLE value for
 *   exactly the field that channel lacked: it is withheld, not missing, and the
 *   sentence names the listing to import;
 * - `logistica-sem-valor-gravado` (#2099, CPY-4) — it holds none: the value is
 *   absent or unreadable (`''`, `'12.5'`, `'0'`, a fee of `'grátis'`), so
 *   "não tem gravados" reads as "no usable value". The sentence names the
 *   channel as `«name» (id)` — the remedy may send the operator into Seller
 *   Centre, which lists channels by NAME — or by its id alone when the shop's
 *   list carries no usable name, and names the listing to import.
 *
 * Everything else — a draft, a removido link, a trusted list, a parcel that
 * does not fit, a channel the shop does not enable, a fulfillment channel —
 * keeps
 * `logistica-sem-canal`'s sentence unchanged. Before #1911 P14b an absent or
 * unreadable value on an importable listing kept it too, and that sentence
 * («só o Seller Centre define») was a dead end: while the list stays
 * distrusted the full pass never sends a stored value, so defining it in
 * Seller Centre and republishing failed the same way.
 *
 * When EVERY lost compulsory channel took one of the two, neither shop-wide
 * sentence (no compulsory channel enabled, no channel at all) is added.
 * Condition 3 of `remedioPelaImportacao` proves each such channel is enabled,
 * is not a fulfillment channel and fits, so after the import records a
 * readable value it is sent and
 * neither sentence could still hold. Under `logistica-sem-canal` each would
 * also carry the web's weight button, and the no-channel sentence says to
 * check weight and dimensions — but the produto's weight cannot fix a channel
 * the parcel already fits. One lost compulsory channel that kept its own
 * `logistica-sem-canal` sentence keeps both.
 *
 * ## What "re-validated" means, and why it is not a Zod parse
 *
 * The stored array is OUR persisted copy, not a Shopee response body, so the
 * package's `shopeeLogisticInfoSchema` is the wrong instrument twice over: its
 * `size_id` goes through `wireInt()`, which COERCES, where C32 requires a
 * refusal; and a whole-object parse failure would throw away the `logistic_id`
 * of an entry whose only defect is one unreadable field. Each field is therefore
 * read explicitly and refused rather than coerced — by ONE reader, shared with
 * the draft projection: `lerLogisticaArmazenadaShopee` (`@delfrance/schemas`,
 * #1911 P15, #1369), whose docblock carries the fold and its scope. This module
 * declares no reader of its own.
 *
 * Re-validation against the live list is the part that matters: the channel must
 * still exist, must still be enabled at shop level (or be `force_enable`), must
 * not be a fulfillment channel (`mask_channel_id` set and non-zero — #1911 P15),
 * and the parcel must still fit. A channel the seller closed last week is not
 * sent again because it is written down here.
 *
 * ## Three rules that each cost money in the wrong direction
 *
 * 1. **An unknown dimension unit SKIPS the channel; it never assumes `cm`.**
 *    Assuming cm against a channel whose limits are stated in inches enables a
 *    channel the parcel does not fit, and the buyer discovers it at pickup. The
 *    unit table is matched EXACTLY and in lower case — no trim, no case fold. A
 *    `'CM'` that Shopee chose to send in upper case is a string we have not seen
 *    and the honest answer is to skip one channel, not to guess.
 * 2. **`is_free` is masked by `block_seller_cover_shipping_fee`.** Offering free
 *    shipping on a channel that forbids the seller covering it is a request
 *    Shopee refuses — and the legacy sent a blanket `is_free: false` on every
 *    channel instead, which quietly dropped the seller's free-shipping offer.
 * 3. **A `size_id` that is not a safe integer REFUSES the channel.**
 *    `get_channel_list` answers `size_id` as a STRING and `add_item` wants an
 *    `int32`; `Number()` would turn `''` into `0` and `'12.5'` into `12.5`, and
 *    `0` is a size the seller never picked.
 *
 * ## What we never send
 *
 * **`enabled: false` never reaches the wire.** Only entries we want ON are sent.
 * Two consequences, both deliberate: `related_dependent_block_channels` cannot
 * fire (it triggers on DISABLING), and this ERP cannot turn a channel off —
 * closing a channel is a Seller Centre action. An off recorded in a TRUSTED
 * vínculo (#1911 P15) is honoured by NOT sending the channel; the ERP still
 * never disables a channel on a live listing.
 *
 * ⚠️ There is no `preferred` field on `get_channel_list`. The legacy DTO carried
 * one; a port that copies it inherits a phantom nothing answers.
 *
 * Pure: no Firestore, no Shopee call, no clock.
 */
import {
  SHOPEE_LOGISTICS_FEE_TYPE,
  type ShopeeChannelRelationRules,
  type ShopeeDimensionRequest,
  type ShopeeLogisticInfoRequest,
  type ShopeeLogisticsChannel,
} from '@delfrance/integrations-shopee';
import {
  type EntradaLogisticaArmazenadaShopee,
  lerLogisticaArmazenadaShopee,
  textoUtilizavelShopee,
} from '@delfrance/schemas';

import {
  MOTIVO_PUBLICACAO_BLOQUEADA,
  type ProblemaDeBloqueio,
  limitarMensagemProblema,
} from './errosPublicacao';

/** The three refusals this module produces, and nothing else. */
type MotivoDeLogistica =
  | typeof MOTIVO_PUBLICACAO_BLOQUEADA.logisticaSemCanal
  | typeof MOTIVO_PUBLICACAO_BLOQUEADA.logisticaNaoConfirmada
  | typeof MOTIVO_PUBLICACAO_BLOQUEADA.logisticaSemValorGravado;

/**
 * Every length unit `item_max_dimension.unit` may carry that we can convert,
 * and its factor to centimetres.
 *
 * ⚠️ A CLOSED table, matched by exact key. `Shopee`'s sample says `cm` and a
 * channel with no dimension limit at all says `UNKNOWN`; everything else is a
 * value we have not measured, and the module docblock says what we do about it.
 * `in` and `inch` are two spellings of ONE unit and therefore share a factor —
 * that is the only equivalence this table asserts.
 */
export const UNIDADES_PARA_CM: Readonly<Record<string, number>> = {
  cm: 1,
  mm: 0.1,
  m: 100,
  in: 2.54,
  inch: 2.54,
};

/**
 * Why ONE channel was left out of `logistic_info`.
 *
 * ⚠️ Diagnostic, not persisted — it is logged and printed by the CLI so an
 * operator can see why a channel they expected is missing. A member here is a
 * MECHANISM; the nine are the nine ways a channel can fail to be usable
 * (#1911 P15 added the last two).
 */
export type MotivoCanalPulado =
  /** Not `enabled` at shop level (and not `force_enable`), or gone from the list. */
  | 'nao-habilitado-na-loja'
  /** Outside the channel's `weight_limit` band. */
  | 'peso-fora-do-limite'
  /** One axis exceeds `item_max_dimension.{height,width,length}`. */
  | 'dimensao-fora-do-limite'
  /** `h+w+l` exceeds `item_max_dimension.dimension_sum`. */
  | 'soma-de-dimensoes-excedida'
  /** `item_max_dimension.unit` is not in {@link UNIDADES_PARA_CM}. */
  | 'unidade-desconhecida'
  /**
   * A `SIZE_SELECTION` channel with no usable stored `size_id` — and, since
   * #2015, every one the full pass meets after a DISTRUSTED list, whose sizes
   * are never read for sending.
   *
   * ⚠️ An ABSENT size and an UNREADABLE one are one verdict on purpose: in both
   * cases there is no size we may send, the operator's action is the same (pick
   * one in Seller Centre) and inventing another member would put a distinction
   * in a log line that nobody can act on differently. The distrusted case is not
   * another member either: it is what the refusal tells apart, on a
   * compulsory channel of an importable listing only — a readable stored value
   * is `logistica-nao-confirmada` (#2015), none is `logistica-sem-valor-gravado`
   * (#2099); both say to import the listing.
   */
  | 'size-selection-sem-size-id'
  /** A `CUSTOM_PRICE` channel with no usable stored `shipping_fee` (same #2015 note). */
  | 'custom-price-sem-tarifa'
  /**
   * `mask_channel_id` set and non-zero — a fulfillment channel hanging off a
   * checkout one (`types.ts`; guide 209 §7). An ABSENT mask is selectable
   * (D-LOG-1). Checked right after the shop-level enable and BEFORE the fit,
   * so a fulfillment channel never reads as one the parcel does not fit
   * (#1911 P15).
   */
  | 'canal-de-fulfillment'
  /**
   * A TRUSTED stored entry says `enabled: false` and the channel is not
   * `force_enable` (#1911 P15, D-12): skipped in BOTH passes, and never a lost
   * compulsory channel — the vínculo switched it off on purpose. A distrusted
   * list's off is never honoured, so it never produces this member.
   */
  | 'desligado-no-vinculo';

/** One channel we did not send, and why. */
export interface CanalPulado {
  readonly logisticId: number;
  readonly motivo: MotivoCanalPulado;
}

/** What {@link construirLogistica} answers. */
export interface ResultadoLogistica {
  /** The block that goes on the wire. Every entry is `enabled: true`. */
  readonly logistic_info: readonly ShopeeLogisticInfoRequest[];
  /**
   * Which channel ids will be ON after Shopee applies this request — the ones we
   * send PLUS the `related_enabled_channels` Shopee turns on alongside them.
   *
   * ⚠️ A channel may appear BOTH here and in {@link pulados}, and that is not a
   * contradiction: `pulados` answers "why did WE not send it", this set answers
   * "what will be on anyway". A reader chasing a surprise channel needs both.
   */
  readonly canaisHabilitados: readonly number[];
  readonly pulados: readonly CanalPulado[];
  /** Empty unless the item cannot be published at all for a logistics reason. */
  readonly problemas: readonly ProblemaDeBloqueio[];
}

/** The arguments of {@link construirLogistica}. */
export interface ArgsLogistica {
  /** `get_channel_list.logistics_channel_list`, unreadable rows already dropped. */
  readonly canais: readonly ShopeeLogisticsChannel[];
  /**
   * `link.logistic_info` exactly as stored — unvalidated. Re-sent only when
   * {@link armazenadoConfiavel}; a distrusted list is still handed over,
   * because the refusal reads it to say whether a value was there at all.
   */
  readonly armazenado: readonly unknown[] | null;
  /**
   * Whether THIS app wrote {@link armazenado} (#2015) — the caller's
   * `logisticaGravadaPeloErpShopee` (`@delfrance/schemas`) over the RAW link,
   * never re-derived here or from a projected field. `false` skips the stored
   * pass entirely: the full pass runs, `is_free` comes from the produto flag,
   * and no stored `size_id` / `shipping_fee` is sent.
   *
   * ⚠️ REQUIRED, so every caller decides: an absent flag cannot quietly read as
   * "trusted" and re-send a legacy list.
   */
  readonly armazenadoConfiavel: boolean;
  /**
   * The listing an import would re-read to replace a distrusted list — the
   * link's live `item_id` (the kit converter's: its PREDECESSOR's). `null` for
   * a draft, a first publish, a kit create and a `removido` link: there is
   * nothing to import, so the refusal keeps `logistica-sem-canal`'s sentence.
   */
  readonly itemIdImportavel: number | null;
  readonly pesoKg: number | null;
  /** The WIRE triple, already in centimetres. Never the produto fields. */
  readonly dimensaoCm: ShopeeDimensionRequest | null;
  readonly ofereceFreteGratis: boolean;
}

/**
 * The PARCEL half of {@link ArgsLogistica} — what one channel's verdict reads
 * (#1911 P15). The per-channel build and {@link avaliarCanaisDaLojaShopee} take
 * only this, so trust ({@link ArgsLogistica.armazenadoConfiavel}) stays a
 * decision of the passes, made once, and is never re-spelled at a new call
 * site — `logisticaProveniencia.test.ts` counts every place it is passed.
 */
export type ParcelaLogistica = Pick<ArgsLogistica, 'pesoKg' | 'dimensaoCm' | 'ofereceFreteGratis'>;

/**
 * One entry this module puts on the wire: a `ShopeeLogisticInfoRequest` whose
 * `is_free` is REQUIRED. {@link construirEntrada} always sets it — the stored
 * choice or the produto flag, masked by `block_seller_cover_shipping_fee` — so a
 * reader of an entry (the `canais` route's `automatica.isFree`, #1911 P15)
 * never has to invent a default for it.
 */
export type EntradaDoCanalShopee = ShopeeLogisticInfoRequest & { readonly is_free: boolean };

/* -------------------------------------------------------------------------- */
/*                              the small readers                             */
/* -------------------------------------------------------------------------- */

// The stored list's readers moved to `@delfrance/schemas` in #1911 P15
// (`lerLogisticaArmazenadaShopee`, #1369): the publisher and the draft
// projection read a stored entry through ONE function. Only the unit table's
// reader is left here.

/**
 * Convert a channel-stated length to centimetres, or `null` when the unit is one
 * we do not know.
 *
 * ⚠️ `null` is the ONLY answer for an unknown unit — never a factor of `1`. See
 * the module docblock, rule 1.
 */
export function paraCm(valor: number, unidade: string | null | undefined): number | null {
  if (unidade == null) return null;
  if (!Object.hasOwn(UNIDADES_PARA_CM, unidade)) return null;
  const fator = UNIDADES_PARA_CM[unidade];
  if (fator === undefined) return null;
  return valor * fator;
}

/* -------------------------------------------------------------------------- */
/*                                   the fit                                  */
/* -------------------------------------------------------------------------- */

/** A bound Shopee states, once folded: `0` and `null` both mean "no limit". */
function limite(bruto: number | null | undefined): number | null {
  if (bruto == null || bruto <= 0) return null;
  return bruto;
}

/**
 * Whether this parcel fits this channel — `null` when it does, the reason when
 * it does not.
 *
 * ⚠️ A `0` or `null` bound means NO LIMIT, on the page's own words, for
 * `weight_limit` and for each dimension axis. Treating `0` as a bound would
 * refuse every channel that simply does not state one.
 *
 * ⚠️ The unit is only consulted when there IS a bound to convert. A channel with
 * no dimension limit carries `unit: 'UNKNOWN'`, and refusing it as
 * `unidade-desconhecida` would drop the most permissive channels the shop has.
 */
export function cabeNoCanal(
  canal: ShopeeLogisticsChannel,
  pesoKg: number | null,
  dimensaoCm: ShopeeDimensionRequest | null,
): MotivoCanalPulado | null {
  if (pesoKg !== null) {
    const max = limite(canal.weight_limit?.item_max_weight);
    const min = limite(canal.weight_limit?.item_min_weight);
    if (max !== null && pesoKg > max) return 'peso-fora-do-limite';
    if (min !== null && pesoKg < min) return 'peso-fora-do-limite';
  }

  if (dimensaoCm === null) return null;
  const dim = canal.item_max_dimension;
  if (dim == null) return null;

  const alturaMax = limite(dim.height);
  const larguraMax = limite(dim.width);
  const comprimentoMax = limite(dim.length);
  const somaMax = limite(dim.dimension_sum);
  if (alturaMax === null && larguraMax === null && comprimentoMax === null && somaMax === null) {
    return null;
  }

  const eixos: readonly (readonly [number, number | null])[] = [
    [dimensaoCm.package_height, alturaMax],
    [dimensaoCm.package_width, larguraMax],
    [dimensaoCm.package_length, comprimentoMax],
  ];
  for (const [nosso, bruto] of eixos) {
    if (bruto === null) continue;
    const emCm = paraCm(bruto, dim.unit);
    if (emCm === null) return 'unidade-desconhecida';
    if (nosso > emCm) return 'dimensao-fora-do-limite';
  }

  if (somaMax !== null) {
    const somaEmCm = paraCm(somaMax, dim.unit);
    if (somaEmCm === null) return 'unidade-desconhecida';
    const nossaSoma =
      dimensaoCm.package_height + dimensaoCm.package_width + dimensaoCm.package_length;
    if (nossaSoma > somaEmCm) return 'soma-de-dimensoes-excedida';
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*                              the channel build                             */
/* -------------------------------------------------------------------------- */

/** `enabled` at shop level, or `force_enable` (a channel the seller cannot close). */
function habilitadoNaLoja(canal: ShopeeLogisticsChannel): boolean {
  return canal.enabled === true || canal.force_enable === true;
}

/**
 * `mask_channel_id` 0 — a checkout channel — or ABSENT (D-LOG-1): never a
 * fulfillment channel hanging off one (`types.ts`; guide 209 §7).
 *
 * ⚠️ `?? 0`, never `=== null`: the package schema folds an absent key to
 * `null`, but a channel that never went through it carries `undefined`, and
 * reading THAT as masked would skip every channel and refuse every publish.
 * `force_enable` does NOT lift it: a channel the seller cannot close is still
 * not one an item is published on.
 */
function mascaraSelecionavel(canal: ShopeeLogisticsChannel): boolean {
  return (canal.mask_channel_id ?? 0) === 0;
}

/**
 * Whether an item may be published on this channel at all, before any fit or
 * fee question (#1911 P15): enabled at shop level (or `force_enable`) AND not a
 * fulfillment channel. The SAME two checks, in the same order, open
 * {@link construirEntrada}, so this verdict and the publisher's skips cannot
 * disagree. Exported for the `canais` route, through
 * {@link avaliarCanaisDaLojaShopee}.
 */
export function canalSelecionavel(canal: ShopeeLogisticsChannel): boolean {
  return habilitadoNaLoja(canal) && mascaraSelecionavel(canal);
}

/**
 * A channel the item must carry: compulsory, or one the seller cannot close.
 * Exported for the `canais` route's `obrigatorio` (#1911 P15).
 */
export function canalInescapavel(canal: ShopeeLogisticsChannel): boolean {
  return canal.compulsory_channel === true || canal.force_enable === true;
}

/**
 * `channel_relation_rules` as a LIST, whichever of its two shapes arrived.
 *
 * ⚠️ The page's response table declares `object[]`; the live sandbox body
 * carries ONE object. The package declares both and folds neither, so the
 * normalisation is here — and both shapes must yield the same union, which is
 * what the paired test asserts.
 */
function regrasDeRelacao(canal: ShopeeLogisticsChannel): readonly ShopeeChannelRelationRules[] {
  const regras = canal.channel_relation_rules;
  if (regras == null) return [];
  return Array.isArray(regras) ? regras : [regras];
}

/** The ids Shopee auto-enables alongside this channel. */
function relacionadosHabilitados(canal: ShopeeLogisticsChannel): readonly number[] {
  const ids: number[] = [];
  for (const regra of regrasDeRelacao(canal)) {
    for (const id of regra.related_enabled_channels ?? []) {
      if (Number.isSafeInteger(id) && id > 0) ids.push(id);
    }
  }
  return ids;
}

/** One built entry, or the reason the channel was skipped. */
type Tentativa =
  | { readonly ok: true; readonly entrada: EntradaDoCanalShopee }
  | { readonly ok: false; readonly motivo: MotivoCanalPulado };

/**
 * Build the `logistic_info` entry for ONE channel.
 *
 * The checks run in ONE order, and each is a near-miss test: the shop-level
 * enable, then the mask ({@link canalSelecionavel}'s two), then the fit, then
 * the fee type's stored value. So a fulfillment channel is never reported as
 * one the parcel does not fit, and a size/fee skip proves the channel is
 * selectable and fits.
 *
 * `sizeId` / `shippingFee` / `isFree` are what the STORED entry said, or `null`
 * on a first publish and on the full pass — which is also the only pass a
 * distrusted list gets (#2015). The two fee types that need them have no other
 * source. `parcela` is the parcel alone ({@link ParcelaLogistica}): the trust
 * question is the passes', never one channel's.
 */
function construirEntrada(
  canal: ShopeeLogisticsChannel,
  parcela: ParcelaLogistica,
  armazenado: { sizeId: number | null; shippingFee: number | null; isFree: boolean | null },
): Tentativa {
  if (!habilitadoNaLoja(canal)) return { ok: false, motivo: 'nao-habilitado-na-loja' };
  if (!mascaraSelecionavel(canal)) return { ok: false, motivo: 'canal-de-fulfillment' };

  const naoCabe = cabeNoCanal(canal, parcela.pesoKg, parcela.dimensaoCm);
  if (naoCabe !== null) return { ok: false, motivo: naoCabe };

  const feeType = canal.fee_type;
  if (feeType === SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection && armazenado.sizeId === null) {
    return { ok: false, motivo: 'size-selection-sem-size-id' };
  }
  if (feeType === SHOPEE_LOGISTICS_FEE_TYPE.customPrice && armazenado.shippingFee === null) {
    return { ok: false, motivo: 'custom-price-sem-tarifa' };
  }

  // The operator's stored choice wins over the produto flag on a republish; the
  // block flag masks both (rule 2).
  const querGratis = armazenado.isFree ?? parcela.ofereceFreteGratis;
  const isFree = querGratis && canal.block_seller_cover_shipping_fee !== true;

  return {
    ok: true,
    entrada: {
      logistic_id: canal.logistics_channel_id,
      enabled: true,
      is_free: isFree,
      ...(feeType === SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection && armazenado.sizeId !== null
        ? { size_id: armazenado.sizeId }
        : {}),
      ...(feeType === SHOPEE_LOGISTICS_FEE_TYPE.customPrice && armazenado.shippingFee !== null
        ? { shipping_fee: armazenado.shippingFee }
        : {}),
    },
  };
}

const SEM_ARMAZENADO = { sizeId: null, shippingFee: null, isFree: null } as const;

/**
 * One problema naming the logistics refusal — `logistica-sem-canal` unless the
 * caller names another member this module produces. Always campo
 * `logistic_info`, never an `acao`.
 */
function problemaDeLogistica(
  mensagem: string,
  motivo: MotivoDeLogistica = MOTIVO_PUBLICACAO_BLOQUEADA.logisticaSemCanal,
): ProblemaDeBloqueio {
  return {
    campo: 'logistic_info',
    motivo,
    mensagem: limitarMensagemProblema(mensagem),
  };
}

/**
 * The two refusals whose remedy is importing the listing, and what each
 * sentence names. `itemId` is {@link ArgsLogistica.itemIdImportavel}, never
 * `null` here.
 */
type RemedioPelaImportacao =
  | {
      /** #2015 — the distrusted list holds the value READABLY; it is withheld. */
      readonly motivo: typeof MOTIVO_PUBLICACAO_BLOQUEADA.logisticaNaoConfirmada;
      /** The value the compulsory channel lacked, worded for the sentence. */
      readonly falta: 'um tamanho' | 'uma tarifa de frete';
      readonly itemId: number;
    }
  | {
      /** #2099 (CPY-4) — no stored entry of the channel holds the value readably. */
      readonly motivo: typeof MOTIVO_PUBLICACAO_BLOQUEADA.logisticaSemValorGravado;
      readonly itemId: number;
    };

/**
 * Which import-remedy refusal a lost compulsory channel takes — or `null`,
 * which keeps the `logistica-sem-canal` sentence.
 *
 * Conditions 1–3 are shared by both refusals, and each one is a near-miss test:
 * 1. the list is distrusted (a trusted one already had its stored pass);
 * 2. there is a listing to import — a draft or a `removido` link has none;
 * 3. the channel was skipped for the missing VALUE (`size-selection-sem-size-id`
 *    / `custom-price-sem-tarifa`), never for a fit or a shop-level reason —
 *    {@link construirEntrada} checks those first, so this motivo also proves the
 *    channel is enabled, is not a fulfillment channel (#1911 P15) and the
 *    parcel fits.
 *
 * Condition 4 then decides WHICH one, and the readable branch is tried FIRST:
 * - a stored entry for that channel holds that value READABLY — through the
 *   same `lerLogisticaArmazenadaShopee` entries the stored pass uses (`lidas`,
 *   read ONCE by {@link construirLogistica}), so the sentence's "not re-sent"
 *   is exactly what a trusted copy would have sent — ⇒
 *   `logistica-nao-confirmada` (#2015). A size where a fee was missing (or the
 *   reverse) does not count;
 * - none does (absent, unreadable, or only the OTHER field) ⇒
 *   `logistica-sem-valor-gravado` (#2099, CPY-4). Decided only after every
 *   skip of the channel was read, so one readable entry beside an unreadable
 *   one is still #2015's.
 *
 * ⚠️ The entries are NOT filtered by `ligado` (#1911 P15): a distrusted list's
 * off is never honoured, and condition 4 asks whether a VALUE is stored, never
 * whether the channel is on.
 */
function remedioPelaImportacao(
  args: ArgsLogistica,
  lidas: readonly EntradaLogisticaArmazenadaShopee[],
  pulados: readonly CanalPulado[],
  logisticId: number,
): RemedioPelaImportacao | null {
  if (args.armazenadoConfiavel) return null;
  const itemId = args.itemIdImportavel;
  if (itemId === null) return null;
  const doCanal = lidas.filter((lida) => lida.logisticId === logisticId);
  // Condition 3, seen for THIS channel — the only thing CPY-4 needs on top of 1–2.
  let faltouValor = false;
  for (const pulado of pulados) {
    if (pulado.logisticId !== logisticId) continue;
    if (pulado.motivo === 'size-selection-sem-size-id') {
      faltouValor = true;
      if (doCanal.some((lida) => lida.sizeId !== null)) {
        return {
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.logisticaNaoConfirmada,
          falta: 'um tamanho',
          itemId,
        };
      }
    }
    if (pulado.motivo === 'custom-price-sem-tarifa') {
      faltouValor = true;
      if (doCanal.some((lida) => lida.shippingFee !== null)) {
        return {
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.logisticaNaoConfirmada,
          falta: 'uma tarifa de frete',
          itemId,
        };
      }
    }
  }
  return faltouValor
    ? { motivo: MOTIVO_PUBLICACAO_BLOQUEADA.logisticaSemValorGravado, itemId }
    : null;
}

/**
 * How the CPY-4 sentence names a channel (#2099, Lucas §5-3): `«name» (id)`,
 * the shop's own `logistics_channel_name` — Seller Centre lists channels by
 * NAME, and CPY-4's remedy may send the operator there — or the id alone when
 * the channel is not in the list or its name is absent or blank.
 *
 * ⚠️ CPY-4 ONLY. `logistica-nao-confirmada` and `logistica-sem-canal` keep the
 * bare id (their sentences are approved text, and the id is what the CLI's
 * `pulados` lines print). The name is read through `textoUtilizavelShopee`
 * (`@delfrance/schemas`), the publisher's one "blank ⇒ absent" reader: a
 * whitespace-only name is ABSENT (never `«»`), and a usable one is shown
 * trimmed.
 */
function canalNomeado(logisticId: number, canal: ShopeeLogisticsChannel | undefined): string {
  const nome = textoUtilizavelShopee(canal?.logistics_channel_name);
  return nome === null ? String(logisticId) : `«${nome}» (${String(logisticId)})`;
}

/* -------------------------------------------------------------------------- */
/*                                  the build                                 */
/* -------------------------------------------------------------------------- */

interface Passagem {
  readonly entradas: ShopeeLogisticInfoRequest[];
  readonly pulados: CanalPulado[];
  /** Channels we could not satisfy although the item is not allowed to skip them. */
  readonly inescapaveisPerdidos: number[];
}

function novaPassagem(): Passagem {
  return { entradas: [], pulados: [], inescapaveisPerdidos: [] };
}

function registrar(passagem: Passagem, canal: ShopeeLogisticsChannel, tentativa: Tentativa): void {
  if (tentativa.ok) {
    passagem.entradas.push(tentativa.entrada);
    return;
  }
  passagem.pulados.push({ logisticId: canal.logistics_channel_id, motivo: tentativa.motivo });
  if (canalInescapavel(canal)) passagem.inescapaveisPerdidos.push(canal.logistics_channel_id);
}

/** The stored pass, and the channels its TRUSTED list switched off (#1911 P15). */
interface PassagemArmazenada {
  readonly passagem: Passagem;
  /**
   * The live channels a stored entry marks with the boolean `enabled: false`
   * and that are not `force_enable` — the ones {@link passagemCompleta} must
   * leave off too (D-11). Derived from the list alone, before any enable, mask
   * or fit question.
   */
  readonly desligados: ReadonlySet<number>;
}

/** A pass that never ran: a distrusted list, or none. */
function semPassagemArmazenada(): PassagemArmazenada {
  return { passagem: novaPassagem(), desligados: new Set<number>() };
}

/**
 * The stored list, re-validated against the live channel list.
 *
 * Per entry, in this order (#1911 P15): an unreadable `logistic_id` was
 * already dropped by the reader; a channel gone from the live list is
 * `nao-habilitado-na-loja` (main's); a stored off on a channel that is not
 * `force_enable` is `desligado-no-vinculo`, pushed DIRECTLY onto `pulados` —
 * never through {@link registrar}, so it is never a lost compulsory channel —
 * and recorded in `desligados`; anything else is {@link construirEntrada}'s
 * (enable → mask → fit → fee).
 */
function passagemArmazenada(
  lidas: readonly EntradaLogisticaArmazenadaShopee[],
  porId: ReadonlyMap<number, ShopeeLogisticsChannel>,
  parcela: ParcelaLogistica,
): PassagemArmazenada {
  const passagem = novaPassagem();
  const desligados = new Set<number>();
  for (const lida of lidas) {
    const canal = porId.get(lida.logisticId);
    if (canal === undefined) {
      // The channel disappeared from the shop's list since the last read-back.
      passagem.pulados.push({ logisticId: lida.logisticId, motivo: 'nao-habilitado-na-loja' });
      continue;
    }
    if (!lida.ligado && canal.force_enable !== true) {
      // A boolean `false` in a list THIS app wrote is the vínculo's own off
      // (D-12): honoured by not sending it. `force_enable` wins — the seller
      // cannot close that channel, so a stored off cannot either.
      passagem.pulados.push({ logisticId: lida.logisticId, motivo: 'desligado-no-vinculo' });
      desligados.add(lida.logisticId);
      continue;
    }
    registrar(
      passagem,
      canal,
      construirEntrada(canal, parcela, {
        sizeId: lida.sizeId,
        shippingFee: lida.shippingFee,
        isFree: lida.isFree,
      }),
    );
  }
  return { passagem, desligados };
}

/**
 * Every selectable channel the item fits, minus the trusted list's offs
 * (`desligados`, D-11): each of those is reported `desligado-no-vinculo` again
 * and never reaches {@link registrar} — the fallback never switches back on a
 * channel the vínculo switched off. A distrusted list hands over an empty set.
 */
function passagemCompleta(
  parcela: ParcelaLogistica,
  canais: readonly ShopeeLogisticsChannel[],
  desligados: ReadonlySet<number>,
): Passagem {
  const passagem = novaPassagem();
  for (const canal of canais) {
    if (desligados.has(canal.logistics_channel_id)) {
      passagem.pulados.push({
        logisticId: canal.logistics_channel_id,
        motivo: 'desligado-no-vinculo',
      });
      continue;
    }
    registrar(passagem, canal, construirEntrada(canal, parcela, SEM_ARMAZENADO));
  }
  return passagem;
}

/**
 * Build the item's `logistic_info`.
 *
 * A TRUSTED stored list ({@link ArgsLogistica.armazenadoConfiavel}) wins when
 * anything in it still validates; otherwise — a distrusted list, none at all,
 * or nothing that survives — every selectable channel the parcel fits is
 * enabled, minus the trusted list's explicit offs (#1911 P15, D-11). An empty
 * result is a `logistica-sem-canal` refusal — `logistic_info` is REQUIRED on
 * `add_item`, so there is no such thing as publishing with none: sentence (3),
 * or (3b) when a trusted off was among the channels left out, because then
 * weight and Seller Centre are not the only places the operator must look.
 * A lost compulsory channel is `logistica-sem-canal` too, except the two cases
 * {@link remedioPelaImportacao} names (`logistica-nao-confirmada`,
 * `logistica-sem-valor-gravado`). When every lost compulsory channel is one of
 * those, the two shop-wide sentences are left out (the module header's "The
 * two refusals a distrusted list adds"). (3b) and those two never meet: (3b)
 * needs a trusted list, and the remedies a distrusted one.
 */
export function construirLogistica(args: ArgsLogistica): ResultadoLogistica {
  const canais = args.canais.filter((c): c is ShopeeLogisticsChannel => c != null);
  const porId = new Map<number, ShopeeLogisticsChannel>();
  for (const canal of canais) porId.set(canal.logistics_channel_id, canal);

  // The stored list is read ONCE, through the shared reader (#1911 P15,
  // #1369), and both the stored pass and the import remedy read these entries.
  const lidas = lerLogisticaArmazenadaShopee(args.armazenado) ?? [];

  // ⚠️ When the stored list validates to EMPTY its `pulados` are discarded with
  // it: the full pass below walks the same channels and reports its own reasons,
  // and keeping both would list every channel twice. Its `desligados` are NOT
  // discarded — the full pass leaves those channels off too (D-11). A
  // DISTRUSTED list (#2015) never runs the stored pass at all — an empty pass
  // with no offs stands in for it, so the full pass runs and reports only its
  // own reasons.
  const armazenada = args.armazenadoConfiavel
    ? passagemArmazenada(lidas, porId, args)
    : semPassagemArmazenada();
  const passagem =
    armazenada.passagem.entradas.length > 0
      ? armazenada.passagem
      : passagemCompleta(args, canais, armazenada.desligados);

  const canaisHabilitados: number[] = [];
  const vistos = new Set<number>();
  const empurrar = (id: number): void => {
    if (vistos.has(id)) return;
    vistos.add(id);
    canaisHabilitados.push(id);
  };
  for (const entrada of passagem.entradas) empurrar(entrada.logistic_id);
  for (const entrada of passagem.entradas) {
    const canal = porId.get(entrada.logistic_id);
    if (canal === undefined) continue;
    for (const relacionado of relacionadosHabilitados(canal)) empurrar(relacionado);
  }

  const problemas: ProblemaDeBloqueio[] = [];
  let pelaImportacao = 0;
  for (const logisticId of passagem.inescapaveisPerdidos) {
    const remedio = remedioPelaImportacao(args, lidas, passagem.pulados, logisticId);
    if (remedio?.motivo === MOTIVO_PUBLICACAO_BLOQUEADA.logisticaNaoConfirmada) {
      // ⚠️ The claim is "no RECORD", never "not read / not sent": a missing
      // stamp proves only that nothing in this app vouches for the list. A
      // legacy import DID read it from Shopee, and a link this app wrote before
      // #2015 WAS sent by it. The web's copy makes the same claim, and shows
      // this sentence beside it as «Detalhe:».
      problemas.push(
        problemaDeLogistica(
          `O canal obrigatório ${String(logisticId)} precisa de ${remedio.falta}, ` +
            `e o ERP não tem registro de ter lido da Shopee nem de ter enviado a ela o ` +
            `valor gravado neste vínculo, então esse valor não é reenviado. Importe o ` +
            `anúncio ${String(remedio.itemId)} para gravar os valores atuais da ` +
            `Shopee e publique de novo.`,
          MOTIVO_PUBLICACAO_BLOQUEADA.logisticaNaoConfirmada,
        ),
      );
      pelaImportacao += 1;
      continue;
    }
    if (remedio?.motivo === MOTIVO_PUBLICACAO_BLOQUEADA.logisticaSemValorGravado) {
      // #2099 (CPY-4), Lucas's sentence verbatim. Nothing usable is stored, so
      // it never says "não é reenviado" (there is nothing to withhold); the
      // same "no RECORD" claim as #2015's, about the LIST this time. Both
      // exits are real: an import records what Seller Centre holds today, and
      // a value Seller Centre does not hold yet must be set there first.
      problemas.push(
        problemaDeLogistica(
          `O canal obrigatório ${canalNomeado(logisticId, porId.get(logisticId))} precisa ` +
            `de um tamanho ou de uma tarifa de frete que este vínculo não tem gravados, e o ` +
            `ERP não tem registro de ter gravado a lista de logística dele. Se o valor já ` +
            `está no Seller Centre, importe o anúncio ${String(remedio.itemId)} e publique ` +
            `de novo; se não está, defina-o no Seller Centre antes.`,
          MOTIVO_PUBLICACAO_BLOQUEADA.logisticaSemValorGravado,
        ),
      );
      pelaImportacao += 1;
      continue;
    }
    problemas.push(
      problemaDeLogistica(
        `O canal obrigatório ${String(logisticId)} não pôde ser habilitado: ` +
          `falta um valor que só o Seller Centre define (tamanho ou tarifa), ` +
          `ou o item não cabe nos limites do canal.`,
      ),
    );
  }

  // ⚠️ #2015 (V-REFUSAL-9), widened by #2099 (CPY-4): when EVERY lost
  // compulsory channel took `logistica-nao-confirmada` or
  // `logistica-sem-valor-gravado`, the import their sentences name is the
  // remedy — `remedioPelaImportacao`'s condition 3 proves each of those
  // channels is enabled, is not a fulfillment channel and fits, so once the
  // import records a readable value
  // they are sent and neither shop-wide sentence below holds. Under
  // `logistica-sem-canal` each would get the web's weight button on its
  // `logistic_info` row, and the no-channel one says to check weight and
  // dimensions — advice that contradicts those sentences, since the produto's
  // weight cannot fix a channel the parcel already fits. So neither is added.
  // One lost compulsory channel that kept the sentence above — a fit failure,
  // a draft, a trusted list — keeps both, because there weight or Seller
  // Centre IS a remedy. `> 0` is load-bearing: with no lost compulsory channel
  // "every" is vacuous, and an empty list must still say so.
  const soFaltaImportar =
    pelaImportacao > 0 && pelaImportacao === passagem.inescapaveisPerdidos.length;

  const temInescapavel = canais.some((c) => canalInescapavel(c));
  const enviouInescapavel = passagem.entradas.some((e) => {
    const canal = porId.get(e.logistic_id);
    return canal !== undefined && canalInescapavel(canal);
  });
  if (temInescapavel && !enviouInescapavel && !soFaltaImportar) {
    problemas.push(
      problemaDeLogistica('Nenhum canal obrigatório da loja pôde ser habilitado para este item.'),
    );
  }

  if (passagem.entradas.length === 0 && !soFaltaImportar) {
    // (3b), #1911 P15 (D-11): a channel the TRUSTED list switched off was left
    // out, so "the shop's channels" is not the whole story — the vínculo's own
    // choice is part of it. Only that `pulados` member decides it; the motivo
    // stays `logistica-sem-canal` either way, and (3) is byte-unchanged.
    const deixouDesligado = passagem.pulados.some((p) => p.motivo === 'desligado-no-vinculo');
    problemas.push(
      problemaDeLogistica(
        deixouDesligado
          ? 'Nenhum canal ligado neste vínculo aceita este item (os desligados nele não ' +
              'são usados): confira peso, dimensões e os canais habilitados no Seller ' +
              'Centre — num rascunho, também os canais escolhidos na aba Shopee do produto.'
          : 'Nenhum canal de logística da loja aceita este item: confira peso, ' +
              'dimensões e os canais habilitados no Seller Centre.',
      ),
    );
  }

  return {
    logistic_info: passagem.entradas,
    canaisHabilitados,
    pulados: passagem.pulados,
    problemas,
  };
}

/* -------------------------------------------------------------------------- */
/*                     the per-channel verdict (#1911 P15)                    */
/* -------------------------------------------------------------------------- */

/** One shop channel, with the verdict the publisher's full pass gives it. */
export interface CanalAvaliadoShopee {
  readonly canal: ShopeeLogisticsChannel;
  /** {@link canalSelecionavel}: shop-enabled (or `force_enable`) and not a fulfillment channel. */
  readonly selecionavel: boolean;
  /** {@link canalInescapavel}: compulsory, or `force_enable`. */
  readonly obrigatorio: boolean;
  /**
   * Why the full pass would skip it, or `null` when it would send it. The type
   * is the WHOLE union, but `desligado-no-vinculo` never appears here: there
   * is no stored list to switch anything off.
   */
  readonly motivo: MotivoCanalPulado | null;
  /** The entry the full pass would send — non-`null` exactly when `motivo` is `null`. */
  readonly entrada: EntradaDoCanalShopee | null;
}

/**
 * Every shop channel with the verdict the publisher's FULL pass gives it, for
 * the `canais` route (#1911 P15, #1369): the editor shows the operator the same
 * decision a publish will take, never a second copy of the fit, mask, enable or
 * `is_free` rules.
 *
 * Per channel, {@link construirEntrada} with no stored value — exactly what
 * {@link passagemCompleta} calls with no offs — in `get_channel_list` order,
 * unreadable (`null`) rows dropped as {@link construirLogistica} drops them. It
 * takes the parcel alone ({@link ParcelaLogistica}): there is no stored list
 * here, so there is no trust to decide.
 *
 * ⚠️ A verdict, never a decision: publish re-reads `get_channel_list` uncached
 * and recomputes every one of them, so a stale answer can mislead a screen but
 * never a send.
 */
export function avaliarCanaisDaLojaShopee(
  entrada: ParcelaLogistica & { readonly canais: readonly ShopeeLogisticsChannel[] },
): readonly CanalAvaliadoShopee[] {
  const canais = entrada.canais.filter((c): c is ShopeeLogisticsChannel => c != null);
  return canais.map((canal) => {
    const tentativa = construirEntrada(canal, entrada, SEM_ARMAZENADO);
    return {
      canal,
      selecionavel: canalSelecionavel(canal),
      obrigatorio: canalInescapavel(canal),
      motivo: tentativa.ok ? null : tentativa.motivo,
      entrada: tentativa.ok ? tentativa.entrada : null,
    };
  });
}
