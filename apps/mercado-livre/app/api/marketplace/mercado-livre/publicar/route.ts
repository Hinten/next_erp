/**
 * `POST /api/marketplace/mercado-livre/publicar` — publish (or re-publish) a
 * produto as a Mercado Livre listing. Body:
 * `{ integracaoId, produtoId, listingTypeId? }` — `listingTypeId` applies only
 * to FIRST publishes (the link doc's persisted value wins on re-publish).
 * Requires `PERM.integracao.write`.
 *
 * Responses: 200 `{ itemId, estado, permalink }`; 422 `ML_PUBLISH_BLOCKED`
 * with the validation issues (missing price/category/photos…); ML/API errors
 * map through `mercadoLivreErrorResponse` (reauth → 409, upstream → 502…).
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';
import { publishProduto } from '@/lib/marketplace/publish';
import { MercadoLivrePublishError } from '@/lib/marketplace/publishCore';

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
  const body = parsed as { integracaoId?: string; produtoId?: string; listingTypeId?: string };
  if (!body.integracaoId || !body.produtoId) {
    return NextResponse.json(
      { error: 'integracaoId e produtoId são obrigatórios.' },
      { status: 400 },
    );
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoLivreContext(db, body.integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const result = await publishProduto(
      {
        db,
        api,
        integracaoId: body.integracaoId,
        tabelaNormalOuterRef: asStringOrNull(ctx.conta.tabelaNormalOuterRef),
        depositoOuterRef: asStringOrNull(ctx.conta.depositoOuterRef),
        // The seller whose items the User-Products orphan sweep enumerates —
        // same source `/importar` uses for the family fan-out.
        sellerUserId: asNumberOrNull(ctx.conta.user_id),
        listingTypeId: body.listingTypeId ?? null,
      },
      body.produtoId,
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MercadoLivrePublishError) {
      return NextResponse.json(
        { error: err.message, issues: err.issues, code: 'ML_PUBLISH_BLOCKED' },
        { status: 422 },
      );
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
