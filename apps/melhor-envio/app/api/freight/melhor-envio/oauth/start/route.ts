/**
 * `GET /api/freight/melhor-envio/oauth/start?intFreteId=…`
 *
 * Mints the signed-state Melhor Envio consent URL for an int_frete
 * account and returns it as JSON. The browser then navigates there. The
 * Bearer token (PERM.frete.write) authorizes minting the state; the state
 * itself is the integrity guarantee the public callback verifies.
 */
import { NextResponse } from 'next/server';
import { buildAuthorizeUrl } from '@delfrance/integrations-freight-br';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMelhorEnvioContext } from '@/lib/freight/melhorEnvio';
import { signState } from '@/lib/freight/state';
import { isMelhorEnvioError, melhorEnvioErrorResponse } from '@/lib/freight/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.frete.write);
  if ('error' in auth) return auth.error;

  const intFreteId = new URL(req.url).searchParams.get('intFreteId');
  if (!intFreteId) {
    return NextResponse.json({ error: 'intFreteId é obrigatório.' }, { status: 400 });
  }

  const secret = process.env.MELHOR_ENVIO_STATE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'MELHOR_ENVIO_STATE_SECRET não configurado.' },
      { status: 500 },
    );
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMelhorEnvioContext(db, intFreteId);
    const state = signState(intFreteId, secret);
    const authorizeUrl = buildAuthorizeUrl({
      baseUrl: ctx.oauthConfig.baseUrl,
      clientId: ctx.oauthConfig.clientId,
      redirectUri: ctx.oauthConfig.redirectUri,
      state,
    });
    return NextResponse.json({ authorizeUrl });
  } catch (err) {
    if (isMelhorEnvioError(err)) return melhorEnvioErrorResponse(err);
    throw err;
  }
}
