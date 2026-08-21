/**
 * `GET /api/marketplace/mercado-livre/categorias?integracaoId=[&categoryId=]`
 *
 * One level of the ML category tree, for the listing editor's cascade picker.
 * Without `categoryId` it answers the roots (`GET /sites/MLB/categories`); with
 * one it answers that node plus its `path_from_root` and `children_categories`
 * (`GET /categories/{id}`), which is exactly the walk the legacy provider did
 * (`cadastroSlim.dart:42-83`).
 *
 * `isLeaf` is computed here rather than left to the client: ML serves no usable
 * listing types or attributes for a mid-tree node, and both sibling routes gate
 * on the same test.
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
  getCategoriasRaizCached,
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

  try {
    const ctx = await loadMercadoLivreContext(getAdminFirestore(), integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    if (!categoryId) {
      const roots = await getCategoriasRaizCached(api);
      return NextResponse.json({
        roots: roots.map((c) => ({ id: c.id, name: c.name ?? null })),
        node: null,
      });
    }

    const node = await getCategoriaCached(api, categoryId);
    return NextResponse.json({
      roots: null,
      node: {
        id: node.id,
        name: node.name ?? null,
        pathFromRoot: (node.path_from_root ?? []).map((c) => ({ id: c.id, name: c.name ?? null })),
        children: (node.children_categories ?? []).map((c) => ({ id: c.id, name: c.name ?? null })),
        isLeaf: isLeafCategory(node.children_categories),
        // The chart binding reads `settings.catalog_domain` (publish.ts:460).
        settings: node.settings ?? null,
      },
    });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
