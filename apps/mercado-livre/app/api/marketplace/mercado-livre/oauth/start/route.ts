/**
 * `GET /api/marketplace/mercado-livre/oauth/start?integracaoId=…` — #291
 *
 * Mints the signed-state Mercado Livre consent URL for an `integracao`
 * account and returns it as JSON. The browser then navigates there. The
 * Bearer token (PERM.integracao.write) authorizes minting the state; the state
 * itself is the integrity guarantee the public callback verifies.
 *
 * #821: the state's `nonce` and (when PKCE is on) the `code_verifier` are also
 * recorded server-side, which is what lets the callback redeem the attempt
 * exactly once. Persist BEFORE handing out the URL — a consent completed
 * against a record that was never written is a connect that fails closed.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  codeChallengeS256,
  createCodeVerifier,
  signState,
} from '@delfrance/data/admin/oauth-state';

import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { mercadoLivreOauthState, pkceEnabled } from '@/lib/marketplace/oauthState';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';

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
    const { state, nonce } = signState(integracaoId, secret);
    const codeVerifier = pkceEnabled() ? createCodeVerifier() : null;
    await mercadoLivreOauthState.put(db, integracaoId, { nonce, codeVerifier });
    const authorizeUrl = ctx.channel.oauthFlow.start(
      state,
      codeVerifier
        ? { codeChallenge: codeChallengeS256(codeVerifier), codeChallengeMethod: 'S256' }
        : undefined,
    );
    return NextResponse.json({ authorizeUrl });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
