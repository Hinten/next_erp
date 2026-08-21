/**
 * `POST /api/marketplace/mercado-livre/size-charts/verificar-exclusao` — read a
 * chart back from ML and settle a pending deletion request. Body
 * `{ integracaoId, tabMediId, chartId }`. Response 200
 * `{ removed, chartStatus, tabelas }`.
 *
 * `removed: true` (a 404 from ML, or `chart_status: 'INACTIVE'`) drops the guia
 * from the tabMedi doc. `removed: false` with `chartStatus: 'ACTIVE'` means at
 * least one listing still links it — the operator has to unlink before ML will
 * remove anything. Requires `PERM.integracao.write` (it writes the doc).
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';
import {
  SizeChartNotFoundError,
  verifySizeChartDeletion,
} from '@/lib/marketplace/size-charts/sizeChartDelete';
import { TabelaDeMedidasNotFoundError } from '@/lib/marketplace/size-charts/sizeChartSync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
    }
    throw err;
  }
  // `req.json()` legally yields null/arrays/scalars — those are 400s, not 500s.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
  }
  const body = parsed as { integracaoId?: string; tabMediId?: string; chartId?: string };
  if (!body.integracaoId || !body.tabMediId || !body.chartId) {
    return NextResponse.json(
      { error: 'integracaoId, tabMediId e chartId são obrigatórios.' },
      { status: 400 },
    );
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoLivreContext(db, body.integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const result = await verifySizeChartDeletion(
      { db, api, integracaoId: body.integracaoId },
      body.tabMediId,
      body.chartId,
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TabelaDeMedidasNotFoundError || err instanceof SizeChartNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
