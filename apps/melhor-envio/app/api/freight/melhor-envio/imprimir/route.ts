/**
 * `POST /api/freight/melhor-envio/imprimir`
 *
 * Returns the printable URL of an already-bought label. Idempotent and free
 * (no checkout), so it only needs `PERM.frete.read`. Body
 * `{ intFreteId, printLabelId }`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMelhorEnvioContext } from '@/lib/freight/melhorEnvio';
import { isMelhorEnvioError, melhorEnvioErrorResponse } from '@/lib/freight/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({
  intFreteId: z.string().min(1),
  printLabelId: z.string().min(1),
});

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.frete.read);
  if ('error' in auth) return auth.error;

  let json: unknown;
  try {
    json = await req.json();
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
    }
    throw err;
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'intFreteId e printLabelId são obrigatórios.' },
      { status: 400 },
    );
  }
  const { intFreteId, printLabelId } = parsed.data;

  const db = getAdminFirestore();
  try {
    const ctx = await loadMelhorEnvioContext(db, intFreteId);
    const printed = await ctx.api.print([printLabelId]);
    return NextResponse.json({ url: printed.url });
  } catch (err) {
    if (isMelhorEnvioError(err)) return melhorEnvioErrorResponse(err);
    throw err;
  }
}
