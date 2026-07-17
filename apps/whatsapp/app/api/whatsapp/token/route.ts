/**
 * `POST /api/whatsapp/token`   — store an account's permanent token.
 * `DELETE /api/whatsapp/token` — revoke (disconnect) it.
 *
 * Both require PERM.integracao.write. The permanent token is a long-lived Meta
 * Graph token; it is written into the admin-only `credenciaisWhatsapp`
 * subcollection (default-deny — the browser never reads it) and is NEVER logged
 * or echoed back. POST body: `{ integracaoId, token }`. DELETE takes
 * `?integracaoId=` (the secret is never put in a URL). There is no OAuth flow
 * for WhatsApp, so — unlike the marketplace backends — this replaces the
 * consent/callback dance with a direct operator-supplied token.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadWhatsappContext } from '@/lib/whatsapp/whatsapp';
import { isWhatsappError, whatsappErrorResponse } from '@/lib/whatsapp/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface TokenBody {
  integracaoId?: unknown;
  token?: unknown;
}

async function readJsonBody(req: Request): Promise<TokenBody> {
  try {
    return (await req.json()) as TokenBody;
  } catch (err) {
    // Empty / non-JSON body → treat as no params (the handler 400s below).
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const body = await readJsonBody(req);
  const integracaoId = typeof body.integracaoId === 'string' ? body.integracaoId : '';
  const token = typeof body.token === 'string' ? body.token : '';
  if (!integracaoId || !token) {
    return NextResponse.json({ error: 'integracaoId e token são obrigatórios.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadWhatsappContext(db, integracaoId);
    await ctx.store.save({
      permanent_token: token,
      phoneNumberId: ctx.conta.phoneNumberId,
      wa_id: ctx.conta.wa_id,
      // `pin: null` here means "no explicit pin" — `store.save` carries any
      // previously-registered two-step PIN forward so a token replacement never
      // wipes it (the re-register flow needs the SAME pin).
      pin: null,
      createdAt: Date.now(),
    });
    // Never log or echo the token back.
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isWhatsappError(err)) return whatsappErrorResponse(err);
    throw err;
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const integracaoId = new URL(req.url).searchParams.get('integracaoId');
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadWhatsappContext(db, integracaoId);
    await ctx.store.revoke();
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isWhatsappError(err)) return whatsappErrorResponse(err);
    throw err;
  }
}
