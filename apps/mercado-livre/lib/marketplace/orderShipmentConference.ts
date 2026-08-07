/**
 * Shipment ↔ pedido item conference — the pure half of #669.
 *
 * Asks ML what a shipment is actually going to send (`getShipmentOrders`) and
 * compares it against the lines the pedido stores, so a pedido whose items have
 * drifted from the sale is never priced — and never dispatched — as if they
 * matched. `applyFreteStep` owns the IO and the verdict's consequences; every
 * decision lives here, pure and unit-testable.
 *
 * ---- Ported from, but deliberately not a transcription of, legacy ----
 * `.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:536-568` ran
 * nested loops over (shipping item × pedido item) with no `break`, matching on
 * exact float equality of a single line's quantity plus an id comparison, and
 * concluded `seen.length != itensPedido.length`. Root `CLAUDE.md` says to
 * re-derive a ported query rather than transcribe it, and the same applies here
 * — that shape has two defects this module does not inherit:
 *
 *  1. **It could not aggregate.** Two pedido lines of quantity 1 against one
 *     shipment row of quantity 2 is the same sale, but legacy failed it. Keying
 *     the comparison on TOTAL units per `mktplaceId` makes packs and repeated
 *     listings reconcile by construction.
 *  2. **It was one-directional.** `seen ⊆ itensPedido`, so only "the pedido has
 *     a line the shipment lacks" could ever fire; a pedido MISSING a line passed
 *     silently, which is exactly what makes `valorCobrado` too low and lets a
 *     partial payment reach `pago`.
 *
 * ---- Why the two directions are treated differently ----
 * They are not symmetric, and blocking on both would flip healthy pedidos:
 *
 *  - **Excedente** (the pedido holds units ML is not selling) → BLOCKS. This is
 *    "we would ship goods, or a quantity, that were never bought", the case this
 *    issue exists for. It cannot be produced by a half-finished import:
 *    `orderPedidoTx` only ever APPENDS lines, so an incomplete pedido is always
 *    a subset of the sale, never a superset.
 *  - **Faltante** (ML is selling units the pedido does not hold) → does NOT
 *    block. This one fires transiently and legitimately: `pack_id` can be absent
 *    from a partial order payload (#793), so between the first order's import
 *    and its siblings' the pedido really does hold a subset of the shipment.
 *    Blocking here would `error` a perfectly healthy pedido on a routine race.
 *    It is logged rather than raised as an incidente for the same reason — an
 *    incidente per pack import would make the Incidentes tab noise instead of a
 *    signal — and the under-counted `valorCobrado` it causes already has its own
 *    repair path in `applyFreteStep`.
 *
 * ---- 🔒 ----
 * Nothing in this module may put pedido CONTENT in a message. Legacy's
 * `tasks.dart:616` interpolated the whole pedido — buyer name, CPF/CNPJ,
 * address, phone, prices — into an exception that was rethrown out of the Cloud
 * Run handler and into the logs. `descreverDivergencia` emits marketplace ids
 * and unit counts, nothing else, and is covered by a test that says so.
 */
import type { MlShipmentOrder } from '@delfrance/integrations-mercado-livre';
import type { ItemDoPedido } from '@delfrance/schemas';

/**
 * Float slack for the unit comparison. `ItemDoPedido.quantidade` is a
 * `z.number()`, not an integer, and both sides are summed before comparing, so
 * an exact `!==` would trip on accumulated representation error. Legacy compared
 * with Dart's `==` on a single line and had no sum to worry about.
 */
const TOLERANCIA_QUANTIDADE = 1e-9;

/** One `mktplaceId` whose unit totals disagree between the pedido and ML. */
export interface LinhaDivergente {
  readonly mktplaceId: string;
  /** Units the pedido stores. */
  readonly noPedido: number;
  /** Units ML says were bought. */
  readonly noEnvio: number;
}

