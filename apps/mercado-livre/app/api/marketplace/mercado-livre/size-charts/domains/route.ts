/**
 * `GET /api/marketplace/mercado-livre/size-charts/domains?integracaoId=` —
 * the chart-enabled ML domains (`active_domains`), enriched with their human
 * labels for the chart-cadastro domain picker. Server-side on purpose: the
 * active_domains endpoint rejects browser preflights (legacy note), so the
 * old app could never call it from the web — this route is the fix.
 * Requires `PERM.integracao.read`.
 */
import { NextResponse } from 'next/server';
import { MercadoLivreError, createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';

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

    const active = await api.getActiveChartDomains();
    const domains = await Promise.all(
      active.domains.map(async (d) => {
        try {
          const detail = await api.getCatalogDomain(d.domain_id);
          return { domain_id: d.domain_id, name: detail.name ?? null };
        } catch (err) {
          // A single unlabeled domain must not break the picker.
          if (err instanceof MercadoLivreError) return { domain_id: d.domain_id, name: null };
          throw err;
        }
      }),
    );
    return NextResponse.json({ domains });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
