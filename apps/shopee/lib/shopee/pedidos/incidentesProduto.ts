/**
 * One `incidentes` document per Shopee order line that resolved to NO produto
 * (#1513, step 5, plan R3) — so an unbound line is visible in the pedido's
 * Incidentes tab instead of silently sitting under the `'NONE'` key.
 *
 * Mirrors Mercado Livre's `recordItensSemProduto` field for field, and the
 * reasoning is the same in both channels:
 *
 *  - `produtoUid: null` is KEPT rather than falling back to the parent produto.
 *    `calcularAlteracoesEstoque` skips null/`'NONE'`, whereas a parent binding
 *    would make `sincronizarEstoquePedido` CREATE a negative-quantity estoque
 *    doc on a produto that owns none.
 *  - Race tier 0 (root `CLAUDE.md` rule 7): the doc id is derived from the
 *    line's already-deterministic `ensureUniqueId`
 *    (`sha256(order_sn-mktplaceId-index)`), so a push redelivery, the reprocess
 *    sweep and the order backfill all re-drive the same payload onto the SAME
 *    document. `.create()` + swallow ONLY `ALREADY_EXISTS` keeps the first row's
 *    `timestamp` instead of re-dating it on every replay.
 *
 * ## ⚠️ `tipo` and `origem` are chosen so this can never BLOCK
 *
 * `TIPO_INCIDENTE.outros` (`'o'`) is explicitly absent from
 * `TIPOS_INCIDENTE_BLOQUEANTES`, so a produto-não-vinculado row can never stop
 * despacho or NF-e. `ORIGEM_INCIDENTE.outros` (99) is used, NEVER
 * `ORIGEM_INCIDENTE.pedidoShopee` (5): step 17 (#1525) added that member for a
 * Shopee RETURN, and it sits in `ORIGENS_INCIDENTE_MARKETPLACE` — the overlay's
 * origem allow-list — which 99 never may. So both gates refuse this row, each
 * on its own.
 *
 * ⚠️ An earlier revision of this comment said widening `origemIncidenteSchema`
 * "reaches BOTH generated rulesets". It does not: `pedidos/{pedidoId}/incidentes`
 * is absent from `VALIDATOR_WHITELIST` (`packages/rules-gen/src/registry.ts`),
 * so its rules carry permissions and the `overrideBloqueio` guard but no field
 * validator — step 17 widened the union with both `gen:rules*:check` green.
 *
 * `subtipo` is a FREE passthrough key — `incidenteSchema` has no such field and
 * is `.passthrough()`, which is what the estoque sync already relies on for its
 * own `estoque-drift` rows. No schema change, no ruleset regeneration.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { formatReais } from '@delfrance/core/money';
import {
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  flattenPedidoItens,
  type ItemDoPedido,
  type Pedido,
} from '@delfrance/schemas';
import { incidenteCollection } from '@delfrance/data/admin/collections';
import { isAlreadyExists } from '@delfrance/data/admin/grpcErrors';

import type { ResolvedShopeeLineProduto } from './produtoResolve';

/** `subtipo` for a line no rung could bind. */
export const SUBTIPO_NAO_VINCULADO = 'shopee-produto-nao-vinculado';
/** `subtipo` for a line whose SKU named more than one produto. */
export const SUBTIPO_SKU_AMBIGUO = 'shopee-produto-sku-ambiguo';

export interface LinhaSemProdutoShopee {
  /** The mapped line, exactly as it will be (or was) stored. */
  readonly item: ItemDoPedido;
  /** `item_list[].item_id` — what the operator opens in Seller Center. */
  readonly itemId: number;
  /** `item_list[].model_id`; `null` or `0` ⇒ the line sold no variation. */
  readonly modelId: number | null;
  /** Which rung answered, or `null` when the resolver was never called. */
  readonly via: ResolvedShopeeLineProduto['via'] | null;
}

export interface RegistrarLinhasSemProdutoArgs {
  readonly pedidoId: string;
  /** The order number, for the log line only — never part of a document. */
  readonly orderSn: string;
  readonly linhas: readonly LinhaSemProdutoShopee[];
  /**
   * The STORED pedido's `itens` map, or `null` for a pedido this run created.
   * A line already stored WITH a produto is not a problem, whoever bound it —
   * the migrated corpus may already hold this order, bound by the legacy
   * importer, and the item merge is append-only, so raising an incidente for it
   * would be a false positive.
   */
  readonly itensGravados: Pedido['itens'] | null;
  /** The importer's ONE clock read, in µs. Never a clock read here. */
  readonly nowUs: number;
}

/**
 * Write one incidente per unbound line. Returns how many were CREATED — a
 * redelivery legitimately creates none.
 *
 * Rule 6: the only swallowed failure is gRPC `ALREADY_EXISTS`, narrowed through
 * `isAlreadyExists`. Everything else — `PERMISSION_DENIED`, a `ZodError` from
 * the write parse, a transport failure — rethrows, which the notification
 * pipeline reads as transient and retries.
 */
