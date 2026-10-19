/**
 * `POST /api/marketplace/amazon/conta/[id]/oauth/start` — mint the signed,
 * single-use state and answer the Seller Central consent URL the browser then
 * navigates to. Requires `PERM.integracao.write`: minting a state is a WRITE
 * (the attempt record), hence POST.
 *
 * In order (`lib/amazon/conta/iniciar.ts` holds steps 3 onward):
 *
 *  1. `verifyCaller(PERM.integracao.write)` → 401 / 403;
 *  2. the id's shape → 400 `AMAZON_ID_INVALIDO`, with nothing read;
 *  3. the read switch → 503 `AMAZON_CHAMADAS_DESLIGADAS`, one blocked-call line,
 *     zero fetches and NO Firestore read;
 *  4. the whole connect configuration → 500 `AMAZON_CONFIG_AUSENTE` naming the
 *     missing variables (never a value);
 *  5. the conta (uncached, `tipo` only) → 404 `AMAZON_CONTA_NAO_ENCONTRADA`; a
 *     parked or inactive conta CAN start;
 *  6–8. sign, build the URL, persist the attempt — BEFORE answering;
 *  9. 200 `{ authorizeUrl }`.
 *
 * No request body is read. Starting a consent never calls Amazon. Every answer
 * carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
 */
import type { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { iniciarConexaoAmazon } from '@/lib/amazon/conta/iniciar';
import { amazonOauthState } from '@/lib/amazon/conta/oauthState';
import { idDeContaValido } from '@/lib/amazon/core/contas';
import {
  comCabecalhosAmazon,
  ehErroAppAmazon,
  respostaDeErroAmazon,
  respostaIdInvalido,
  respostaJson,
} from '@/lib/amazon/core/respond';
import { LOGGER_STDOUT_AMAZON } from '@/lib/amazon/core/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return comCabecalhosAmazon(auth.error);
  const { id } = await params;
  if (!idDeContaValido(id)) return respostaIdInvalido();

  try {
    const { authorizeUrl } = await iniciarConexaoAmazon(getAdminFirestore(), id, {
      ambiente: process.env,
      agoraMs: Date.now(),
      estado: amazonOauthState,
      logger: LOGGER_STDOUT_AMAZON,
    });
    return respostaJson(200, { authorizeUrl });
  } catch (err) {
    if (ehErroAppAmazon(err)) return respostaDeErroAmazon(err);
    throw err;
  }
}
