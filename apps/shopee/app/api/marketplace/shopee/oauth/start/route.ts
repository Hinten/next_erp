/**
 * `GET /api/marketplace/shopee/oauth/start?integracaoId=…`
 *
 * Mints the signed-state Shopee consent URL for an `integracao` account and
 * returns it as JSON; the browser then navigates there. The Bearer token
 * (`PERM.integracao.write`) authorizes MINTING the state; the state itself is
 * the integrity guarantee the public callback verifies.
 *
 * ⚠️ An "ERP System" Shopee app has no console "Authorize" button, so this route
 * is the only way to reach the consent page — including in local dev, where
 * `scripts/oauth-url.ts` reproduces it without the web UI.
 *
 * ⚠️ The attempt record is persisted BEFORE the URL is handed out (#821). A
 * consent completed against a record that was never written is a connect that
 * fails closed, which is the direction that costs a re-consent instead of a
 * silently unredeemable state.
 *
 * ⚠️ No PKCE: Shopee documents no `code_challenge`, so the stored `codeVerifier`
 * is permanently `null` — see `lib/shopee/conta/oauthState.ts`.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { signState } from '@delfrance/data/admin/oauth-state';
import { buildAuthorizeUrl } from '@delfrance/integrations-shopee';

import { shopeeStateSecret } from '@/lib/shopee/env';
import { shopeeOauthState } from '@/lib/shopee/conta/oauthState';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const integracaoId = new URL(req.url).searchParams.get('integracaoId');
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }

  const secret = shopeeStateSecret();
  if (secret === null) {
    return NextResponse.json({ error: 'SHOPEE_STATE_SECRET não configurado.' }, { status: 500 });
  }

  const db = getAdminFirestore();
  try {
    // Called for its GUARDS: it refuses an integração that does not exist or is
    // not a Shopee conta, and surfaces a missing partner id/key as a 500 HERE
    // rather than as an `error_sign` at Shopee — both before any state is
    // minted and before anything is written.
    const ctx = await loadShopeeContext(db, integracaoId);

    const { state, nonce } = signState(integracaoId, secret);
    await shopeeOauthState.put(db, integracaoId, { nonce, codeVerifier: null });

    const authorizeUrl = buildAuthorizeUrl({
      partnerId: ctx.config.partnerId,
      redirectUri: ctx.config.redirectUri,
      state,
      hosts: ctx.config.hosts,
    });
    return NextResponse.json({ authorizeUrl });
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}
