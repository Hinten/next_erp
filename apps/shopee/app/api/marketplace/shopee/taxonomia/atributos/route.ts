/**
 * `GET /api/marketplace/shopee/taxonomia/atributos?integracaoId=&categoryId=`
 *
 * The attribute definitions a listing in this category must satisfy: which are
 * mandatory, what type of input each takes, and which values are selectable.
 *
 * ⚠️ **Leaf-gated.** `get_attribute_tree` documents leaf ids; a mid-tree
 * category answers with something useless or an error. A non-leaf id therefore
 * gets `leaf: false` with an empty list at HTTP 200 and **zero provider calls** —
 * the same short-circuit `apps/mercado-livre`'s attributes route makes, and the
 * legacy Flutter app made before it. An id that is not in the tree at all is a
 * 404 instead: see the categorias route.
 *
 * ⚠️ The `warning` on the body is Shopee's **per-category** warning, which has
 * nothing to do with the envelope's — the envelope's goes to the transport's
 * `onWarning`. Its noise values (`''`, `'success'`) are filtered by EXACT
 * equality in `avisoDeShopee`, so a healthy read carries `warning: null`.
 *
 * Requires `PERM.integracao.read`.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { lerAtributos } from '@/lib/shopee/taxonomia/atributos';
import { lerIndiceDeCategorias, taxonomiaCtx } from '@/lib/shopee/taxonomia/cache';
import { ehFolha } from '@/lib/shopee/taxonomia/categorias';
import { projetarAtributos } from '@/lib/shopee/taxonomia/dto';
import { lerCategoryIdObrigatorio, lerIntegracaoId } from '@/lib/shopee/taxonomia/params';

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
        warning: null,
        truncated: false,
        atributos: [],
      });
    }

    const lido = await lerAtributos(ctx, id);
    const { atributos, truncated } = projetarAtributos(lido.atributos);
    return NextResponse.json({
      leaf: true,
      categoryId: lido.categoryId,
      warning: lido.warning,
      truncated,
      atributos,
    });
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}
