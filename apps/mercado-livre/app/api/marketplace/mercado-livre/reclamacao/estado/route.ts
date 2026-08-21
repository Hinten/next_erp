/**
 * `GET /api/marketplace/mercado-livre/reclamacao/estado?integracaoId=&claimId=`
 * — the live state of one Mercado Livre claim (#364).
 *
 * ⚠️ **Live on every call, never cached.** `available_actions` is ML's answer to
 * "what may this seller do right now", derived from the claim's stage and status,
 * and it empties as the claim closes. A cached list would offer a refund button
 * for an action ML has already withdrawn.
 *
 * ⚠️ Gated on `PERM.incidenteResolucao.read` rather than `pedido.read`: this
 * reaches ML's API on the seller's account and returns buyer-visible claim
 * detail, so it is not free just because it is a GET.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { lerReclamacaoMercadoLivre } from '@/lib/marketplace/claimResolve';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.incidenteResolucao.read);
  if ('error' in auth) return auth.error;

  const url = new URL(req.url);
  const integracaoId = (url.searchParams.get('integracaoId') ?? '').trim();
  const claimIdRaw = (url.searchParams.get('claimId') ?? '').trim();
  const claimId = Number(claimIdRaw);
  if (integracaoId === '' || claimIdRaw === '' || !Number.isSafeInteger(claimId) || claimId <= 0) {
    return NextResponse.json(
      {
        error: 'integracaoId e um claimId numérico são obrigatórios.',
        code: 'ML_QUERY_INVALIDA',
      },
      { status: 400 },
    );
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    return NextResponse.json(await lerReclamacaoMercadoLivre({ api }, { claimId }));
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