export async function registrarLinhasSemProduto(
  db: Firestore,
  args: RegistrarLinhasSemProdutoArgs,
): Promise<number> {
  const { pedidoId, orderSn, linhas, itensGravados, nowUs } = args;

  const jaVinculados = new Set(
    flattenPedidoItens(itensGravados ?? {})
      .filter((item) => item.produtoUid != null && item.ensureUniqueId != null)
      .map((item) => item.ensureUniqueId!),
  );

  const criados: string[] = [];
  for (const linha of linhas) {
    const { item } = linha;
    if (item.produtoUid != null || item.ensureUniqueId == null) continue;
    if (jaVinculados.has(item.ensureUniqueId)) continue;

    // An AMBIGUOUS sku is a different problem from an absent one and needs a
    // different action: de-duplicating the cadastro alone does NOT re-bind this
    // pedido, because the item merge is append-only, so the operator must bind
    // here as well. Both branches are one produto-less line, hence ONE doc id —
    // the verdict can flip between two deliveries of the same order, and a
    // second id namespace would leave two rows for one line.
    const ambiguo = linha.via === 'ambiguous-sku';
    const id = `shopee-prod-${item.ensureUniqueId}`;
    try {
      await incidenteCollection.docRef(db, { pedidoId }, id).create(
        incidenteCollection.parse({
          origem: ORIGEM_INCIDENTE.outros,
          tipo: TIPO_INCIDENTE.outros,
          subtipo: ambiguo ? SUBTIPO_SKU_AMBIGUO : SUBTIPO_NAO_VINCULADO,
          motivoDoIncidente: motivoDoIncidente(linha, ambiguo),
          comentarios: null,
          timestamp: nowUs,
          ultimaModificacao: nowUs,
          externalId: item.mktplaceId,
          resolucao: null,
        }),
      );
      criados.push(id);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }

  if (criados.length > 0) {
    // Ids and counts only — a `nomeDeVenda` is a product title, but the line's
    // own document already carries it and a log line does not need it.
    // ⚠️ `info`, not `warn`: the unbound line is ALREADY reported as an
    // incidente the operator sees, and on staging every line takes this arm
    // until step 9 runs — a warning here would drown the ones that mean
    // something.
    // eslint-disable-next-line no-console -- see the note above
    console.info('[shopee/pedidos] linhas sem produto registradas como incidentes', {
      orderSn,
      pedidoId,
      criados: criados.length,
    });
  }
  return criados.length;
}

/** `subtipo` (and doc id) of the "buyer paid more than the lines" incidente. */
export const SUBTIPO_PAGAMENTO_DIVERGENTE = 'shp-pagamento-divergente';

export interface RegistrarPagamentoDivergenteArgs {
  readonly pedidoId: string;
  /** The order number, for the log line only — never part of a document. */
  readonly orderSn: string;
  /** `buyer_total_amount`. */
  readonly totalDoComprador: number | null;
  /** What the NF-e states — the pagamento's `valor`. */
  readonly totalDaNota: number;
  /** The importer's ONE clock read, in µs. */
  readonly nowUs: number;
}

/**
 * ONE incidente per pedido when the buyer paid MORE than the lines state
 * (`dinheiroShopee.ts`'s `pago-acima`): the pagamento then states the NF-e
 * total and nothing is invented — Amazon's `pagamento-divergente` rule.
 *
 * Race tier 0, like {@link registrarLinhasSemProduto}: the doc id IS the
 * subtipo, one per pedido, `.create()` + swallow ONLY `ALREADY_EXISTS`, so a
 * redelivery keeps the first row. Non-blocking for the same two reasons
 * (`tipo` and `origem` `outros`). Returns whether it CREATED the row.
 */
export async function registrarPagamentoDivergente(
  db: Firestore,
  args: RegistrarPagamentoDivergenteArgs,
): Promise<boolean> {
  const { pedidoId, orderSn, totalDoComprador, totalDaNota, nowUs } = args;
  try {
    await incidenteCollection.docRef(db, { pedidoId }, SUBTIPO_PAGAMENTO_DIVERGENTE).create(
      incidenteCollection.parse({
        origem: ORIGEM_INCIDENTE.outros,
        tipo: TIPO_INCIDENTE.outros,
        subtipo: SUBTIPO_PAGAMENTO_DIVERGENTE,
        motivoDoIncidente:
          `[Shopee] O comprador pagou ${formatReais(totalDoComprador ?? 0)}, acima do total ` +
          `que as linhas do pedido somam (${formatReais(totalDaNota)}). O pagamento foi ` +
          'gravado com o total da nota. Confira as linhas, os descontos e o frete do pedido.',
        comentarios: null,
        timestamp: nowUs,
        ultimaModificacao: nowUs,
        externalId: null,
        resolucao: null,
      }),
    );
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    return false;
  }
  console.warn('[shopee/pedidos] pagamento divergente registrado como incidente', {
    orderSn,
    pedidoId,
    totalDoComprador,
    totalDaNota,
  });
  return true;
}

/**
 * The operator-facing text. The ANÚNCIO and the VARIAÇÃO are named separately:
 * `mktplaceId` alone is ambiguous — it is `model_id ?? item_id`, so labelling it
 * "anúncio" is wrong for exactly the variation sale this incidente exists for,
 * and the `item_id` is what opens the listing in Seller Center.
 *
 * ⚠️ `model_id: 0` is "no variation", so it is never printed as `variação 0`.
 * ⚠️ No buyer datum ever reaches this string.
 */
function motivoDoIncidente(linha: LinhaSemProdutoShopee, ambiguo: boolean): string {
  const { item, itemId, modelId } = linha;
  const variacao = modelId != null && modelId !== 0 ? `, variação ${modelId}` : '';
  const cabecalho =
    `[Shopee] Item "${item.nomeDeVenda ?? String(itemId)}" ` +
    `(anúncio ${itemId}${variacao}, SKU ${item.sku ?? '—'}) `;
  return ambiguo
    ? cabecalho +
        'não foi vinculado: este SKU corresponde a mais de um produto do ERP, ' +
        'então nenhum foi escolhido. ' +
        'O item ficou sem produto: nenhum estoque foi movimentado. ' +
        'Vincule o produto manualmente neste pedido e corrija os SKUs duplicados no cadastro.'
    : cabecalho +
        'não foi vinculado a nenhum produto do ERP. ' +
        'O item ficou sem produto: nenhum estoque foi movimentado. ' +
        'Vincule o produto manualmente no pedido.';
}