export type ResultadoConferencia =
  /** Every line reconciles. */
  | { readonly tipo: 'ok' }
  /**
   * The comparison could not be made — ML sent nothing, or sent a row we cannot
   * key or count. Treated exactly like "not checked": the caller falls through
   * to its normal write. Refusing to judge beats judging on data we cannot read.
   */
  | { readonly tipo: 'indeterminado'; readonly motivo: string }
  | {
      readonly tipo: 'divergente';
      /** Units the pedido holds beyond what ML sold — the blocking kind. */
      readonly excedentes: readonly LinhaDivergente[];
      /** Units ML sold that the pedido does not hold — reported, not blocking. */
      readonly faltantes: readonly LinhaDivergente[];
      /** Stored lines carrying no `mktplaceId` at all — unreconcilable, blocking. */
      readonly semIdentificacao: number;
      /** Whether this divergence must stop the pedido. */
      readonly bloqueia: boolean;
    };

/**
 * The pedido-side identity of a shipment row.
 *
 * Mirrors `mlOrderItemToItemDoPedido`'s own rule (`orderMapping.ts:169`,
 * `variationId != null ? String(variationId) : itemId`) so both sides of the
 * comparison are keyed the same way by construction — that agreement is the
 * whole basis of the check.
 *
 * The extra `'0'` guard is defensive. `/shipments/{id}/orders` documents
 * `variation_id` as a nullable Long, but the older `/shipments/{id}/items`
 * resource uses `0` as its "no variation" sentinel; a pedido line never keys on
 * `'0'`, so were that sentinel to appear here it would mismatch every variation
 * sale at once.
 */
function mktplaceIdDaLinha(linha: MlShipmentOrder): string | null {
  const variacao = linha.variation_id;
  if (variacao != null) {
    const texto = String(variacao);
    if (texto !== '' && texto !== '0') return texto;
  }
  const item = linha.item_id;
  return item != null && item !== '' ? item : null;
}

/**
 * `requested_quantity` → a number, or null when it is not one.
 *
 * Deliberately NOT bare `Number(...)`: `Number(null)` and `Number('')` are both
 * `0`, which would silently turn an absent quantity into a real "zero units"
 * claim. Dart's `double.tryParse` — what legacy used — returns null for both,
 * and null never compared equal to a stored quantity.
 */
