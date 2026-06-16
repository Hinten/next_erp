/**
 * `POST /api/freight/melhor-envio/calculate`
 *
 * Body: `{ intFreteId, from, to, package | volumes, options? }`. Resolves
 * the account, refreshes the token if needed, and proxies
 * `shipment/calculate` to Melhor Envio. The browser never holds a ME
 * token. Requires PERM.frete.read (quoting is a read).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { calculateRequestSchema } from '@delfrance/integrations-freight-br';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMelhorEnvioContext } from '@/lib/freight/melhorEnvio';
import { isMelhorEnvioError, melhorEnvioErrorResponse } from '@/lib/freight/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = calculateRequestSchema.extend({ intFreteId: z.string().min(1) });

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
      {
        error: `Validação falhou: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      },
      { status: 400 },
    );
  }
  const { intFreteId, ...request } = parsed.data;

  const db = getAdminFirestore();
  try {
    const ctx = await loadMelhorEnvioContext(db, intFreteId);
    const quotes = await ctx.api.calculate(request);
    return NextResponse.json(quotes);
  } catch (err) {
    if (isMelhorEnvioError(err)) return melhorEnvioErrorResponse(err);
    throw err;
  }
}
