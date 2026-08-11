/**
 * Maps a Mercado Livre shipment (`GET /shipments/{shipmentId}` +
 * `.../payments`) onto our `freteInicial` field set, and the state-preserving
 * merge used when a fresher webhook-driven shipment read would otherwise
 * regress a `freteInicial.estado` the app has since moved past.
 *
 * Ports `MercadoLivreShipping.toFrete` / `OrderML.freteFromMercadoLivre`
 * (legacy `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:3100-3177,5364-5395`)
 * and the shipments-topic merge guard
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:1295-1319`)
 * onto our field names (`packages/schemas/src/shared/frete.ts`).
 *
 * Pure — no IO, no `Date.now()`.
 */
import { roundReais } from '@delfrance/core/money';
import { coerceToMicros } from '@delfrance/core/datetime';
import {
  shipmentBaseCost,
  shipmentLeadTime,
  type MlShipment,
  type MlShipmentPayment,
} from '@delfrance/integrations-mercado-livre';
import { ESTADO_FRETE } from '@delfrance/schemas';
import type { EstadoFrete, FreteDoPedido, IntegracaoFrete } from '@delfrance/schemas';
import { INTEGRACAO_FRETE } from '@delfrance/schemas';
import { estadoFreteFromShipment } from './orderStatusMaps';

/**
 * Fields `mlShipmentToFreteInicial` sets — spread onto a `freteInicial` block
 * alongside its schema defaults.
 */
export interface MappedFreteInicialFields {
  externalId: string;
  externalOptionIntegracao: IntegracaoFrete;
  estado: EstadoFrete;
  integracaoFreteOuterRef: string | null;
  enderecoFreteOuterReference: string | null;
  modalidade: string;
  codRastreio: string | null;
  valorCobrado: number;
  /**
   * `null` = "ML did not tell us", distinct from a real zero. Load-bearing:
   * `mergeFreteInicial` preserves the stored value on `null`, so a shipment
   * payload that omits the cost can no longer overwrite a correct one with a
   * fabricated `0` (#957).
   */
  custoCalculado: number | null;
  custoFinal: number | null;
  dataPrevisaoEntrega: number | null;
  ultimaModificacao: number | null;
  prazoDespacho: number | null;
}

/**
 * `modalidadeFrete.contratacaoDestinatario` — the legacy default
 * (`integracao.modalidadeFreteImportacao ?? modalidadeFrete.contratacaoDestinatario`,
 * models.dart:3161/5381). Value `'1'` per
 * `.old/packages/canal_de_vendas/lib/src/models.dart:19`.
 */
const MODALIDADE_CONTRATACAO_DESTINATARIO = '1';

/**
 * `INTEGRACOES_FRETE.mercadoLivre` (models.dart:3163/5383) — our
 * `integracoesFreteSchema` literal.
 */
const EXTERNAL_OPTION_INTEGRACAO_MERCADO_LIVRE: IntegracaoFrete = INTEGRACAO_FRETE.mercadoLivre;

/**
 * A `shipping_payments[].amount` reads as either a JSON number or a numeric
 * string in the wild (plugin `types.ts`); legacy stringifies then
 * `double.tryParse`s regardless (models.dart:5376), defaulting to 0 on
 * failure — replicate that tolerance exactly.
 */
function toAmountNumber(amount: MlShipmentPayment['amount']): number {
  if (amount == null) return 0;
  const n = typeof amount === 'number' ? amount : Number(amount);
  return Number.isFinite(n) ? n : 0;
}

/**
 * `valorPagoFrete` — sum of `shipping_payments[].amount` where
 * `status == 'approved'` (models.dart:3109-3115/5372-5378).
 */
function sumApprovedShippingPayments(shippingPayments: readonly MlShipmentPayment[]): number {
  return roundReais(
    shippingPayments
      .filter((p) => p.status === 'approved')
      .reduce((sum, p) => sum + toAmountNumber(p.amount), 0),
  );
}

