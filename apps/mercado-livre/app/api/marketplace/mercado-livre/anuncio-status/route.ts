/**
 * `POST /api/marketplace/mercado-livre/anuncio-status` — PAUSE or REACTIVATE
 * listings on Mercado Livre, on the operator's command. Requires
 * `PERM.integracao.write`, the same bit as `publicar` and `reverificar-anuncio`.
 *
 * Body: `{ integracaoId, produtoIds[1..50], acao: 'pausar'|'reativar', linkDocId? }`.
 * `linkDocId` narrows the run to ONE listing — that is the produto tab's
 * per-anúncio button — and requires exactly one `produtoId`. Without it the run
 * covers every listing the selected produtos hold on that conta, which is the
 * produtos-table bulk action.
 *
 * ⚠️ **This is not a delist-on-delete cascade** (#476, closed by decision).
 * Deleting a produto in the ERP leaves the marketplace untouched; a listing's
 * lifecycle moves only when a human asks for it, here.
 *
 * SYNCHRONOUS by design, exactly as `enviar-estoque` is: the acceptance is a
 * per-LISTING outcome and the work is bounded at 50 produtos by construction, so
 * it needs neither a job document nor a poll route. Per-listing failure is DATA
 * — a valid request answers 200 even when every listing was refused. The 4xx
 * ladder below is only for what stops the whole request.
 *
 * Responses:
 *  - 200 `AnuncioStatusResponse` — the envelope, channel-neutral by design so a
 *    second marketplace's `/api/marketplace/<canal>/anuncio-status` can return
 *    the same shape and the web registry dispatches without knowing which
 *    channel answered.
 *  - 400 `ML_SELECAO_INVALIDA` / `ML_SELECAO_EXCEDE_LIMITE` / `ML_ACAO_INVALIDA`.
 *    Oversize is REJECTED, never truncated — a silently dropped tail under a
 *    green summary is the failure this whole area guards against.
 *  - ML/context errors map through `mercadoLivreErrorResponse`.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import { ACAO_STATUS_ANUNCIO, type AcaoStatusAnuncio } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { naoDocId } from '@/lib/marketplace/core/linkRefs';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';
import {
  ANUNCIO_STATUS_MAX_PRODUTOS,
  definirStatusAnunciosManual,
} from '@/lib/marketplace/anuncios/anuncioStatusManual';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ACOES = new Set<string>(Object.values(ACAO_STATUS_ANUNCIO));

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

  // TYPE-check, not truthiness: a non-string that happens to be truthy sails
  // past a `!value` guard and then throws deep inside `.doc(id)` ("not a valid
  // resource path") — a 500 for what is a client error.
  if (naoDocId(body.integracaoId)) {
    return NextResponse.json(
      { error: 'integracaoId é obrigatório (id de documento válido).' },
      { status: 400 },
    );
  }
  const integracaoId = body.integracaoId as string;

  if (typeof body.acao !== 'string' || !ACOES.has(body.acao)) {
    return NextResponse.json(
      { error: 'acao deve ser "pausar" ou "reativar".', code: 'ML_ACAO_INVALIDA' },
      { status: 400 },
    );
  }
  const acao = body.acao as AcaoStatusAnuncio;

  if (
    !Array.isArray(body.produtoIds) ||
    body.produtoIds.length === 0 ||
    !body.produtoIds.every((id): id is string => typeof id === 'string' && id !== '')
  ) {
    return NextResponse.json(
      { error: 'Selecione ao menos 1 produto.', code: 'ML_SELECAO_INVALIDA' },
      { status: 400 },
    );
  }
  const produtoIds = body.produtoIds;
  const distintos = new Set(produtoIds).size;
  // REJECT rather than truncate — see the module doc.
  if (distintos > ANUNCIO_STATUS_MAX_PRODUTOS) {
    return NextResponse.json(
      {
        error: `Selecione no máximo ${String(ANUNCIO_STATUS_MAX_PRODUTOS)} produtos.`,
        code: 'ML_SELECAO_EXCEDE_LIMITE',
        limite: ANUNCIO_STATUS_MAX_PRODUTOS,
        solicitados: distintos,
      },
      { status: 400 },
    );
  }

  let linkDocId: string | null = null;
  if (body.linkDocId !== undefined && body.linkDocId !== null) {
    if (naoDocId(body.linkDocId)) {
      return NextResponse.json(
        { error: 'linkDocId deve ser um id de documento válido.' },
        { status: 400 },
      );
    }
    // A single-listing run addresses ONE produto by construction: the link doc
    // lives under exactly one anchor, so a wider selection would silently mean
    // something other than what was asked.
    if (distintos !== 1) {
      return NextResponse.json(
        {
          error: 'linkDocId exige exatamente 1 produto.',
          code: 'ML_SELECAO_INVALIDA',
        },
        { status: 400 },
      );
    }
    linkDocId = body.linkDocId as string;
  }

  const db = getAdminFirestore();
  const nowMs = Date.now();

  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const channelCtx = await ctx.resolveChannelContext(nowMs);
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const resposta = await definirStatusAnunciosManual(
      db,
      { integracaoId, produtoIds, acao, linkDocId },
      { api, nowMs },
    );
    return NextResponse.json(resposta);
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
