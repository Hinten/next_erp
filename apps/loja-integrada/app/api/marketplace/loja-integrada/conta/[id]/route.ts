/**
 * `GET /api/marketplace/loja-integrada/conta/[id]` — the conta's credential
 * status, for the panel. Requires `PERM.integracao.read`.
 *
 * Answers `statusContaLojaIntegradaSchema` (`@delfrance/schemas`): an explicit
 * projection — configured or not, the expiry as a São Paulo civil date, the
 * days left, the park, and `versaoCredencialUs`, the version the panel echoes
 * back on its next write. Never the token, its fingerprint or the park's ref.
 *
 * - The conta is read UNCACHED and only `tipo === 3` is required: an inactive
 *   or parked conta answers 200, because this panel is where it gets fixed.
 *   Only the flows' context loader refuses those.
 * - A corrupt credential is a 409 `LI_CREDENCIAL_INVALIDA` with field paths,
 *   never a 500; the remedy is to remove the token and save it again.
 * - No Loja Integrada call: the status is what WE stored. A one-time validation
 *   at save time is not live health, and the panel says so.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { lerStatusDaConta } from '@/lib/lojaIntegrada/conta/status';
import { naoEhIdDeConta } from '@/lib/lojaIntegrada/core/contas';
import {
  isLiAppError,
  respostaDeErroLi,
  respostaIdInvalido,
} from '@/lib/lojaIntegrada/core/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;
  const { id } = await params;
  if (naoEhIdDeConta(id)) return respostaIdInvalido();

  try {
    const status = await lerStatusDaConta(getAdminFirestore(), id, Date.now());
    // A credential's state is never served from a cache between two operators.
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (isLiAppError(err)) return respostaDeErroLi(err);
    throw err;
  }
}