export function mlShipmentToFreteInicial(args: {
  shipment: MlShipment;
  shippingPayments: MlShipmentPayment[];
  integracaoFreteOuterRef: string | null;
  enderecoOuterRef: string | null;
  prazoDespachoUs: number | null;
  modalidadeOverride: string | null;
}): MappedFreteInicialFields {
  const {
    shipment,
    shippingPayments,
    integracaoFreteOuterRef,
    enderecoOuterRef,
    prazoDespachoUs,
    modalidadeOverride,
  } = args;

  const leadTime = shipmentLeadTime(shipment);

  return {
    externalId: String(shipment.id),
    externalOptionIntegracao: EXTERNAL_OPTION_INTEGRACAO_MERCADO_LIVRE,
    // Approved deviation: ONE substatus-honoring mapper is used everywhere
    // (`estadoFreteFromShipment`) — legacy had two inconsistent variants here
    // (`toFrete` read `status.toEstadoFrete()`, ignoring substatus, while
    // `OrderML.freteFromMercadoLivre` read the substatus-aware
    // `shippingInstance.toEstadoFrete()`); we always honor substatus.
    estado: estadoFreteFromShipment(shipment.status ?? '', shipment.substatus ?? null),
    integracaoFreteOuterRef,
    enderecoFreteOuterReference: enderecoOuterRef,
    modalidade: modalidadeOverride ?? MODALIDADE_CONTRATACAO_DESTINATARIO,
    codRastreio: shipment.tracking_number ?? null,
    valorCobrado: sumApprovedShippingPayments(shippingPayments),
    // Legacy mapped both of these with `?? 0` (models.dart:3172/3173/5391), and
    // `mergeFreteInicial` then wrote them unconditionally — so a payload that
    // simply omitted a cost silently overwrote a correct stored value with zero.
    // The `x-format-new` body drops `base_cost` entirely, which would have made
    // that fire on every shipment. Absent now maps to `null` and the merge
    // preserves; `derivePedidoFreteTotals` already reads
    // `custoCalculado ?? custoFinal ?? 0`, so nothing downstream needs a fake 0.
    custoCalculado: shipmentBaseCost(shipment),
    custoFinal: leadTime?.list_cost ?? null,
    dataPrevisaoEntrega: coerceToMicros(leadTime?.estimated_delivery_time?.date ?? null),
    ultimaModificacao: coerceToMicros(shipment.last_updated ?? null),
    prazoDespacho: prazoDespachoUs,
  };
}

/**
 * `ESTADOS_FRETE.ehEstadoAtensDoCheckout` (legacy
 * `.old/packages/integracao_frete/lib/src/integracao_frete_base.dart:224-237`)
 * — every pre-checkout-completion estado. Kept local: only
 * `mergeEstadoFretePreservando` needs it, and it must match this file's
 * `EstadoFrete` literals exactly.
 */
const ESTADOS_ANTES_DO_CHECKOUT: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.fulfillment,
  ESTADO_FRETE.iniciado,
  ESTADO_FRETE.aguardandoAutorizacao,
  ESTADO_FRETE.aguardandoNFe,
  ESTADO_FRETE.aguardandoValidacaoTransporadora,
  ESTADO_FRETE.despachoAutorizado,
  ESTADO_FRETE.emSeparacao,
  ESTADO_FRETE.empacotado,
  ESTADO_FRETE.aguardandoPostagem,
]);

/**
 * State-preserving merge for an incoming (fresher) shipment read against the
 * pedido's current `freteInicial.estado`, from the shipments-topic handler's
 * branch conditions
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:1306-1315`;
 * the ms/µs-timestamp freshness gate above those lines is the CALLER's
 * responsibility — this function is only the estado decision):
 *
 * ```dart
 * if (oldFrete.estado == ESTADOS_FRETE.despachoAutorizado
 *     && (novoFrete.estado == ESTADOS_FRETE.iniciado || novoFrete.estado == ESTADOS_FRETE.aguardandoAutorizacao)){
 *   // ...copyWith(estado: ESTADOS_FRETE.despachoAutorizado)
 * } if (oldFrete.estado == ESTADOS_FRETE.checkFinalizado && novoFrete.estado.ehEstadoAtensDoCheckout) {
 *   // ...copyWith(estado: ESTADOS_FRETE.checkFinalizado)
 * } else {
 *   // ...oldFrete.update(novoFrete) — novoFrete.estado wins (update() takes `other.estado`, non-nullable)
 * }
 * ```
 *
 * ⚠️ Deliberate legacy-bug fix, NOT byte parity: in the Dart source the first
 * branch is followed by `} if (` (no `else`), so when it fires the second
 * `if`'s `else` ALSO saves `oldFrete.update(novoFrete)` over it in the same
 * transaction — deployed legacy therefore never actually preserves
 * `despachoAutorizado` (a stale `iniciado`/`aguardandoAutorizacao` regresses
 * it). We return the preserved estado, which is what both the legacy branch
 * and the port plan ("preserving dispatch authorization") intend; a regressed
 * estado would re-block dispatch/labels the app already authorized.
 */
