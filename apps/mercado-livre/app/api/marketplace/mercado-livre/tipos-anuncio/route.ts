/**
 * `GET /api/marketplace/mercado-livre/tipos-anuncio?integracaoId=&categoryId=`
 *
 * The listing types ML offers for a LEAF category
 * (`GET /categories/{id}/listing_types`).
 *
 * Replaces the two hard-coded options the produto tab shipped
 * (`MercadoLivreManager.tsx:69-72`: `gold_special` / `gold_pro`). Which types
 * exist is a per-category answer — the legacy read it per category too
 * (`cadastroSlim.dart:86-102`) — so a hard-coded pair is wrong for any category
 * that offers more or fewer, and there is no way for an operator to tell.
 *
 * Read-only, cached (`mlMetadataCache`). Requires `PERM.integracao.read`.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { isLeafCategory } from '@/lib/marketplace/categorias/categoriaAtributos';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import {
  getCategoriaCached,
  getListingTypesCached,
} from '@/lib/marketplace/categorias/mlMetadataCache';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = params.get('integracaoId');
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }
  const categoryId = params.get('categoryId');
  if (!categoryId) {
    return NextResponse.json({ error: 'categoryId é obrigatório.' }, { status: 400 });
  }

  try {
    const ctx = await loadMercadoLivreContext(getAdminFirestore(), integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    // Same leaf gate as the attributes route — ML has nothing for a mid-tree
    // node, and the legacy early-returned `[]` rather than calling
    // (`cadastroSlim.dart:96`).
    const node = await getCategoriaCached(api, categoryId);
    if (!isLeafCategory(node.children_categories)) {
      return NextResponse.json({ leaf: false, tipos: [] });
    }

    const tipos = await getListingTypesCached(api, categoryId);
    return NextResponse.json({
      leaf: true,
      tipos: tipos.map((t) => ({ id: t.id, name: t.name ?? null })),
    });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
