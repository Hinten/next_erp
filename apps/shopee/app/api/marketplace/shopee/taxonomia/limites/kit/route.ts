/**
 * `GET /api/marketplace/shopee/taxonomia/limites/kit?integracaoId=[&categoryId=]`
 *
 * The KIT bands — `get_kit_item_limit`.
 *
 * ⚠️ **Never derived from the item bands.** The two pages disagree field by
 * field: the description key differs and carries two extra fields, only the kit
 * declares `support_pre_order` and `component_count_limit_of_single_model`, and
 * even the shared band names carry different numbers. This route calls
 * `get_kit_item_limit` and nothing else — `get_item_limit` is never reached from
 * here, which its own test pins.
 *
 * ⚠️ **Leaf-gated, unlike the item bands**, even though `category_id` is
 * documented optional on both pages: the kit page's only error sample is
 * "should use leaf category". With no `categoryId` the read is shop-wide, there
 * is nothing to gate on, and `leaf` is `null` — the same three-valued honesty
 * the rest of the layer keeps.
 *
 * Requires `PERM.integracao.read`.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { lerIndiceDeCategorias, taxonomiaCtx } from '@/lib/shopee/taxonomia/cache';
import { ehFolha } from '@/lib/shopee/taxonomia/categorias';
import { lerLimitesDeKit } from '@/lib/shopee/taxonomia/limites';
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

    if (id !== null) {
      const veredicto = ehFolha(await lerIndiceDeCategorias(ctx), id);
      if (veredicto === 'desconhecida') {
        return NextResponse.json(
          {
            error: `Categoria ${String(id)} não existe na árvore desta conta.`,
            code: 'SHOPEE_CATEGORIA_DESCONHECIDA',
          },
          { status: 404 },
        );
      }
      if (veredicto === 'nao-folha') {
        return NextResponse.json({
          leaf: false,
          scope: 'category',
          categoryId: id,
          limites: null,
        });
      }
    }

    return NextResponse.json({
      // `null`, not `false`: with no category there was nothing to ask about.
      leaf: id === null ? null : true,
      scope: id === null ? 'shop' : 'category',
      categoryId: id,
      limites: await lerLimitesDeKit(ctx, id),
    });
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}
