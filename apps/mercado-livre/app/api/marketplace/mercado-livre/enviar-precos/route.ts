/**
 * `POST /api/marketplace/mercado-livre/enviar-precos` — push the CURRENT price
 * of a hand-picked set of produtos to their Mercado Livre listings, right now
 * (#804 S6). Body:
 * `{ integracaoId, produtoIds[1..50], baixarPreco?, incluirNaoPublicados? }`.
 * Requires `PERM.integracao.write` — the same bit as `atualizar-precos` and
 * `enviar-estoque`.
 *
 * Until this route existed, the only way to push a price was the account-wide
 * `atualizar-precos` job, whose body carries no produto scoping at all. Lowering
 * ONE produto's price therefore meant running that job with "Permitir baixar
 * preços" ticked, which also lowers every other listing sitting below its ML
 * price — riskier than the legacy row action it replaced
 * (`.old/lib/produtos/pages/produtoTableView.dart:397-434`).
 *
 * SYNCHRONOUS by design, exactly like `enviar-estoque`: the acceptance is a
 * per-LISTING outcome, and the work is bounded at 50 produtos by construction,
 * so it needs neither a job document nor a poll route. Per-listing failure is
 * DATA, not an HTTP error — a valid request answers 200 even when every listing
 * failed. The 4xx ladder below is only for things that stop the whole request.
 *
 * Responses:
 *  - 200 `PushPrecoResponse` — the envelope, channel-neutral by design so a
 *    second marketplace's `/api/marketplace/<canal>/enviar-precos` can return
 *    the same shape and the web registry dispatches without knowing which
 *    channel answered.
 *  - 400 `ML_SELECAO_INVALIDA` / `ML_SELECAO_EXCEDE_LIMITE` — bad or oversize
 *    selection. Oversize is REJECTED, never truncated (see precoManual.ts).
 *  - 400 `ML_CONTA_SEM_TABELA_NORMAL` — the conta has no price source.
 *  - ML/context errors map through `mercadoLivreErrorResponse`.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
import {
  MANUAL_PRECO_MAX_PRODUTOS,
  ManualPrecoGuardError,
  enviarPrecoManual,
} from '@/lib/marketplace/preco/precoManual';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/core/respond';

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

  // TYPE-check, not truthiness: a non-string that happens to be truthy sails
  // past a `!value` guard and then throws deep inside `.doc(id)` ("not a valid
  // resource path") — a 500 for what is a client error.
  if (typeof body.integracaoId !== 'string' || body.integracaoId === '') {
    return NextResponse.json(
      { error: 'integracaoId é obrigatório (string não vazia).' },
      { status: 400 },
    );
  }
  const integracaoId = body.integracaoId;

  if (
    !Array.isArray(body.produtoIds) ||
    body.produtoIds.length === 0 ||
    !body.produtoIds.every((id): id is string => typeof id === 'string' && id !== '')
  ) {
    return NextResponse.json(
      { error: 'Selecione ao menos 1 produto para enviar o preço.', code: 'ML_SELECAO_INVALIDA' },
      { status: 400 },
    );
  }
  const produtoIds = body.produtoIds;
  // Legacy parity (produtoTableView.dart:417) — and REJECT rather than
  // truncate: silently dropping the tail under a green summary is the exact
  // silent-under-send failure this area is built to avoid.
  if (new Set(produtoIds).size > MANUAL_PRECO_MAX_PRODUTOS) {
    return NextResponse.json(
      {
        error:
          `Selecione no máximo ${String(MANUAL_PRECO_MAX_PRODUTOS)} produtos para enviar o ` +
          'preço. Use "Atualizar preços" na tela do canal para a conta inteira.',
        code: 'ML_SELECAO_EXCEDE_LIMITE',
        limite: MANUAL_PRECO_MAX_PRODUTOS,
        solicitados: new Set(produtoIds).size,
      },
      { status: 400 },
    );
  }

  if (body.baixarPreco !== undefined && typeof body.baixarPreco !== 'boolean') {
    return NextResponse.json({ error: 'baixarPreco deve ser booleano.' }, { status: 400 });
  }
  const baixarPreco = body.baixarPreco === true;

  if (body.incluirNaoPublicados !== undefined && typeof body.incluirNaoPublicados !== 'boolean') {
    return NextResponse.json({ error: 'incluirNaoPublicados deve ser booleano.' }, { status: 400 });
  }
  // ⚠️ `!== false`, the INVERSE of `baixarPreco` one line above. Absent means
  // SEND — see `EnviarPrecoManualArgs.incluirNaoPublicados`. A caller that does
  // not know the field (an older web bundle in a stale tab) therefore behaves
  // like every other price/stock surface in the repo rather than keeping a gate
  // this route is the last holder of.
  const incluirNaoPublicados = body.incluirNaoPublicados !== false;

  const db = getAdminFirestore();
  const nowMs = Date.now();

  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    const channelCtx = await ctx.resolveChannelContext(nowMs);
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const resposta = await enviarPrecoManual(
      db,
      { integracaoId, produtoIds, baixarPreco, incluirNaoPublicados },
      {
        nowMs,
        conta: ctx.conta,
        contaNome: typeof ctx.conta.nome === 'string' ? ctx.conta.nome : null,
        api,
      },
    );
    return NextResponse.json(resposta);
  } catch (err) {
    if (err instanceof ManualPrecoGuardError) {
      return NextResponse.json(
        { error: err.message, code: err.code, ...err.extra },
        { status: err.status },
      );
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
