/**
 * `GET /api/marketplace/shopee/taxonomia/recomendacao-categoria?integracaoId=&nome=[&imagemCapa=]`
 *
 * The categories Shopee suggests for a product name — OFFERED, never applied.
 *
 * ⚠️ `applied: false` is on the body as a contract, not as decoration. #799 is
 * the reason: the Mercado Livre publish path used to call
 * `suggestCategories(nome, 1)` and apply `[0]` with no human in the loop, so a
 * wrong first hit only surfaced once the listing existed, in the wrong category,
 * on a live marketplace. This route writes nothing and picks nothing; a person
 * chooses from the full list.
 *
 * ⚠️ Each row is decorated from the CACHED tree, and the two failure directions
 * are deliberately opposite: an id absent from the tree degrades that ROW (and
 * is counted in `unresolved`), while the tree read itself failing SURFACES —
 * it is the read every other taxonomy route depends on.
 *
 * ⚠️ `imagemCapa` is Shopee's `product_cover_image`, which is an **image id**
 * from `v2.media_space.upload_image` — never a URL.
 *
 * Requires `PERM.integracao.read`.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { taxonomiaCtx } from '@/lib/shopee/taxonomia/cache';
import {
  lerIntegracaoId,
  lerTextoObrigatorio,
  lerTextoOpcional,
} from '@/lib/shopee/taxonomia/params';
import { lerRecomendacaoDeCategoria } from '@/lib/shopee/taxonomia/recomendacao';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = lerIntegracaoId(params);
  if (!integracaoId.ok) return NextResponse.json({ error: integracaoId.erro }, { status: 400 });
  const nome = lerTextoObrigatorio(params, 'nome');
  if (!nome.ok) return NextResponse.json({ error: nome.erro }, { status: 400 });
  const imagemCapa = lerTextoOpcional(params, 'imagemCapa');
  if (!imagemCapa.ok) return NextResponse.json({ error: imagemCapa.erro }, { status: 400 });

  try {
    const ctx = taxonomiaCtx(await loadShopeeContext(getAdminFirestore(), integracaoId.valor));
    const lida = await lerRecomendacaoDeCategoria(ctx, nome.valor, imagemCapa.valor);

    return NextResponse.json({
      recomendacoes: lida.recomendacoes,
      unresolved: lida.unresolved,
      // A constant, and it stays one: this endpoint offers.
      applied: false,
    });
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}
