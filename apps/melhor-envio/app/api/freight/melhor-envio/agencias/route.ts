/**
 * `GET /api/freight/melhor-envio/agencias?intFreteId=…&service=…&state=…&city=…`
 *
 * The drop-off agencies of the carrier behind `service`, near the sender —
 * feeds the buy modal's agency picker (#377). Resolves service → company via
 * `listServices` (same source of truth as the `ensureCartAgency` auto-resolve),
 * lists that company's agencies in the sender's city, and falls back to a
 * state-wide list when the city has none (the silent auto-resolve would find
 * nothing there and the drop-off cart insert would fail with ME's opaque 500).
 * An unknown service/carrier returns an empty list — the picker hides and the
 * server-side auto-resolve still applies at buy time. Requires PERM.frete.read.
 */
import { NextResponse } from 'next/server';
import { companyForService } from '@delfrance/integrations-freight-br';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMelhorEnvioContext } from '@/lib/freight/melhorEnvio';
import { isMelhorEnvioError, melhorEnvioErrorResponse } from '@/lib/freight/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.frete.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const intFreteId = params.get('intFreteId');
  const serviceRaw = params.get('service');
  const state = params.get('state');
  const city = params.get('city');
  // `Number(null)`/`Number('')` are both 0 — guard the raw value first so a
  // missing/blank service is a 400, not a lookup for service 0.
  const service = serviceRaw ? Number(serviceRaw) : Number.NaN;
  if (!intFreteId || !state || !city || !Number.isFinite(service)) {
    return NextResponse.json(
      { error: 'intFreteId, service, state e city são obrigatórios.' },
      { status: 400 },
    );
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMelhorEnvioContext(db, intFreteId);
    const company = await companyForService(ctx.api, service);
    if (company == null) return NextResponse.json({ agencies: [] });

    let agencies = await ctx.api.listAgencies({ company, country: 'BR', state, city });
    if (agencies.length === 0) {
      agencies = await ctx.api.listAgencies({ company, country: 'BR', state });
    }
    return NextResponse.json({ agencies });
  } catch (err) {
    if (isMelhorEnvioError(err)) return melhorEnvioErrorResponse(err);
    throw err;
  }
}
