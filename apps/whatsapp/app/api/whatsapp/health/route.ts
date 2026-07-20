/**
 * `GET /api/whatsapp/health?integracaoId=…` — the account-health surface behind
 * the "Saúde da conta" card (apps/web). Requires PERM.integracao.read.
 *
 * Thin: delegates to the `buildWhatsappHealth` aggregator (`lib/whatsapp/health.ts`),
 * which folds the token / phone-status / quality / verification / webhook /
 * inbound probes into a fixed list of check rows plus the `canSend` / `canReceive`
 * verdicts. Every probe failure is a check row, so this route answers 200 with
 * the aggregation; only a missing / non-WhatsApp account (a genuine 404) or an
 * unrelated failure leaves the aggregator via the shared error mapper.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { buildWhatsappHealth } from '@/lib/whatsapp/health';
import { isWhatsappError, whatsappErrorResponse } from '@/lib/whatsapp/respond';

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
    const health = await buildWhatsappHealth(db, integracaoId);
    return NextResponse.json(health);
  } catch (err) {
    if (isWhatsappError(err)) return whatsappErrorResponse(err);
    throw err;
  }
}
