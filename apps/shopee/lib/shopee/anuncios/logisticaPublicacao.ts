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
 * wrote it (Shopee's read-back of the live listing, an import's reading, or the
 * body a publish sent), it is the last list this app WROTE to this document —
 * for an item also the last it sent or read back; a kit republish sends a list
 * and writes none back (`../kits/vinculosKit.ts`). That may
 * include two values the ERP cannot produce at all: the `size_id` of a
 * `SIZE_SELECTION` channel and the `shipping_fee` of a `CUSTOM_PRICE` one. The
 * stamp records WHO wrote the list, never that it is current: a list a full
 * pass sent, or a kit link's create-time body, carries neither value.
 * Rebuilding from scratch on every publish would silently overwrite them where
 * they exist. So a TRUSTED stored list is re-validated against the live channel
 * list and, when anything survives, it WINS.
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
 * are reported.
 *
 * On a FIRST publish (or when nothing trusted survives) every shop-enabled
 * channel the parcel fits is enabled.
 *
 * ## The one refusal a distrusted list adds
 *
 * The full pass has no `size_id` or `shipping_fee` to send, so it skips every
 * `SIZE_SELECTION` / `CUSTOM_PRICE` channel. On an ordinary channel that is a
 * skip and nothing more. On a COMPULSORY one it is a refusal — and when the
 * distrusted list holds a readable value for exactly the field that channel
 * lacked, and there is a listing an import would re-read
 * ({@link ArgsLogistica.itemIdImportavel}), the refusal is
 * `logistica-nao-confirmada`, naming that listing. Everything else — a draft, a
 * removido link, a trusted list, an absent or unreadable value, a parcel that
 * does not fit — keeps `logistica-sem-canal`'s sentence unchanged.
 *
 * When EVERY lost compulsory channel took it, neither shop-wide sentence (no
 * compulsory channel enabled, no channel at all) is added. Condition 3 of
 * `faltaNaoConfirmada` proves each such channel is enabled and fits, so after
 * the import records a readable value it is sent and neither sentence could
 * still hold. Under `logistica-sem-canal` each would also carry the web's
 * weight button, and the no-channel sentence says to check weight and
 * dimensions. One lost compulsory channel that kept its own
 * `logistica-sem-canal` sentence keeps both.
 *
 * ## What "re-validated" means, and why it is not a Zod parse
 *
 * The stored array is OUR persisted copy, not a Shopee response body, so the
 * package's `shopeeLogisticInfoSchema` is the wrong instrument twice over: its
 * `size_id` goes through `wireInt()`, which COERCES, where C32 requires a
 * refusal; and a whole-object parse failure would throw away the `logistic_id`
 * of an entry whose only defect is one unreadable field. Each field is therefore
 * read explicitly and refused rather than coerced — see {@link paraInteiroWire}.
 *
 * Re-validation against the live list is the part that matters: the channel must
 * still exist, must still be enabled at shop level (or be `force_enable`), and
 * the parcel must still fit. A channel the seller closed last week is not sent
 * again because it is written down here.
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
 * closing a channel is a Seller Centre action.
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
  MOTIVO_PUBLICACAO_BLOQUEADA,
  type ProblemaDeBloqueio,
  limitarMensagemProblema,
} from './errosPublicacao';

/** The two refusals this module produces, and nothing else. */
type MotivoDeLogistica =
  | typeof MOTIVO_PUBLICACAO_BLOQUEADA.logisticaSemCanal
  | typeof MOTIVO_PUBLICACAO_BLOQUEADA.logisticaNaoConfirmada;

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
 * MECHANISM; the seven are the seven ways a channel can fail to be usable.
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
   * one in Seller Centre) and inventing an eighth member would put a distinction
   * in a log line that nobody can act on differently. The distrusted case is not
   * an eighth member either: it is what the refusal tells apart, on a
   * compulsory channel only (`logistica-nao-confirmada`).
   */
  | 'size-selection-sem-size-id'
  /** A `CUSTOM_PRICE` channel with no usable stored `shipping_fee` (same #2015 note). */
  | 'custom-price-sem-tarifa';

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

/* -------------------------------------------------------------------------- */
/*                              the small readers                             */
/* -------------------------------------------------------------------------- */

/**
 * A wire integer that is safe to send as an `int32` id, or `null`.
 *
 * ⚠️ `Number()` is reached ONLY behind a digits-only test, and that is the whole
 * point of the function: `Number('')` is `0`, `Number(' 12 ')` is `12` and
 * `Number('12.5')` is `12.5`, so a bare coercion invents ids. `0` is refused
 * here as well — no Shopee channel or size id is `0`, and a `'0'` that
 * round-tripped would send a size the seller did not pick (C32).
 */
