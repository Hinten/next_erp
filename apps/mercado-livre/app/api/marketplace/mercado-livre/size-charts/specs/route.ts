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

  let body: {
    integracaoId?: string;
    domainId?: string;
    attributes?: Array<Record<string, unknown>>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
    }
    throw err;
  }
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
