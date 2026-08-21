/**
 * `GET /api/marketplace/mercado-livre/categorias/atributos?integracaoId=&categoryId=[&escopo=]`
 *
 * The per-category attribute definitions the listing editor renders, already
 * filtered and normalised (`projectCategoriaAtributos`).
 *
 * This closes the gap #799 names as the reason a produto the Flutter app never
 * touched cannot be published at all: `link.attributes` stays null, most ML
 * categories reject the POST with `item.attributes.required`, and the operator
 * has no field in which to fix it. `api.getCategoryAttributes` has existed and
 * been wrapped all along — this route is its first caller.
 *
 * `escopo=variacao` returns the attributes that belong on a variation instead
 * of the item, which is a different filter, not a subset.
 *
 * Read-only, cached (`mlMetadataCache`). Requires `PERM.integracao.read`.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  type MlAttributeScope,
  isLeafCategory,
  projectCategoriaAtributos,
} from '@/lib/marketplace/categorias/categoriaAtributos';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import {
  getCategoriaAtributosCached,
  getCategoriaCached,
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
  const rawEscopo = params.get('escopo') ?? 'item';
  if (rawEscopo !== 'item' && rawEscopo !== 'variacao') {
    return NextResponse.json({ error: "escopo deve ser 'item' ou 'variacao'." }, { status: 400 });
  }
  const escopo: MlAttributeScope = rawEscopo;

  try {
    const ctx = await loadMercadoLivreContext(getAdminFirestore(), integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    // A mid-tree category has no listing metadata — short-circuit BEFORE the
    // expensive attributes call (the legacy gate, `cadastroSlim.dart:114-116`).
    const node = await getCategoriaCached(api, categoryId);
    if (!isLeafCategory(node.children_categories)) {
      return NextResponse.json({ leaf: false, atributos: [], omitidos: [] });
    }

    const attrs = await getCategoriaAtributosCached(api, categoryId);
    return NextResponse.json({ leaf: true, ...projectCategoriaAtributos(attrs, escopo) });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
