/**
 * `GET /api/marketplace/shopee/taxonomia/variacoes?integracaoId=&categoryId=`
 *
 * Shopee's STANDARDISED variation tree for a leaf category: variation → group →
 * option (Cor → grupo → "Azul-marinho").
 *
 * ⚠️ **`pathUsed` is on the body on purpose.** `get_variations` is the operation
 * whose own page contradicts itself — its `path`, `url` and `test_url` say
 * `/api/v2/product/get_variation_tree`, while all four of its samples call
 * `/api/v2/product/get_variations`. The path is INSIDE the HMAC base string, so
 * the wrong one comes back as `error_sign`, which reads exactly like a bad
 * partner key and points nowhere near here. Echoing the path this call actually
 * signed is what turns one sandbox call into an answer, and flipping it is an
 * env var (`SHOPEE_VARIATIONS_PATH`), not a redeploy.
 *
 * ⚠️ Leaf-gated: a mid-tree id answers an empty list with zero `get_variations`
 * calls. The gate itself still reads the category tree — one `get_category` on
 * a cold cache window, none on a warm one.
 * ⚠️ `variation_option_id: 0` is an observed CUSTOM option — a value, not an
 * absence — and it reaches this body intact.
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
import { lerCategoryIdObrigatorio, lerIntegracaoId } from '@/lib/shopee/taxonomia/params';
import { lerVariacoes } from '@/lib/shopee/taxonomia/variacoes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = lerIntegracaoId(params);
  if (!integracaoId.ok) return NextResponse.json({ error: integracaoId.erro }, { status: 400 });
  const categoryId = lerCategoryIdObrigatorio(params);
  if (!categoryId.ok) return NextResponse.json({ error: categoryId.erro }, { status: 400 });

  const id = categoryId.valor;
  try {
    const ctx = taxonomiaCtx(await loadShopeeContext(getAdminFirestore(), integracaoId.valor));
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
        categoryId: id,
        standardiseVariationList: [],
        pathUsed: ctx.variationsPath,
      });
    }

    const lidas = await lerVariacoes(ctx, id);
    return NextResponse.json({
      leaf: true,
      categoryId: lidas.categoryId,
      standardiseVariationList: lidas.standardiseVariationList,
      pathUsed: ctx.variationsPath,
    });
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}
