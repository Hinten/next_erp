/**
 * `GET /api/marketplace/shopee/taxonomia/limites?integracaoId=[&categoryId=]`
 *
 * The ITEM bands: price and stock ranges, name/description/image limits, the
 * days-to-ship window, whether weight and dimensions are mandatory, the
 * size-chart flags and the GTIN rule.
 *
 * ⚠️ **No leaf gate here, unlike every other taxonomy route.** `category_id` is
 * documented OPTIONAL on `get_item_limit`, and its absence is a real read: the
 * shop-wide bands. `scope` says which answer this is, and the cache keys `null`
 * distinctly from every id, so the shop-wide answer can never be served for a
 * category or the other way round.
 *
 * ⚠️ **A provider failure SURFACES** (502 through `shopeeErrorResponse`); this
 * route never answers `limites: null`. Step 11 composes a publish payload from
 * these numbers, and a `null` here would leave it choosing between stopping and
 * falling back to hardcoded values — and every number on Shopee's page is a
 * SAMPLE, per shop and per category (guide 209 §6).
 *
 * Requires `PERM.integracao.read`.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { taxonomiaCtx } from '@/lib/shopee/taxonomia/cache';
import { lerLimitesDeItem } from '@/lib/shopee/taxonomia/limites';
import { lerCategoryIdOpcional, lerIntegracaoId } from '@/lib/shopee/taxonomia/params';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = lerIntegracaoId(params);
  if (!integracaoId.ok) return NextResponse.json({ error: integracaoId.erro }, { status: 400 });
  const categoryId = lerCategoryIdOpcional(params);
  if (!categoryId.ok) return NextResponse.json({ error: categoryId.erro }, { status: 400 });

  const id = categoryId.valor;
  try {
    const ctx = taxonomiaCtx(await loadShopeeContext(getAdminFirestore(), integracaoId.valor));
    const { limites, gtinLimit, supportsPreOrder } = await lerLimitesDeItem(ctx, id);

    return NextResponse.json({
      scope: id === null ? 'shop' : 'category',
      categoryId: id,
      ...limites,
      gtinLimit,
      // ⚠️ DERIVED from the `-1` sentinel on `days_to_ship_limit` (guide 209 §4),
      // and NOT Shopee's `support_pre_order` — that boolean is declared on the
      // KIT page only. The raw band travels on `dtsLimit` untouched, so a caller
      // can see the `-1` for itself.
      supportsPreOrder,
    });
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}
