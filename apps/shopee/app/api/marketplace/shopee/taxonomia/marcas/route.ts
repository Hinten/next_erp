/**
 * `GET /api/marketplace/shopee/taxonomia/marcas?integracaoId=&categoryId=[&offset=&pageSize=&status=]`
 *
 * ONE page of a leaf category's brands, straight from Shopee.
 *
 * ⚠️ **This route does not feed the produto's brand dropdown.** That dropdown
 * reads `integracao/{id}/brandshopee` — the operator-curated shortlist — because
 * Shopee's brand API is extremely slow. This route serves the REGISTRATION
 * picker where an operator adds a brand to that shortlist, and step 10 writes
 * nothing: the shortlist is maintained from the conta screen (step 21) and
 * re-validated at publish (step 11).
 *
 * ⚠️ **No paging loop.** One page per request, `nextOffset` echoed verbatim, and
 * the caller decides whether to ask for another. `next_offset` is Shopee's own
 * cursor and is NOT `offset + pageSize`.
 *
 * ⚠️ Leaf-gated (guide 209 §3), so a mid-tree id answers an EMPTY page with zero
 * `get_brand_list` calls rather than an error — the gate itself still reads the
 * category tree, one `get_category` on a cold cache window and none on a warm
 * one. `brand_id: 0` ("No Brand") comes back as the value it is on the pages
 * that do have brands.
 *
 * Requires `PERM.integracao.read`.
 */
import { NextResponse } from 'next/server';
import { SHOPEE_BRAND_MAX_PAGE_SIZE, SHOPEE_BRAND_STATUS } from '@delfrance/integrations-shopee';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { lerIndiceDeCategorias, taxonomiaCtx } from '@/lib/shopee/taxonomia/cache';
import { ehFolha } from '@/lib/shopee/taxonomia/categorias';
import { lerPaginaDeMarcas, paginaDeMarcasVazia } from '@/lib/shopee/taxonomia/marcas';
import {
  lerCategoryIdObrigatorio,
  lerInteiro,
  lerIntegracaoId,
} from '@/lib/shopee/taxonomia/params';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `status` is an ENUMERATION, not a range, so it carries its own message — a
 * derived "deve estar entre 1 e 2" would be true and useless. The bounds and the
 * sentence live here, next to `SHOPEE_BRAND_STATUS`, because this is the only
 * route that reads the parameter.
 */
const MENSAGEM_STATUS = 'status deve ser 1 (normal) ou 2 (pendente).';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = lerIntegracaoId(params);
  if (!integracaoId.ok) return NextResponse.json({ error: integracaoId.erro }, { status: 400 });
  const categoryId = lerCategoryIdObrigatorio(params);
  if (!categoryId.ok) return NextResponse.json({ error: categoryId.erro }, { status: 400 });
  const offset = lerInteiro(params, 'offset', { min: 0, padrao: 0 });
  if (!offset.ok) return NextResponse.json({ error: offset.erro }, { status: 400 });
  const pageSize = lerInteiro(params, 'pageSize', {
    min: 1,
    max: SHOPEE_BRAND_MAX_PAGE_SIZE,
    padrao: SHOPEE_BRAND_MAX_PAGE_SIZE,
  });
  if (!pageSize.ok) return NextResponse.json({ error: pageSize.erro }, { status: 400 });
  const status = lerInteiro(params, 'status', {
    min: SHOPEE_BRAND_STATUS.normal,
    max: SHOPEE_BRAND_STATUS.pending,
    padrao: SHOPEE_BRAND_STATUS.normal,
    mensagem: MENSAGEM_STATUS,
  });
  if (!status.ok) return NextResponse.json({ error: status.erro }, { status: 400 });

  const pedido = {
    categoryId: categoryId.valor,
    offset: offset.valor,
    pageSize: pageSize.valor,
    status: status.valor,
  };

  try {
    const ctx = taxonomiaCtx(await loadShopeeContext(getAdminFirestore(), integracaoId.valor));
    const veredicto = ehFolha(await lerIndiceDeCategorias(ctx), pedido.categoryId);

    if (veredicto === 'desconhecida') {
      return NextResponse.json(
        {
          error: `Categoria ${String(pedido.categoryId)} não existe na árvore desta conta.`,
          code: 'SHOPEE_CATEGORIA_DESCONHECIDA',
        },
        { status: 404 },
      );
    }
    if (veredicto === 'nao-folha') {
      return NextResponse.json({ leaf: false, ...paginaDeMarcasVazia(pedido) });
    }

    return NextResponse.json({ leaf: true, ...(await lerPaginaDeMarcas(ctx, pedido)) });
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}
