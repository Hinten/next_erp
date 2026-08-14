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
  PROFUNDIDADE_MAX_CATEGORIA_TESTE,
  TITULO_ANUNCIO_TESTE,
  encontrarCategoriaTeste,
  escolherDescendenteTeste,
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
    const raiz = encontrarCategoriaTeste(raizes);

    // ⚠️ **Descend to a LEAF.** Only a leaf can be published into, and ML's
    // "Outros" is a root WITH children — so the previous "root must itself be a
    // leaf" test failed every time, the route always answered `categoryId: null`,
    // and the form's null-guard skipped the write. The operator watched the title
    // change while the category and the whole attribute grid sat still.
    //
    // Walking is the fix, not a hardcoded id: `escolherDescendenteTeste` prefers a
    // child also named "Outros" and otherwise takes the first, so the listing
    // lands inside the category ML's own documentation asks test listings to use.
    // The resolved path rides back so the operator can see the choice and change it.
    //
    // The listing type is a per-CATEGORY answer, so it is only queried once a leaf
    // is in hand. No leaf ⇒ no type either, and the operator picks both.
    let listingTypeId: string | null = null;
    let categoryId: string | null = null;
    let categoriaPath: string[] | null = null;
    // ⚠️ WHY there is no category, not just that there isn't one. The two causes
    // need different actions from the operator — "ML has no Outros root on this
    // site" is nothing they can fix, while "no leaf beneath it" means picking a
    // subcategory — and a single "não foi possível" message sent them hunting.
    let categoriaMotivo: 'sem-raiz' | 'sem-folha' | null = null;

    if (raiz == null) categoriaMotivo = 'sem-raiz';

    if (raiz != null) {
      const trilha: string[] = [];
      let atual: string | null = raiz;
      // Bounded: each hop is one `GET /categories/{id}`. The cache is global —
      // ML category metadata is not per-seller — so repeat clicks are free.
      for (let i = 0; atual != null && i < PROFUNDIDADE_MAX_CATEGORIA_TESTE; i += 1) {
        const node = await getCategoriaCached(api, atual);
        trilha.push(node.name ?? atual);
        if (isLeafCategory(node.children_categories)) {
          categoryId = atual;
          categoriaPath = trilha;
          listingTypeId = escolherTipoAnuncioTeste(await getListingTypesCached(api, atual));
          break;
        }
        atual = escolherDescendenteTeste(node.children_categories ?? []);
      }
      if (categoryId == null) categoriaMotivo = 'sem-folha';
    }

    return NextResponse.json({
      title: TITULO_ANUNCIO_TESTE,
      descricao: DESCRICAO_ANUNCIO_TESTE,
      categoryId,
      categoriaPath,
      categoriaMotivo,
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