function paraQuantidade(valor: number | string | null | undefined): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor !== 'string') return null;
  const texto = valor.trim();
  if (texto === '') return null;
  const n = Number(texto);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compare the units ML says were bought against the units the pedido stores,
 * totalled per `mktplaceId`.
 *
 * `linhasDoEnvio` empty ⇒ `indeterminado`. ML documents `204 No Content` for
 * this resource, which the plugin schema parses to `[]`, so an empty array means
 * "ML told us nothing" — reading it as "the shipment covers no items" would flag
 * every line of a perfectly good pedido.
 *
 * `sellerUserId` filters a multi-seller cart down to our own rows. ML already
 * scopes the response to the caller ("cada vendedor só visualizará seus próprios
 * produtos"), so this is belt-and-braces — and it only ever applies when BOTH
 * ids are known, so an unattributed row is kept rather than silently dropped.
 */
export function conferirItensDoEnvio(args: {
  linhasDoEnvio: readonly MlShipmentOrder[];
  itensDoPedido: readonly ItemDoPedido[];
  sellerUserId: number | string | null;
}): ResultadoConferencia {
  const { linhasDoEnvio, itensDoPedido, sellerUserId } = args;

  if (linhasDoEnvio.length === 0) {
    return { tipo: 'indeterminado', motivo: 'o Mercado Livre não retornou nenhuma linha' };
  }

  const esperado = new Map<string, number>();
  for (const linha of linhasDoEnvio) {
    if (
      sellerUserId != null &&
      linha.seller_id != null &&
      String(linha.seller_id) !== String(sellerUserId)
    ) {
      continue;
    }
    const mktplaceId = mktplaceIdDaLinha(linha);
    if (mktplaceId == null) {
      return { tipo: 'indeterminado', motivo: 'linha do envio sem item_id/variation_id' };
    }
    const quantidade = paraQuantidade(linha.requested_quantity);
    if (quantidade == null) {
      return {
        tipo: 'indeterminado',
        motivo: `linha do envio ${mktplaceId} sem requested_quantity utilizável`,
      };
    }
    esperado.set(mktplaceId, (esperado.get(mktplaceId) ?? 0) + quantidade);
  }

  // Every row belonged to another seller — nothing of ours to reconcile.
  if (esperado.size === 0) {
    return { tipo: 'indeterminado', motivo: 'nenhuma linha do envio pertence a esta conta' };
  }

  const armazenado = new Map<string, number>();
  let semIdentificacao = 0;
  for (const item of itensDoPedido) {
    const mktplaceId = item.mktplaceId;
    if (mktplaceId == null || mktplaceId === '') {
      // A line nothing on ML's side can be matched to. In practice this is a row
      // a human added in the pedido form (`PrincipalTab`'s `addItem` seeds
      // `mktplaceId: null`) on a pedido whose `hasUserInteraction` was never
      // stamped — so it cannot be identified, and it WOULD be shipped.
      semIdentificacao += 1;
      continue;
    }
    armazenado.set(mktplaceId, (armazenado.get(mktplaceId) ?? 0) + item.quantidade);
  }

  const excedentes: LinhaDivergente[] = [];
  const faltantes: LinhaDivergente[] = [];
  for (const mktplaceId of new Set([...esperado.keys(), ...armazenado.keys()])) {
    const noEnvio = esperado.get(mktplaceId) ?? 0;
    const noPedido = armazenado.get(mktplaceId) ?? 0;
    const delta = noPedido - noEnvio;
    if (delta > TOLERANCIA_QUANTIDADE) excedentes.push({ mktplaceId, noPedido, noEnvio });
    else if (delta < -TOLERANCIA_QUANTIDADE) faltantes.push({ mktplaceId, noPedido, noEnvio });
  }

  if (excedentes.length === 0 && faltantes.length === 0 && semIdentificacao === 0) {
    return { tipo: 'ok' };
  }
  return {
    tipo: 'divergente',
    excedentes,
    faltantes,
    semIdentificacao,
    bloqueia: excedentes.length > 0 || semIdentificacao > 0,
  };
}

/** Stable `mktplaceId (pedido X un. × ML Y un.)` rendering, sorted for determinism. */
function listar(linhas: readonly LinhaDivergente[]): string {
  return [...linhas]
    .sort((a, b) => a.mktplaceId.localeCompare(b.mktplaceId))
    .map((l) => `${l.mktplaceId} (pedido ${l.noPedido} un. × ML ${l.noEnvio} un.)`)
    .join(', ');
}

/**
 * Operator-facing description of a divergence.
 *
 * 🔒 Marketplace ids and unit counts ONLY. This string reaches two places a
 * person reads — the incidente's `motivoDoIncidente` in the pedido's Incidentes
 * tab, and the thrown error's message, which ends up in the function logs — so
 * it must never carry buyer name, document, address, phone or prices. That is
 * precisely what legacy's `throw Exception('Erro ao atualizar frete \n $pedido …')`
 * did (tasks.dart:616), and it is the one thing from that line that must not be
 * ported.
 */
export function descreverDivergencia(
  divergencia: Extract<ResultadoConferencia, { tipo: 'divergente' }>,
  shipmentId: number | string,
): string {
  const partes: string[] = [];
  if (divergencia.excedentes.length > 0) {
    partes.push(
      `itens no pedido além do que o Mercado Livre vendeu: ${listar(divergencia.excedentes)}`,
    );
  }
  if (divergencia.faltantes.length > 0) {
    partes.push(`itens vendidos que faltam no pedido: ${listar(divergencia.faltantes)}`);
  }
  if (divergencia.semIdentificacao > 0) {
    partes.push(
      `${divergencia.semIdentificacao} item(ns) do pedido sem identificação de marketplace`,
    );
  }
  return (
    `[Mercado Livre] O conteúdo do pedido não confere com o envio ${shipmentId} — ` +
    `${partes.join('; ')}. ` +
    (divergencia.bloqueia
      ? 'O pedido foi colocado em erro para não ser despachado com o conteúdo errado. ' +
        'Corrija os itens e salve o pedido para liberá-lo.'
      : 'O pedido continua liberado; o total cobrado pode estar subestimado até que os ' +
        'itens restantes sejam importados.')
  );
}
