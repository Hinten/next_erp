/**
 * `GET /api/freight/melhor-envio/servicos?intFreteId=…`
 *
 * The carrier services of a Melhor Envio account (`listServices`: each service's
 * `id`, `name` and `company`) — feeds the service picker of a sales channel's
 * freight mapping, where a row mapped to Melhor Envio stores which service ships
 * it. A thin forward: the list is validated by the freight-br API client and
 * returned as `{ servicos }`, and the account's token never leaves the server.
 *
 * ⚠️ The read is `listServices({ estrito: true })`. The default read turns any
 * 2xx that is not a list (no body, `{}`, a status message, an HTML page) into
 * `[]`, which this route would answer as `200 { servicos: [] }`: a picker saying
 * the account has no services. The strict read fails it instead
 * (`MelhorEnvioSchemaError` → 502). A list Melhor Envio did send, an empty one
 * included, is still answered 200.
 *
 * `intFreteId` must be ONE document id (`docIdSchema`), refused with a 400
 * otherwise. A value with a `/` addresses another path entirely: an odd segment
 * count is a plain Admin SDK error (a 500 for the caller's mistake), an even one
 * a document in some subcollection. A doc that is absent or not of tipo Melhor
 * Envio is refused by `loadMelhorEnvioContext` (404). Requires PERM.frete.read.
 */
import { NextResponse } from 'next/server';
import { docIdSchema } from '@delfrance/schemas';

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
  if (intFreteId === null || !docIdSchema.safeParse(intFreteId).success) {
    return NextResponse.json(
      { error: 'intFreteId é obrigatório e deve ser o id de uma integração de frete.' },
      { status: 400 },
    );
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMelhorEnvioContext(db, intFreteId);
    const servicos = await ctx.api.listServices({ estrito: true });
    return NextResponse.json({ servicos });
  } catch (err) {
    if (isMelhorEnvioError(err)) return melhorEnvioErrorResponse(err);
    throw err;
  }
}
