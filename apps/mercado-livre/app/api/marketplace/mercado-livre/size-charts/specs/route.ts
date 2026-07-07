/**
 * `POST /api/marketplace/mercado-livre/size-charts/specs` — the domain's
 * grid technical specs. Body `{ integracaoId, domainId, attributes? }`:
 * without `attributes` returns the FULL domain spec (where the UI finds the
 * `grid_template_required` / `grid_filter` attributes); with `attributes`
 * (the chosen GENDER/BRAND/filters, old-app body shape) returns the concrete
 * grid columns (`?section=grids`). Requires `PERM.integracao.read`.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
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
  const body = parsed as {
    integracaoId?: string;
    domainId?: string;
    attributes?: Array<Record<string, unknown>>;
  };
  if (!body.integracaoId || !body.domainId) {
    return NextResponse.json(
      { error: 'integracaoId e domainId são obrigatórios.' },
      { status: 400 },
    );
  }

  try {
    const ctx = await loadMercadoLivreContext(getAdminFirestore(), body.integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const specs = Array.isArray(body.attributes)
      ? await api.getGridTechnicalSpecs(body.domainId, body.attributes)
      : await api.getDomainTechnicalSpecs(body.domainId);
    return NextResponse.json(specs);
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