function paraInteiroWire(bruto: unknown): number | null {
  if (typeof bruto === 'number') {
    return Number.isSafeInteger(bruto) && bruto > 0 ? bruto : null;
  }
  if (typeof bruto !== 'string' || !/^\d+$/.test(bruto)) return null;
  const n = Number(bruto);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A finite wire number (a shipping fee), or `null`. Same refuse-don't-coerce rule. */
function paraNumeroWire(bruto: unknown): number | null {
  if (typeof bruto === 'number') return Number.isFinite(bruto) ? bruto : null;
  if (typeof bruto !== 'string' || !/^\d+(\.\d+)?$/.test(bruto)) return null;
  const n = Number(bruto);
  return Number.isFinite(n) ? n : null;
}

/** Read one field off an unvalidated stored entry. */
function campo(bruto: unknown, nome: string): unknown {
  if (bruto == null || typeof bruto !== 'object' || Array.isArray(bruto)) return undefined;
  return (bruto as Record<string, unknown>)[nome];
}

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

/** A channel the item must carry: compulsory, or one the seller cannot close. */
function canalInescapavel(canal: ShopeeLogisticsChannel): boolean {
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
  | { readonly ok: true; readonly entrada: ShopeeLogisticInfoRequest }
  | { readonly ok: false; readonly motivo: MotivoCanalPulado };

/**
 * Build the `logistic_info` entry for ONE channel.
 *
 * `sizeId` / `shippingFee` / `isFreeArmazenado` are what the STORED entry said,
 * or `null` on a first publish and on the full pass — which is also the only
 * pass a distrusted list gets (#2015). The two fee types that need them have no
 * other source.
 */
function construirEntrada(
  canal: ShopeeLogisticsChannel,
  args: ArgsLogistica,
  armazenado: { sizeId: number | null; shippingFee: number | null; isFree: boolean | null },
): Tentativa {
  if (!habilitadoNaLoja(canal)) return { ok: false, motivo: 'nao-habilitado-na-loja' };

  const naoCabe = cabeNoCanal(canal, args.pesoKg, args.dimensaoCm);
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
  const querGratis = armazenado.isFree ?? args.ofereceFreteGratis;
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
 * caller names the other member this module produces. Always campo
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

/** What the `logistica-nao-confirmada` sentence names (#2015). */
interface FaltaNaoConfirmada {
  /** The value the compulsory channel lacked, worded for the sentence. */
  readonly falta: 'um tamanho' | 'uma tarifa de frete';
  /** {@link ArgsLogistica.itemIdImportavel}, never `null` here. */
  readonly itemId: number;
}

/**
 * What a lost compulsory channel lacked, when a DISTRUSTED stored list held a
 * readable value for exactly that, plus the listing to import — or `null`,
 * which keeps the `logistica-sem-canal` sentence (#2015).
 *
 * All four conditions, each one a near-miss test:
 * 1. the list is distrusted (a trusted one already had its stored pass);
 * 2. there is a listing to import — a draft or a `removido` link has none;
 * 3. the channel was skipped for the missing VALUE (`size-selection-sem-size-id`
 *    / `custom-price-sem-tarifa`), never for a fit or a shop-level reason —
 *    {@link construirEntrada} checks those first, so this motivo also proves the
 *    channel is enabled and the parcel fits;
 * 4. a stored entry for that channel holds that value READABLY — through the
 *    same {@link paraInteiroWire} / {@link paraNumeroWire} the stored pass uses,
 *    so the sentence's "not re-sent" is exactly what a trusted copy would have
 *    sent. A size where a fee was missing (or the reverse) does not count.
 */
function faltaNaoConfirmada(
  args: ArgsLogistica,
  pulados: readonly CanalPulado[],
  logisticId: number,
): FaltaNaoConfirmada | null {
  if (args.armazenadoConfiavel) return null;
  const itemId = args.itemIdImportavel;
  if (itemId === null) return null;
  const doCanal = (args.armazenado ?? []).filter(
    (bruto) => paraInteiroWire(campo(bruto, 'logistic_id')) === logisticId,
  );
  for (const pulado of pulados) {
    if (pulado.logisticId !== logisticId) continue;
    if (
      pulado.motivo === 'size-selection-sem-size-id' &&
      doCanal.some((bruto) => paraInteiroWire(campo(bruto, 'size_id')) !== null)
    ) {
      return { falta: 'um tamanho', itemId };
    }
    if (
      pulado.motivo === 'custom-price-sem-tarifa' &&
      doCanal.some((bruto) => paraNumeroWire(campo(bruto, 'shipping_fee')) !== null)
    ) {
      return { falta: 'uma tarifa de frete', itemId };
    }
  }
  return null;
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

/** The stored list, re-validated against the live channel list. */
function passagemArmazenada(
  args: ArgsLogistica,
  porId: ReadonlyMap<number, ShopeeLogisticsChannel>,
): Passagem {
  const passagem = novaPassagem();
  for (const bruto of args.armazenado ?? []) {
    const logisticId = paraInteiroWire(campo(bruto, 'logistic_id'));
    if (logisticId === null) continue;
    const canal = porId.get(logisticId);
    if (canal === undefined) {
      // The channel disappeared from the shop's list since the last read-back.
      passagem.pulados.push({ logisticId, motivo: 'nao-habilitado-na-loja' });
      continue;
    }
    const isFreeBruto = campo(bruto, 'is_free');
    registrar(
      passagem,
      canal,
      construirEntrada(canal, args, {
        sizeId: paraInteiroWire(campo(bruto, 'size_id')),
        shippingFee: paraNumeroWire(campo(bruto, 'shipping_fee')),
        isFree: typeof isFreeBruto === 'boolean' ? isFreeBruto : null,
      }),
    );
  }
  return passagem;
}

/** Every shop-enabled channel the item fits. */
function passagemCompleta(
  args: ArgsLogistica,
  canais: readonly ShopeeLogisticsChannel[],
): Passagem {
  const passagem = novaPassagem();
  for (const canal of canais) {
    registrar(passagem, canal, construirEntrada(canal, args, SEM_ARMAZENADO));
  }
  return passagem;
}

/**
 * Build the item's `logistic_info`.
 *
 * A TRUSTED stored list ({@link ArgsLogistica.armazenadoConfiavel}) wins when
 * anything in it still validates; otherwise — a distrusted list, none at all,
 * or nothing that survives — every shop-enabled channel the parcel fits is
 * enabled. An empty result is a `logistica-sem-canal` refusal — `logistic_info`
 * is REQUIRED on `add_item`, so there is no such thing as publishing with none.
 * A lost compulsory channel is `logistica-sem-canal` too, except the one case
 * {@link faltaNaoConfirmada} names (`logistica-nao-confirmada`). When every
 * lost compulsory channel is that case, the two shop-wide sentences are left
 * out (the module header's "The one refusal a distrusted list adds").
 */
export function construirLogistica(args: ArgsLogistica): ResultadoLogistica {
  const canais = args.canais.filter((c): c is ShopeeLogisticsChannel => c != null);
  const porId = new Map<number, ShopeeLogisticsChannel>();
  for (const canal of canais) porId.set(canal.logistics_channel_id, canal);

  // ⚠️ When the stored list validates to EMPTY its `pulados` are discarded with
  // it: the full pass below walks the same channels and reports its own reasons,
  // and keeping both would list every channel twice. A DISTRUSTED list (#2015)
  // never runs the stored pass at all — an empty pass stands in for it, so the
  // full pass runs and reports only its own reasons.
  const armazenada = args.armazenadoConfiavel ? passagemArmazenada(args, porId) : novaPassagem();
  const passagem = armazenada.entradas.length > 0 ? armazenada : passagemCompleta(args, canais);

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
  let naoConfirmados = 0;
  for (const logisticId of passagem.inescapaveisPerdidos) {
    const naoConfirmada = faltaNaoConfirmada(args, passagem.pulados, logisticId);
    if (naoConfirmada !== null) {
      // ⚠️ The claim is "no RECORD", never "not read / not sent": a missing
      // stamp proves only that nothing in this app vouches for the list. A
      // legacy import DID read it from Shopee, and a link this app wrote before
      // #2015 WAS sent by it. The web's copy makes the same claim, and shows
      // this sentence beside it as «Detalhe:».
      problemas.push(
        problemaDeLogistica(
          `O canal obrigatório ${String(logisticId)} precisa de ${naoConfirmada.falta}, ` +
            `e o ERP não tem registro de ter lido da Shopee nem de ter enviado a ela o ` +
            `valor gravado neste vínculo, então esse valor não é reenviado. Importe o ` +
            `anúncio ${String(naoConfirmada.itemId)} para gravar os valores atuais da ` +
            `Shopee e publique de novo.`,
          MOTIVO_PUBLICACAO_BLOQUEADA.logisticaNaoConfirmada,
        ),
      );
      naoConfirmados += 1;
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

  // ⚠️ #2015 (V-REFUSAL-9): when EVERY lost compulsory channel took
  // `logistica-nao-confirmada`, the import its sentence names is the whole
  // remedy — `faltaNaoConfirmada`'s condition 3 proves each of those channels
  // is enabled and fits, so once the import records a readable value they are
  // sent and neither shop-wide sentence below holds. Under
  // `logistica-sem-canal` each would get the web's weight button on its
  // `logistic_info` row, and the no-channel one says to check weight and
  // dimensions — advice that contradicts that sentence. So neither is added.
  // One lost compulsory channel that kept the sentence above — a fit failure,
  // an unreadable value, a draft — keeps both, because there weight or Seller
  // Centre IS a remedy. `> 0` is load-bearing: with no lost compulsory channel
  // "every" is vacuous, and an empty list must still say so.
  const soFaltaConfirmar =
    naoConfirmados > 0 && naoConfirmados === passagem.inescapaveisPerdidos.length;

  const temInescapavel = canais.some((c) => canalInescapavel(c));
  const enviouInescapavel = passagem.entradas.some((e) => {
    const canal = porId.get(e.logistic_id);
    return canal !== undefined && canalInescapavel(canal);
  });
  if (temInescapavel && !enviouInescapavel && !soFaltaConfirmar) {
    problemas.push(
      problemaDeLogistica('Nenhum canal obrigatório da loja pôde ser habilitado para este item.'),
    );
  }

  if (passagem.entradas.length === 0 && !soFaltaConfirmar) {
    problemas.push(
      problemaDeLogistica(
        'Nenhum canal de logística da loja aceita este item: confira peso, ' +
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
