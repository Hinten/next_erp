/**
 * `POST /api/marketplace/mercado-livre/dados-fiscais` — (re-)send the per-SKU
 * fiscal data of ONE anúncio to ML's Faturador without republishing it (#745).
 * Body: `{ integracaoId, produtoId, linkDocId }`. Requires
 * `PERM.integracao.write`.
 *
 * Every publish already sends it; this is the operator's way to re-send after
 * an imposto edit, which changes nothing ML would otherwise hear about. The
 * SKUs are rebuilt from the STORED links (`dadosFiscaisAlvos.ts`) and go
 * through the same `enviarDadosFiscais` publish uses.
 *
 * Responses: 200 `{ dadosFiscais }` — a SKU ML refused is DATA in that summary,
 * never a failure status; 404 when the link doc is missing or belongs to
 * another conta; 409 when the listing was never published, or is a
 * User-Products family whose members this ERP does not hold; a failure to
 * reach the conta itself (dead credential) maps through
 * `mercadoLivreErrorResponse`.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import { produtoMercadoLivreLinkCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { naoDocId, refMatchesIntegracao } from '@/lib/marketplace/core/linkRefs';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';
import { enviarDadosFiscais } from '@/lib/marketplace/anuncios/dadosFiscais';
import { alvosFiscaisArmazenados } from '@/lib/marketplace/anuncios/dadosFiscaisAlvos';

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
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;
  // `naoDocId`, not truthiness: each id reaches `.doc()`, which throws on a
  // non-string or a separator-bearing value OUTSIDE any try this handler owns.
  if (naoDocId(body.integracaoId) || naoDocId(body.produtoId) || naoDocId(body.linkDocId)) {
    return NextResponse.json(
      { error: 'integracaoId, produtoId e linkDocId são obrigatórios (id de documento válido).' },
      { status: 400 },
    );
  }
  const integracaoId = body.integracaoId as string;
  const produtoId = body.produtoId as string;
  const linkDocId = body.linkDocId as string;

  const db = getAdminFirestore();

  // The link proves the anúncio belongs to the conta the caller named — never
  // trust the body alone — before an OAuth refresh or an ML call is spent.
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

  const alvos = await alvosFiscaisArmazenados(db, { produtoId, linkDocId, link });
  if (alvos.length === 0) {
    return NextResponse.json(
      {
        error:
          'Nenhuma variação publicada deste anúncio está registrada no ERP — republique o anúncio.',
      },
      { status: 409 },
    );
  }

  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const channelCtx = await ctx.resolveChannelContext();
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
    const operacaoOuterRef =
      typeof ctx.conta.operacaoOuterRef === 'string' ? ctx.conta.operacaoOuterRef : null;

    const dadosFiscais = await enviarDadosFiscais({ db, api, operacaoOuterRef }, alvos);
    return NextResponse.json({ dadosFiscais });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
