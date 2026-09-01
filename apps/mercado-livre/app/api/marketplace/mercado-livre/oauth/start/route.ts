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

import { buildAuthorizeUrl } from '@delfrance/integrations-mercado-livre';

import {
  loadMercadoLivreContext,
  mercadoLivreOAuthConfig,
} from '@/lib/marketplace/core/mercadoLivre';
import { mercadoLivreOauthState, pkceEnabled } from '@/lib/marketplace/conta/oauthState';
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
    // Called for its GUARDS, not its value: it refuses an integração that does
    // not exist or is not a Mercado Livre conta, before any state is minted.
    await loadMercadoLivreContext(db, integracaoId);

    const { clientId, redirectUri } = mercadoLivreOAuthConfig();
    const { state, nonce } = signState(integracaoId, secret);
    const codeVerifier = pkceEnabled() ? createCodeVerifier() : null;
    await mercadoLivreOauthState.put(db, integracaoId, { nonce, codeVerifier });

    // ⚠️ This used to go through `ctx.channel.oauthFlow.start(...)` and was the
    // ONLY production call into the `MarketplaceChannel` contract, repo-wide. The
    // channel object added one indirection over `buildAuthorizeUrl` and nothing
    // else, which is why #815 deleted it. Deciding whether PKCE is in play still
    // belongs here, next to the flag and the store that holds the verifier.
    const authorizeUrl = buildAuthorizeUrl({
      clientId,
      redirectUri,
      state,
      ...(codeVerifier
        ? { codeChallenge: codeChallengeS256(codeVerifier), codeChallengeMethod: 'S256' as const }
        : {}),
    });
    return NextResponse.json({ authorizeUrl });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
