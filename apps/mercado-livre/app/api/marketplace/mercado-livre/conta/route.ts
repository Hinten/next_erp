/**
 * `GET /api/marketplace/mercado-livre/conta?integracaoId=…`
 *
 * Connection status for a Mercado Livre account: `/users/me` when a valid (or
 * refreshable) token exists. A dead/absent token is **not** an error here —
 * the whole point is to render the disconnected state — so it returns
 * `{ connected: false }` instead of 409. Requires PERM.integracao.read.
 * Mirrors apps/melhor-envio's `conta` route.
 */
import { NextResponse } from 'next/server';
import {
  MercadoLivreReauthRequiredError,
  createMercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const integracaoId = new URL(req.url).searchParams.get('integracaoId');
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
    const me = await api.getMe();
    return NextResponse.json({
      connected: true,
      me: { id: me.id, nickname: me.nickname ?? null, email: me.email ?? null },
    });
  } catch (err) {
    // A missing/expired credential is the "not connected" state, not a failure.
    if (err instanceof MercadoLivreReauthRequiredError) {
      return NextResponse.json({ connected: false, me: null });
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