export function mergeEstadoFretePreservando(
  oldEstado: EstadoFrete,
  novoEstado: EstadoFrete,
): EstadoFrete {
  if (
    oldEstado === ESTADO_FRETE.despachoAutorizado &&
    (novoEstado === ESTADO_FRETE.iniciado || novoEstado === ESTADO_FRETE.aguardandoAutorizacao)
  ) {
    return ESTADO_FRETE.despachoAutorizado;
  }
  if (oldEstado === ESTADO_FRETE.checkFinalizado && ESTADOS_ANTES_DO_CHECKOUT.has(novoEstado)) {
    return ESTADO_FRETE.checkFinalizado;
  }
  return novoEstado;
}

/* -------------------------------------------------------------------------- */
/*            Frete freshness — ONE comparison, two declared policies          */
/* -------------------------------------------------------------------------- */

/** What a freshness comparison answers when one of the two watermarks is absent. */
export type PoliticaSemWatermark = 'aplicar' | 'ignorar';

/**
 * The three null cases a frete freshness check has to answer. They are named
 * per call site rather than defaulted, because the frete merge paths in this
 * app genuinely DISAGREE on them and each disagreement is legacy-faithful (see
 * the two constants below). ADR 0011's first named failure mode is exactly this
 * comparison hand-written at every call site in a slightly different spelling.
 */
export interface PoliticaFrescorFrete {
  /** Verdict when the pedido carries no `freteInicial` block at all. */
  semFrete: PoliticaSemWatermark;
  /** Verdict when a block exists but stores no `ultimaModificacao`. */
  semWatermarkArmazenado: PoliticaSemWatermark;
  /** Verdict when the incoming payload carries no `ultimaModificacao`. */
  semWatermarkRecebido: PoliticaSemWatermark;
}

export interface FreteFrescorArgs extends PoliticaFrescorFrete {
  /** `pedido.freteInicial == null` — READ INSIDE THE TRANSACTION (rule 7). */
  semFreteArmazenado: boolean;
  /** Stored `freteInicial.ultimaModificacao`, **MICROSECONDS**. */
  armazenadoUs: number | null;
  /** Incoming `MappedFreteInicialFields.ultimaModificacao`, **MICROSECONDS**. */
  recebidoUs: number | null;
}

/**
 * `true` ⇔ the incoming shipment payload is strictly newer than what is stored.
 *
 * Both operands are microseconds since epoch. A caller reading a RAW Firestore
 * snapshot rather than `parseRead` MUST pass them through `coerceToMicros`
 * first — a Flutter-written millisecond value compared against a microsecond
 * one is a guard that never fires (root `CLAUDE.md` rule 7 / ADR 0011).
 */
export function freteRecebidoEhMaisNovo(args: FreteFrescorArgs): boolean {
  if (args.semFreteArmazenado) return args.semFrete === 'aplicar';
  if (args.armazenadoUs == null) return args.semWatermarkArmazenado === 'aplicar';
  if (args.recebidoUs == null) return args.semWatermarkRecebido === 'aplicar';
  return args.armazenadoUs < args.recebidoUs;
}

/**
 * ORDER-IMPORT policy (`orderImport.ts`'s `applyFreteStep`). The order import
 * is the ONLY path that CREATES a frete block, so an absent or unstamped block
 * is always refreshed; a payload with no parseable `shipment.last_updated`
 * never overwrites a stamped block (tasks.dart:497-658).
 */
export const POLITICA_FRESCOR_IMPORT_PEDIDO: PoliticaFrescorFrete = {
  semFrete: 'aplicar',
  semWatermarkArmazenado: 'aplicar',
  semWatermarkRecebido: 'ignorar',
};

/**
 * SHIPMENTS-TOPIC policy (`orderShipmentImport.ts`) — legacy's `?? true` on the
 * `isAfter` check (tasks.dart:1301-1304): a stored block with NO watermark
 * counts as "already newer" and blocks the write, the OPPOSITE of the
 * order-import policy above, and a null block is never created here.
 *
 * ⚠️ Deliberate asymmetry, documented at `orderShipmentImport.ts`'s own
 * docstring. Do NOT "unify" these two constants.
 */
