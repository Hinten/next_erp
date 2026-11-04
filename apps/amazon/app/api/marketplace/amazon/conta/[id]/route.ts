/**
 * `GET /api/marketplace/amazon/conta/[id]` — the conta's connection status, for
 * the panel. Requires `PERM.integracao.read`.
 *
 * Answers `statusContaAmazonSchema` (`@delfrance/schemas`): an explicit
 * projection — connected or not, the authorization and reauthorization dates
 * as São Paulo civil dates, the days left, the park, and whether the read switch
 * is on. Never a token, a ref, an LWA code or a seller id.
 *
 * - The conta is read UNCACHED and only `tipo === 8` is required: an inactive,
 *   unconnected or parked conta answers 200 — this panel is where it gets fixed.
 * - A corrupt credential answers 200 with `credencialInvalida: true`; a new
 *   consent overwrites it.
 * - NOT gated by the read switch: no Amazon call happens here.
 *
 * Every answer carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
 */
import type { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { statusContaAmazon } from '@/lib/amazon/conta/status';
import { idDeContaValido } from '@/lib/amazon/core/contas';
import {
  comCabecalhosAmazon,
  ehErroAppAmazon,
  respostaDeErroAmazon,
  respostaIdInvalido,
  respostaJson,
} from '@/lib/amazon/core/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return comCabecalhosAmazon(auth.error);
  const { id } = await params;
  if (!idDeContaValido(id)) return respostaIdInvalido();

  try {
    const status = await statusContaAmazon(getAdminFirestore(), id, {
      ambiente: process.env,
      agoraMs: Date.now(),
    });
    return respostaJson(200, status);
  } catch (err) {
    if (ehErroAppAmazon(err)) return respostaDeErroAmazon(err);
    throw err;
  }
}
