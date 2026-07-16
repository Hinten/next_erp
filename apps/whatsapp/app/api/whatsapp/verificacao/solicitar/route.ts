/**
 * `POST /api/whatsapp/verificacao/solicitar` — request a 6-digit verification
 * code for the account's number (PIN/SMS registration, step 1). Body:
 * `{ integracaoId, metodo: 'SMS' | 'VOICE' }`. Requires PERM.integracao.write.
 *
 * Thin: validates params, builds the account's `WhatsAppClient` (which resolves
 * the stored permanent token — a missing token maps to 409 reauth), and calls
 * `requestVerificationCode`. Graph failures flow through the shared error mapper
 * (`respond.ts`). Ported from legacy `solicitarCodigoWhatsapp`
 * (`.old/lib/whatsapp/providers/provider.dart:254`).
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadWhatsappContext } from '@/lib/whatsapp/whatsapp';
import { isWhatsappError, whatsappErrorResponse } from '@/lib/whatsapp/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SolicitarBody {
  integracaoId?: unknown;
  metodo?: unknown;
}

async function readJsonBody(req: Request): Promise<SolicitarBody> {
  try {
    return (await req.json()) as SolicitarBody;
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
  const metodo = body.metodo;
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }
  if (metodo !== 'SMS' && metodo !== 'VOICE') {
    return NextResponse.json({ error: "metodo deve ser 'SMS' ou 'VOICE'." }, { status: 400 });
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadWhatsappContext(db, integracaoId);
    const client = await ctx.buildClient();
    await client.requestVerificationCode({ codeMethod: metodo });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isWhatsappError(err)) return whatsappErrorResponse(err);
    throw err;
  }
}
