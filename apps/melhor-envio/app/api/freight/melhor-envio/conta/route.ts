/**
 * `GET /api/freight/melhor-envio/conta?intFreteId=…`
 *
 * Connection status for a Melhor Envio account: `/me` + `/balance` when a
 * valid token exists. A dead/absent token is **not** an error here — the
 * whole point is to show a disconnected state — so it returns
 * `{ connected: false }` instead of 409. Requires PERM.frete.read.
 */
import { NextResponse } from 'next/server';
import { MelhorEnvioReauthRequiredError } from '@delfrance/integrations-freight-br';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMelhorEnvioContext } from '@/lib/freight/melhorEnvio';
import { isMelhorEnvioError, melhorEnvioErrorResponse } from '@/lib/freight/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.frete.read);
  if ('error' in auth) return auth.error;

  const intFreteId = new URL(req.url).searchParams.get('intFreteId');
  if (!intFreteId) {
    return NextResponse.json({ error: 'intFreteId é obrigatório.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMelhorEnvioContext(db, intFreteId);
    const [me, balance] = await Promise.all([ctx.api.getMe(), ctx.api.getBalance()]);
    return NextResponse.json({ connected: true, me, balance });
  } catch (err) {
    // A missing/expired token is the "not connected" state, not a failure.
    if (err instanceof MelhorEnvioReauthRequiredError) {
      return NextResponse.json({ connected: false, me: null, balance: null });
    }
    if (isMelhorEnvioError(err)) return melhorEnvioErrorResponse(err);
    throw err;
  }
}
