/**
 * `POST /api/whatsapp/verificacao/confirmar` — verify the 6-digit code (step 2)
 * and flag the account `verificado`. Body: `{ integracaoId, codigo }`. Requires
 * PERM.integracao.write.
 *
 * On a successful `verifyCode`, merges `{ verificado: true }` onto the account
 * doc via the Admin SDK (the client can't self-flag — `verificado` is excluded
 * from the editor). Ported from legacy `verificarCodigoWhatsapp`
 * (`.old/lib/whatsapp/providers/provider.dart:271`), which set `verificado` on
 * the account after the API confirmed the code.
 */
import { NextResponse } from 'next/server';
import { integracaoCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadWhatsappContext } from '@/lib/whatsapp/whatsapp';
import { isWhatsappError, whatsappErrorResponse } from '@/lib/whatsapp/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ConfirmarBody {
  integracaoId?: unknown;
  codigo?: unknown;
}

async function readJsonBody(req: Request): Promise<ConfirmarBody> {
  try {
    return (await req.json()) as ConfirmarBody;
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const body = await readJsonBody(req);
  const integracaoId = typeof body.integracaoId === 'string' ? body.integracaoId : '';
  const codigo = typeof body.codigo === 'string' ? body.codigo : '';
  if (!integracaoId || !codigo) {
    return NextResponse.json({ error: 'integracaoId e codigo são obrigatórios.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadWhatsappContext(db, integracaoId);
    const client = await ctx.buildClient();
    await client.verifyCode({ code: codigo });
    // The code checked out — flag the account verified (Admin SDK; the client
    // never sets this field itself).
    await integracaoCollection.merge(db, {}, integracaoId, { verificado: true });
    return NextResponse.json({ ok: true, verificado: true });
  } catch (err) {
    if (isWhatsappError(err)) return whatsappErrorResponse(err);
    throw err;
  }
}
