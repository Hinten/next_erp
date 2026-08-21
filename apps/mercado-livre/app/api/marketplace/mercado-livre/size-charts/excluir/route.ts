/**
 * `POST /api/marketplace/mercado-livre/size-charts/excluir` — ask ML to remove
 * one size chart. Body `{ integracaoId, tabMediId, chartId }`. Response 200
 * `{ requested: true, message, tabelas }`.
 *
 * ⚠️ A 200 means ML ACCEPTED THE REQUEST, not that anything was removed: it
 * checks asynchronously (up to 24h) that no listing still links the chart and
 * silently keeps it otherwise. The guia therefore stays on the doc, stamped
 * `exclusaoSolicitadaEm`, until `verificar-exclusao` confirms.
 * Requires `PERM.integracao.write`.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';
import {
  SizeChartNotFoundError,
  requestSizeChartDeletion,
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

    const result = await requestSizeChartDeletion(
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
