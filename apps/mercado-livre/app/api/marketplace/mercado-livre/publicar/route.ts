/**
 * `POST /api/marketplace/mercado-livre/publicar` — publish (or re-publish) a
 * produto as a Mercado Livre listing. Body:
 * `{ integracaoId, produtoId, listingTypeId?, linkDocId? }` — `listingTypeId`
 * applies only to FIRST publishes (the link doc's persisted value wins on
 * re-publish); `linkDocId` names WHICH of the conta's anúncios to publish, for
 * a produto that carries more than one on the same account. Omitting it keeps
 * the historical behaviour (the conta's first link doc, else a new one).
 * Requires `PERM.integracao.write`.
 *
 * Responses: 200 `{ itemId, estado, permalink }`; 404 when `linkDocId` names a
 * doc this produto does not have or that belongs to another conta; 422
 * `ML_PUBLISH_BLOCKED` with the validation issues (missing price/category/
 * photos…); ML/API errors map through `mercadoLivreErrorResponse` (reauth →
 * 409, upstream → 502…).
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { produtoMercadoLivreLinkCollection } from '@delfrance/data/admin/collections';
import { refMatchesIntegracao } from '@/lib/marketplace/core/linkRefs';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';
import { publishProduto } from '@/lib/marketplace/anuncios/publish';
import { MercadoLivrePublishError } from '@/lib/marketplace/anuncios/publishCore';

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
  const body = parsed as {
    integracaoId?: string;
    produtoId?: string;
    listingTypeId?: string;
    linkDocId?: string;
  };
  if (!body.integracaoId || !body.produtoId) {
    return NextResponse.json(
      { error: 'integracaoId e produtoId são obrigatórios.' },
      { status: 400 },
    );
  }
  // TYPE-check, not just truthiness — same reasoning as the sibling
  // `reverificar-anuncio` route: a non-string that happens to be truthy
  // (`linkDocId: 1`) sails past a `!value` guard and then throws deep inside
  // `.doc(id)` ("not a valid resource path"), turning a client error into a 500.
  // Optional here, so only a PRESENT-and-wrong value is rejected.
  if (
    body.linkDocId !== undefined &&
    (typeof body.linkDocId !== 'string' || body.linkDocId === '')
  ) {
    return NextResponse.json(
      { error: 'linkDocId, quando enviado, deve ser uma string não vazia.' },
      { status: 400 },
    );
  }
  const linkDocId = body.linkDocId ?? null;

  const db = getAdminFirestore();

  // Prove the named anúncio exists AND belongs to the conta the caller named,
  // before spending an OAuth refresh and an ML round trip on it. Never trust the
  // body alone: without the ownership check a caller could publish one conta's
  // listing under another's token. `publishProduto` re-derives the same thing
  // from the snapshot it already reads — this is the half that can answer 404.
  if (linkDocId != null) {
    const snap = await produtoMercadoLivreLinkCollection
      .docRef(db, { produtoId: body.produtoId }, linkDocId)
      .get();
    if (!snap.exists) {
      return NextResponse.json({ error: 'Anúncio não encontrado neste produto.' }, { status: 404 });
    }
    const link = (snap.data() ?? {}) as Record<string, unknown>;
    if (!refMatchesIntegracao(link.contaOuterRef, body.integracaoId)) {
      return NextResponse.json({ error: 'Anúncio não pertence a esta conta.' }, { status: 404 });
    }
  }

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
        linkDocId,
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
