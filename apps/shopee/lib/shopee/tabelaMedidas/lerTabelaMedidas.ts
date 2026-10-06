/**
 * ONE size-chart template, read and projected (step 18, #1526) — the detail
 * route's whole body.
 *
 * `get_size_chart_detail` answers column-oriented; the projection into
 * columns, rows and problems is `projetarTabelaShopee` in `@delfrance/schemas`,
 * done ONCE there and never re-done here or in the browser (#1369). This module
 * is the projector's single call site in `apps/shopee`, which is what makes it
 * the compiler's check that the package's parsed `ShopeeSizeChartDetail` still
 * fits the projector's structural input: the package cannot depend on
 * `@delfrance/schemas`, so no other line checks it.
 *
 * ⚠️ `sizeChartId` in the answer is the id the caller ASKED for; Shopee's echo
 * only feeds the `id-divergente` problem.
 *
 * No `catch`: a stale id (`product.error_param` + "Size chart id not exist…") and
 * every other failure reach the route unchanged — the route classifies.
 *
 * Pure orchestration over a client: no Firestore, no clock, no environment.
 */
import type { ShopeeClient } from '@delfrance/integrations-shopee';
import { type TabelaShopeeProjetada, projetarTabelaShopee } from '@delfrance/schemas';

/** Read template `sizeChartId` of this shop and project it. */
export async function lerTabelaDeMedidasShopee(
  ctx: { readonly client: ShopeeClient },
  sizeChartId: number,
): Promise<TabelaShopeeProjetada> {
  return projetarTabelaShopee(sizeChartId, await ctx.client.getSizeChartDetail({ sizeChartId }));
}
