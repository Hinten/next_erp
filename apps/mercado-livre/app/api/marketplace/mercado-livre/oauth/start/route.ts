/**
 * `GET /api/marketplace/mercado-livre/oauth/start?integracaoId=…` — #291
 *
 * Mints the signed-state Mercado Livre consent URL for an `integracao`
 * account and returns it as JSON. The browser then navigates there. The
 * Bearer token (PERM.integracao.write) authorizes minting the state; the state
 * itself is the integrity guarantee the public callback verifies.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { signState } from '@/lib/marketplace/core/state';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const integracaoId = new URL(req.url).searchParams.get('integracaoId');
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }

  const secret = process.env.MERCADO_LIVRE_STATE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'MERCADO_LIVRE_STATE_SECRET não configurado.' },
      { status: 500 },
    );
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const state = signState(integracaoId, secret);
    const authorizeUrl = ctx.channel.oauthFlow.start(state);
    return NextResponse.json({ authorizeUrl });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