export const POLITICA_FRESCOR_TOPICO_SHIPMENTS: PoliticaFrescorFrete = {
  semFrete: 'ignorar',
  semWatermarkArmazenado: 'ignorar',
  semWatermarkRecebido: 'ignorar',
};

/**
 * Overlay `mapped` onto `existing` (or use `mapped` fresh when there is no
 * prior frete). Ports `FreteDoPedido.update`
 * (`.old/packages/pedido/lib/src/models.dart:672-708`) field-for-field, with
 * one deliberate extension: legacy's `update()` is `other.field ?? this.field`
 * for EVERY field it touches (including `valorCobrado`/`custoCalculado`/
 * `custoFinal`, which `MappedFreteInicialFields` never sets to null anyway);
 * this port only applies the `mapped.x ?? existing.x ?? null` nullable-preserving
 * pattern to the mapped keys that are ACTUALLY typed nullable. `estado` goes
 * through `mergeEstadoFretePreservando` instead of legacy's plain
 * `other.estado`, which additionally fixes the dangling-`if` regression
 * documented on that function.
 *
 * ⚠️ This function is NOT recency-aware and must never be made so. Clamping
 * `ultimaModificacao` to `max(stored, incoming)` while still applying the older
 * payload's FIELDS would produce a document whose watermark advertises data it
 * does not contain — which every downstream gate then reads as "already
 * current", turning a TRANSIENT rollback (the next redelivery repairs it) into
 * a PERMANENT one. It would also advance the watermark on the write that LOST,
 * which ADR 0011 names directly. Pair it with {@link freteRecebidoEhMaisNovo},
 * or use {@link mergeFreteInicialSeMaisNovo}.
 */
export function mergeFreteInicial(
  existing: FreteDoPedido | null | undefined,
  mapped: MappedFreteInicialFields,
): Record<string, unknown> {
  if (!existing) return { ...mapped };
  const estado = mergeEstadoFretePreservando(existing.estado, mapped.estado);
  return {
    ...existing,
    externalId: mapped.externalId,
    externalOptionIntegracao: mapped.externalOptionIntegracao,
    estado,
    integracaoFreteOuterRef:
      mapped.integracaoFreteOuterRef ?? existing.integracaoFreteOuterRef ?? null,
    enderecoFreteOuterReference:
      mapped.enderecoFreteOuterReference ?? existing.enderecoFreteOuterReference ?? null,
    modalidade: mapped.modalidade,
    codRastreio: mapped.codRastreio ?? existing.codRastreio ?? null,
    valorCobrado: mapped.valorCobrado,
    // `?? existing`, like every other field here. These two used to be written
    // unconditionally, which made an absent cost overwrite a correct stored
    // value with `0` — silent financial corruption, and the one merge behaviour
    // that differed from its neighbours for no stated reason (#957).
    custoCalculado: mapped.custoCalculado ?? existing.custoCalculado ?? null,
    custoFinal: mapped.custoFinal ?? existing.custoFinal ?? null,
    dataPrevisaoEntrega: mapped.dataPrevisaoEntrega ?? existing.dataPrevisaoEntrega ?? null,
    ultimaModificacao: mapped.ultimaModificacao ?? existing.ultimaModificacao ?? null,
    prazoDespacho: mapped.prazoDespacho ?? existing.prazoDespacho ?? null,
  };
}

/**
 * Guarded merge: the overlay ONLY when `mapped` is strictly newer than
 * `existing` under `politica`, and `null` otherwise — meaning "write NOTHING",
 * neither the fields nor the watermark.
 *
 * This is the shape that protects the merge call sites by construction (issue
 * #791): the function cannot produce a document carrying a fresh watermark over
 * stale fields, because on a stale payload it produces no document at all.
 *
 * `existing.ultimaModificacao` is coerced here, so a caller may pass a block
 * read straight from a raw snapshot (legacy Flutter wrote these in
 * MILLISECONDS) without the comparison silently never firing.
 */
export function mergeFreteInicialSeMaisNovo(
  existing: FreteDoPedido | null | undefined,
  mapped: MappedFreteInicialFields,
  politica: PoliticaFrescorFrete,
): Record<string, unknown> | null {
  const maisNovo = freteRecebidoEhMaisNovo({
    semFreteArmazenado: existing == null,
    armazenadoUs: coerceToMicros(existing?.ultimaModificacao ?? null),
    recebidoUs: coerceToMicros(mapped.ultimaModificacao),
    ...politica,
  });
  return maisNovo ? mergeFreteInicial(existing, mapped) : null;
}
