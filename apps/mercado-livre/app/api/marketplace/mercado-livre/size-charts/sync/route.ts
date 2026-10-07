/**
 * `POST /api/marketplace/mercado-livre/size-charts/sync` — send one
 * saved chart to ML and checkpoint its confirmed IDs. Body includes account,
 * tabela, operationId, chartIndex and the committed chart snapshot. Remote GET
 * supplies the baseline. Validation failures are 200 data; conflict/busy/unknown
 * outcomes are distinct 409 codes. Requires
 * `PERM.integracao.write`.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { mlSizeChartSyncRequestSchema } from '@delfrance/schemas';
import {
  currentOperation,
  SizeChartOperationError,
} from '@/lib/marketplace/size-charts/sizeChartOperation';
import { createChartApi } from '@/lib/marketplace/size-charts/sizeChartApi';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';
import {
  TabelaDeMedidasNotFoundError,
  syncSizeCharts,
} from '@/lib/marketplace/size-charts/sizeChartSync';

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
  const body = parsed as { integracaoId?: string; tabMediId?: string };
  if (
    typeof body.integracaoId !== 'string' ||
    !body.integracaoId ||
    typeof body.tabMediId !== 'string' ||
    !body.tabMediId
  ) {
    return NextResponse.json(
      { error: 'integracaoId e tabMediId são obrigatórios.' },
      { status: 400 },
    );
  }

  const db = getAdminFirestore();
  try {
    const request = mlSizeChartSyncRequestSchema.parse(parsed);
    const ctx = await loadMercadoLivreContext(db, body.integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createChartApi(channelCtx.accessToken);
    const result = await syncSizeCharts(
      { db, api, integracaoId: body.integracaoId },
      body.tabMediId,
      request,
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SizeChartOperationError)
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    if (err instanceof ZodError)
      return NextResponse.json(
        { error: 'Formato inválido de guia.', issues: err.issues },
        { status: 400 },
      );
    if (err instanceof TabelaDeMedidasNotFoundError)
      return NextResponse.json({ error: err.message }, { status: 404 });
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}

/** Recovery discovery is permission-gated; operational receipts remain Admin-only. */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;
  const url = new URL(req.url);
  const tabMediId = url.searchParams.get('tabMediId');
  const integracaoId = url.searchParams.get('integracaoId');
  if (!tabMediId || !integracaoId)
    return NextResponse.json(
      { error: 'tabMediId e integracaoId são obrigatórios.' },
      { status: 400 },
    );
  const op = await currentOperation(getAdminFirestore(), tabMediId, integracaoId);
  return NextResponse.json({
    operation:
      op?.kind === 'sync'
        ? {
            operationId: op.id,
            chartIndex: op.chartIndex,
            chart: op.desired,
            projected: op.projected,
            status: op.status,
          }
        : null,
  });
}
