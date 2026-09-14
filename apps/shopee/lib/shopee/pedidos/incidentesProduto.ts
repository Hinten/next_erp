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
 * despacho or NF-e. `ORIGEM_INCIDENTE.outros` (99) is used rather than a new
 * `pedidoShopee` member: `origemIncidenteSchema` is a closed `z.union`, and
 * widening it reaches BOTH generated rulesets (rule 2) for a value nothing
 * branches on here. Step 17 owns that decision, where the blocking overlay
 * actually reads `origem`.
 *
 * `subtipo` is a FREE passthrough key — `incidenteSchema` has no such field and
 * is `.passthrough()`, which is what the estoque sync already relies on for its
 * own `estoque-drift` rows. No schema change, no ruleset regeneration.
 */
import type { Firestore } from 'firebase-admin/firestore';
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
