/**
 * `POST /api/marketplace/mercado-livre/size-charts/sync` — send one
 * integração's edited size charts to ML and persist the resulting ids on the
 * tabMedi doc. Body `{ integracaoId, tabMediId, tabelas: [...] }` (the
 * DESIRED chart list; the stored doc is the diff baseline). Response 200
 * `{ tabelas, validationErrors, updated }` — ML chart-validation problems are
 * DATA (partial success is normal, legacy parity), not an HTTP error; only
 * infrastructure failures map to error statuses. Requires
 * `PERM.integracao.write`.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';
import {
  TabelaDeMedidasNotFoundError,
  syncSizeCharts,
} from '@/lib/marketplace/publish/sizeChartSync';

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
  const body = parsed as { integracaoId?: string; tabMediId?: string; tabelas?: unknown };
  if (!body.integracaoId || !body.tabMediId || !Array.isArray(body.tabelas)) {
    return NextResponse.json(
      { error: 'integracaoId, tabMediId e tabelas são obrigatórios.' },
      { status: 400 },
    );
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoLivreContext(db, body.integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const result = await syncSizeCharts(
      { db, api, integracaoId: body.integracaoId },
      body.tabMediId,
      body.tabelas,
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: 'Formato inválido de tabelas.', issues: err.issues },
        { status: 400 },
      );
    }
    if (err instanceof TabelaDeMedidasNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
