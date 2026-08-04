/**
 * `POST /api/marketplace/mercado-livre/reverificar-anuncio` — re-read ONE listing
 * from Mercado Livre and record its real state on the link doc. Body:
 * `{ integracaoId, produtoId, linkDocId }`. Requires `PERM.integracao.write`.
 *
 * This is the operator's way out of a stock latch (#781). The stock sender stops
 * sending to a listing whose link carries `estado 'E'` — which it writes only
 * after ML confirmed the anúncio itself is healthy, i.e. our payload was the
 * problem. Normally an `items` webhook re-arms it automatically, but a listing
 * nobody touches never fires one, so without this route a single wrong 4xx could
 * park a listing indefinitely.
 *
 * It deliberately does NOT enqueue a send: recomputing one family's quantities
 * here would duplicate the sweep's join. Clearing the state is enough — the next
 * sweep (≤15 min) picks the listing up on its own.
 *
 * Responses: 200 `{ estado, status, subStatus, enviavel }`; 404 when the link
 * doc is missing or belongs to another conta; 409 when the listing was never
 * published; ML errors map through `mercadoLivreErrorResponse`.
 */
import { NextResponse } from 'next/server';
import {
  MercadoLivreHttpError,
  createMercadoLivreApi,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import { produtoMercadoLivreLinkCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { podeEnviarEstoque } from '@/lib/marketplace/estoquePlan';
import { applyItemStatusToLink } from '@/lib/marketplace/itemsStatusSync';
import { refMatchesIntegracao } from '@/lib/marketplace/linkRefs';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';

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

  // Read the link FIRST: it carries the ML item id, and it is what proves this
  // listing belongs to the conta the caller named (never trust the body alone).
  const snap = await produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkDocId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: 'Anúncio não encontrado neste produto.' }, { status: 404 });
  }
  const link = (snap.data() ?? {}) as Record<string, unknown>;
  if (!refMatchesIntegracao(link.contaOuterRef, integracaoId)) {
    return NextResponse.json({ error: 'Anúncio não pertence a esta conta.' }, { status: 404 });
  }
  const itemId = typeof link.id === 'string' && link.id !== '' ? link.id : null;
  if (itemId == null) {
    return NextResponse.json(
      { error: 'Anúncio ainda não publicado no Mercado Livre.' },
      { status: 409 },
    );
  }

  const target = { produtoId, linkDocId, itemId };
  const nowMs = Date.now();

  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const item = await api.getItem(itemId);
    await applyItemStatusToLink(db, integracaoId, target, item, {
      nowMs,
      // The whole point of the action: drop the stale diagnosis so the produto
      // tab stops showing a fault the listing may no longer have.
      extra: { errors: [] },
    });
    return NextResponse.json({
      estado: estadoFromMlStatus(item.status),
      status: item.status ?? null,
      subStatus: item.sub_status ?? null,
      enviavel: podeEnviarEstoque(item.status, item.sub_status).enviar,
    });
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) {
      // Gone on ML. Record the closed state rather than leaving a stale
      // `status: 'active'` behind — same reasoning as the stock sender's
      // terminal branch, and the sweep's whitelist then skips it.
      await applyItemStatusToLink(
        db,
        integracaoId,
        target,
        { status: 'closed', sub_status: [] },
        { nowMs, extra: { errors: [] } },
      );
      return NextResponse.json({
        estado: estadoFromMlStatus('closed'),
        status: 'closed',
        subStatus: [],
        enviavel: false,
      });
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
