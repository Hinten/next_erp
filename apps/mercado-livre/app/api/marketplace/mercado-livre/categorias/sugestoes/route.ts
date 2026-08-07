/**
 * `GET /api/marketplace/mercado-livre/categorias/sugestoes?integracaoId=&q=[&limit=]`
 *
 * ML's category suggestions for a product title
 * (`GET /sites/MLB/domain_discovery/search`). This route OFFERS them — it
 * writes nothing and picks nothing.
 *
 * That is the whole point of #799. Publish used to call
 * `suggestCategories(produto.nome, 1)` and apply `[0]` with no human in the
 * loop, so a wrong first hit only surfaced once the listing existed, in the
 * wrong category, on a live marketplace. The full ranked list comes back here
 * and a person chooses.
 *
 * Requires `PERM.integracao.read`.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { getSugestaoCategoriasCached } from '@/lib/marketplace/mlMetadataCache';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** ML's own picker shows a handful; more is noise and a bigger cache key space. */
const MAX_SUGESTOES = 8;
/** Below this a query is all noise — the legacy required a non-empty title. */
const MIN_QUERY_LENGTH = 2;

interface SugestaoWire {
  category_id: string;
  category_name?: string | null;
  domain_id?: string | null;
  domain_name?: string | null;
}

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = params.get('integracaoId');
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }
  const q = (params.get('q') ?? '').trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json(
      { error: `q deve ter ao menos ${MIN_QUERY_LENGTH} caracteres.` },
      { status: 400 },
    );
  }
  const rawLimit = Number(params.get('limit') ?? MAX_SUGESTOES);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_SUGESTOES)
    : MAX_SUGESTOES;

  try {
    const ctx = await loadMercadoLivreContext(getAdminFirestore(), integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const hits = (await getSugestaoCategoriasCached(api, q, limit)) as SugestaoWire[];
    return NextResponse.json({
      sugestoes: hits.map((h) => ({
        categoryId: h.category_id,
        categoryName: h.category_name ?? null,
        domainId: h.domain_id ?? null,
        domainName: h.domain_name ?? null,
      })),
    });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
