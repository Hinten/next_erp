/**
 * `GET /api/marketplace/shopee/taxonomia/categorias?integracaoId=[&categoryId=]`
 *
 * The category picker's only endpoint: the ROOTS when no id is given, and ONE
 * focused node (with its ancestors and its direct children) when one is.
 *
 * ⚠️ **The whole tree never crosses this wire.** `get_category` answers ~10⁴
 * nodes in a single unpaged call, and the temptation is to forward it — one
 * request, done. It would be a multi-megabyte body on every keystroke of a
 * cascade, per operator, for a structure that answers three questions: what is
 * at the top, what is under this node, and how did we get here. The tree is
 * indexed once per cache window (`lerIndiceDeCategorias`) and this route serves
 * lookups over that index.
 *
 * ⚠️ An id the tree does not contain is a **404**, never 200-with-nothing. It
 * means a stale picker, another region's id, or a typo — and folding it into
 * "this node has children" would render identically to a perfectly valid
 * mid-tree category.
 *
 * Requires `PERM.integracao.read`. Reads only; writes nothing.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { lerIndiceDeCategorias, taxonomiaCtx } from '@/lib/shopee/taxonomia/cache';
import { raizes } from '@/lib/shopee/taxonomia/categorias';
import { projetarCategoria, projetarNoDeCategoria } from '@/lib/shopee/taxonomia/dto';
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

  try {
    const ctx = taxonomiaCtx(await loadShopeeContext(getAdminFirestore(), integracaoId.valor));
    const indice = await lerIndiceDeCategorias(ctx);

    const id = categoryId.valor;
    if (id === null) {
      return NextResponse.json({
        raizes: raizes(indice).map((row) => projetarCategoria(indice, row)),
        no: null,
      });
    }

    // A miss here IS `ehFolha`'s `desconhecida` — that verdict is defined as
    // "the id is not in `porId`" — so the 404 is stated once rather than tested
    // twice under two spellings.
    const row = indice.porId.get(id);
    if (row === undefined) {
      return NextResponse.json(
        {
          error: `Categoria ${String(id)} não existe na árvore desta conta.`,
          code: 'SHOPEE_CATEGORIA_DESCONHECIDA',
        },
        { status: 404 },
      );
    }

    return NextResponse.json({ raizes: null, no: projetarNoDeCategoria(indice, row) });
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}
