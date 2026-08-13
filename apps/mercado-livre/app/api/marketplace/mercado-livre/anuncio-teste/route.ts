/**
 * `GET /api/marketplace/mercado-livre/anuncio-teste?integracaoId=…`
 *
 * The data a **test listing** must carry, per Mercado Livre's own "Realização de
 * testes" page — resolved against the live catalogue rather than hardcoded, and
 * returned for the operator to APPLY to the form. This route publishes nothing.
 *
 * ⚠️ ML has no sandbox: «O Mercado Livre não tem um ambiente para teste ou
 * sandbox». A test listing is a real listing on production, which is why this
 * also reports whether the target account is one of ML's test users — «contas
 * pessoais ou de familiares não devem ser, em hipótese alguma, utilizadas para
 * testes». The UI warns on that; it does not block, because the decision is the
 * operator's.
 *
 * Requires `PERM.integracao.read` — it reads catalogue metadata and account
 * identity, and writes nothing.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import {
  DESCRICAO_ANUNCIO_TESTE,
  TITULO_ANUNCIO_TESTE,
  encontrarCategoriaTeste,
  escolherTipoAnuncioTeste,
  isContaDeTeste,
} from '@/lib/marketplace/anuncioTeste';
import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { isLeafCategory } from '@/lib/marketplace/categoriaAtributos';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import {
  getCategoriaCached,
  getCategoriasRaizCached,
  getListingTypesCached,
} from '@/lib/marketplace/mlMetadataCache';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const integracaoId = new URL(req.url).searchParams.get('integracaoId');
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }

  try {
    const ctx = await loadMercadoLivreContext(getAdminFirestore(), integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const [raizes, me] = await Promise.all([getCategoriasRaizCached(api), api.getMe()]);
    const encontrada = encontrarCategoriaTeste(raizes);

    // The listing type is a per-CATEGORY answer, so it can only be resolved once
    // a category is. No usable "Outros" ⇒ no type either, and the operator picks both.
    //
    // ⚠️ A mid-tree "Outros" is reported as NO category, not as a category with
    // no types. Only a leaf can be published into, so handing the form a
    // mid-tree `category_id` would write a value publish must reject while the
    // UI blamed the listing types — the failure would point at the wrong field.
    // "Outros" is a leaf on MLB today, but that is ML's to change.
    let listingTypeId: string | null = null;
    let categoryId: string | null = null;
    if (encontrada != null) {
      const node = await getCategoriaCached(api, encontrada);
      if (isLeafCategory(node.children_categories)) {
        categoryId = encontrada;
        listingTypeId = escolherTipoAnuncioTeste(await getListingTypesCached(api, encontrada));
      }
    }

    return NextResponse.json({
      title: TITULO_ANUNCIO_TESTE,
      descricao: DESCRICAO_ANUNCIO_TESTE,
      categoryId,
      listingTypeId,
      conta: {
        nickname: me.nickname ?? null,
        /**
         * False ⇒ the UI warns that ML forbids test listings on a real seller
         * account, and names the compliant path (connect a test user as a second
         * conta — this ERP already supports several).
         */
        ehContaDeTeste: isContaDeTeste(me.nickname),
      },
    });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
