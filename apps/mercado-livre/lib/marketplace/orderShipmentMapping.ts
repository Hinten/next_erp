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
import type { MlShipment, MlShipmentPayment } from '@delfrance/integrations-mercado-livre';
import type { EstadoFrete, IntegracaoFrete } from '@delfrance/schemas';
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
  custoCalculado: number;
  custoFinal: number;
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
const EXTERNAL_OPTION_INTEGRACAO_MERCADO_LIVRE: IntegracaoFrete = 'mercadoLivre';

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

  const shippingOption = shipment.shipping_option ?? null;

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
    // `base_cost ?? 0` — parity with the ORDER-IMPORT path
    // (`OrderML.freteFromMercadoLivre`, models.dart:3172), this milestone's
    // consumer. (The legacy shipments-TOPIC path `toFrete` yields null here;
    // divergence only when `base_cost` is absent.)
    custoCalculado: shipment.base_cost ?? 0,
    // `shipping_option.list_cost ?? 0` (models.dart:3173/5391 — legacy defaults
    // to 0 rather than null when the option carries no list cost).
    custoFinal: shippingOption?.list_cost ?? 0,
    dataPrevisaoEntrega: coerceToMicros(shippingOption?.estimated_delivery_time?.date ?? null),
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
const ESTADOS_ANTES_DO_CHECKOUT: ReadonlySet<EstadoFrete> = new Set([
  'fulfillment',
  'iniciado',
  'aguardandoAutorizacao',
  'aguardandoNFe',
  'aguardandoValidacaoTransporadora',
  'despachoAutorizado',
  'emSeparacao',
  'empacotado',
  'aguardandoPostagem',
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
    oldEstado === 'despachoAutorizado' &&
    (novoEstado === 'iniciado' || novoEstado === 'aguardandoAutorizacao')
  ) {
    return 'despachoAutorizado';
  }
  if (oldEstado === 'checkFinalizado' && ESTADOS_ANTES_DO_CHECKOUT.has(novoEstado)) {
    return 'checkFinalizado';
  }
  return novoEstado;
}
