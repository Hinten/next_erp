/**
 * `POST /api/marketplace/mercado-livre/link-anuncio` — where ONE listing lives on
 * Mercado Livre. Body: `{ integracaoId, produtoId, linkDocId }`. Requires
 * `PERM.integracao.read`.
 *
 * This is what makes the produto tab's "ver no Mercado Livre" affordance work for
 * a **User-Products** listing, whose stored `id` is `familyId ?? itemId` — two
 * different ML resources, neither of which the browser can turn into a URL on its
 * own. Telling them apart is `resolveAnuncioUrl`'s job, not this route's. A legacy
 * listing never gets here — `listingPermalink` builds its URL client-side with no
 * round trip.
 *
 * `read`, not `write`: it answers with a public URL and persists nothing (see the
 * ⚠️ in `lib/marketplace/anuncioUrl.ts` for why it is not cached).
 *
 * Responses: 200 `{ url }`; 404 when the link doc is missing, belongs to another
 * conta, or the listing no longer exists on ML; 409 when it was never published;
 * ML errors map through `mercadoLivreErrorResponse`.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import { produtoMercadoLivreLinkCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { resolveAnuncioUrl } from '@/lib/marketplace/anuncioUrl';
import { refMatchesIntegracao } from '@/lib/marketplace/linkRefs';
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
  const body = parsed as Record<string, unknown>;
  // TYPE-check, not just truthiness: a non-string that happens to be truthy
  // (`linkDocId: 1`) would sail past a `!value` guard and then throw deep inside
  // `.doc(id)` ("not a valid resource path") — a 500 for what is a client error.
  const naoString = (v: unknown): boolean => typeof v !== 'string' || v === '';
  if (naoString(body.integracaoId) || naoString(body.produtoId) || naoString(body.linkDocId)) {
    return NextResponse.json(
      { error: 'integracaoId, produtoId e linkDocId são obrigatórios (string não vazia).' },
      { status: 400 },
    );
  }
  const integracaoId = body.integracaoId as string;
  const produtoId = body.produtoId as string;
  const linkDocId = body.linkDocId as string;

  const db = getAdminFirestore();

  // Read the link FIRST: it carries the ML id and the model flag, and it is what
  // proves this listing belongs to the conta the caller named (never trust the
  // body alone).
  const snap = await produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkDocId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: 'Anúncio não encontrado neste produto.' }, { status: 404 });
  }
  const link = (snap.data() ?? {}) as Record<string, unknown>;
  if (!refMatchesIntegracao(link.contaOuterRef, integracaoId)) {
    return NextResponse.json({ error: 'Anúncio não pertence a esta conta.' }, { status: 404 });
  }
  if (typeof link.id !== 'string' || link.id === '') {
    return NextResponse.json(
      { error: 'Anúncio ainda não publicado no Mercado Livre.' },
      { status: 409 },
    );
  }

  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const url = await resolveAnuncioUrl({ api }, link);
    if (url == null) {
      // `link.id` was present, so this is ML saying the listing is gone — not
      // the "never published" case the 409 above covers.
      return NextResponse.json(
        { error: 'O anúncio não existe mais no Mercado Livre.' },
        { status: 404 },
      );
    }
    return NextResponse.json({ url });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
