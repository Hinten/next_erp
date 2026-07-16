/**
 * `GET /api/whatsapp/conta?integracaoId=…`
 *
 * Connection status for a WhatsApp account: a live Graph phone-number lookup
 * when a permanent token is stored. A missing or dead/expired token is **not**
 * an error here — the whole point is to render the disconnected state — so it
 * returns `{ connected: false }` instead of 409. Requires PERM.integracao.read.
 * Mirrors apps/mercado-pago's `conta` route (`/users/me` → the Graph number
 * probe). The token itself is never returned.
 *
 * Every response carries `hasToken: boolean` so the panel can tell "no
 * credential yet" from "credential stored but not live" (dead/expired token, or
 * número not yet filled in). The states:
 *   - no credential            → `{ connected: false, hasToken: false, phone: null }`
 *   - token but no phoneNumberId → `{ connected: false, hasToken: true, phone: null,
 *                                     reason: 'numero_nao_configurado' }` (the
 *     first-connect flow: the operator saves the token before the número — a
 *     degraded 200, NOT a 404)
 *   - token but Graph rejects it → `{ connected: false, hasToken: true, phone: null }`
 *   - live                       → `{ connected: true, hasToken: true, phone: {…} }`
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  WhatsappTokenInvalidError,
  WhatsappTokenMissingError,
  fetchWhatsappPhoneNumber,
  loadWhatsappContext,
} from '@/lib/whatsapp/whatsapp';
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
    const ctx = await loadWhatsappContext(db, integracaoId);
    if (!(await ctx.hasToken())) {
      return NextResponse.json({ connected: false, hasToken: false, phone: null });
    }
    // Token stored but the número was never filled in — the first-connect flow
    // (operator saves the token before the número). Degraded, not an error: a
    // 200 the panel turns into a "fill in the número" hint, not a 404.
    if (!ctx.conta.phoneNumberId) {
      return NextResponse.json({
        connected: false,
        hasToken: true,
        phone: null,
        reason: 'numero_nao_configurado',
      });
    }
    const token = await ctx.resolveToken();
    const phone = await fetchWhatsappPhoneNumber(ctx.phoneNumberId(), token);
    return NextResponse.json({ connected: true, hasToken: true, phone });
  } catch (err) {
    // A dead/expired token is the "not connected" state, not a failure —
    // reaching here past the hasToken() guard means a credential is stored.
    if (err instanceof WhatsappTokenMissingError || err instanceof WhatsappTokenInvalidError) {
      return NextResponse.json({ connected: false, hasToken: true, phone: null });
    }
    if (isWhatsappError(err)) return whatsappErrorResponse(err);
    throw err;
  }
}
