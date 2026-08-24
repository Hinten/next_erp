/**
 * `POST /api/marketplace/mercado-livre/enviar-estoque` — push the CURRENT stock
 * of a hand-picked set of produtos to their Mercado Livre listings, right now
 * (#819). Body: `{ integracaoId, produtoIds[1..50], reenviarComErro? }`.
 * Requires `PERM.integracao.write` — the same bit as `publicar` and
 * `reverificar-anuncio`.
 *
 * Until this route existed, the only thing that ever sent `available_quantity`
 * to ML was the `sendMercadoLivreStock` queue, fed exclusively by the three
 * `onSchedule` sweeps: a wrong quantity could only be fixed by waiting up to 15
 * minutes, until 02:00, or — for a kit whose component moved but which did not
 * itself sell (ADR 0014) — until the monthly pass.
 *
 * SYNCHRONOUS by design: the acceptance is a per-LISTING outcome, and the work
 * is bounded at 50 produtos by construction, so it needs neither a job document
 * nor a poll route. Per-listing failure is DATA, not an HTTP error — a valid
 * request answers 200 even when every listing failed. The 4xx ladder below is
 * only for things that stop the whole request.
 *
 * Responses:
 *  - 200 `PushEstoqueResponse` — the envelope, channel-neutral by design so a
 *    second marketplace's `/api/marketplace/<canal>/enviar-estoque` can return
 *    the same shape and the web registry dispatches without knowing which
 *    channel answered.
 *  - 400 `ML_SELECAO_INVALIDA` / `ML_SELECAO_EXCEDE_LIMITE` — bad or oversize
 *    selection. Oversize is REJECTED, never truncated (see estoqueManual.ts).
 *  - 400 `ML_CONTA_SEM_DEPOSITO`, 409 `ML_CONTA_MULTIORIGEM`, 409
 *    `ML_CONTA_PAUSADA` — conta-level refusals.
 *  - ML/context errors map through `mercadoLivreErrorResponse`.
 */
import { NextResponse } from 'next/server';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import { estoqueMercadoLivreSyncCollection } from '@delfrance/data/admin/collections';
import { millisToMicros } from '@delfrance/core/datetime';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  MANUAL_PUSH_MAX_PRODUTOS,
  ManualPushGuardError,
  enviarEstoqueManual,
} from '@/lib/marketplace/estoque/estoqueManual';
import { loadMercadoLivreContext } from '@/lib/marketplace/core/mercadoLivre';
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
      {
        error: 'Selecione ao menos 1 produto para enviar o estoque.',
        code: 'ML_SELECAO_INVALIDA',
      },
      { status: 400 },
    );
  }
  const produtoIds = body.produtoIds;
  // Legacy parity (produtoTableView.dart:1153) — and REJECT rather than
  // truncate: silently dropping the tail under a green summary is the exact
  // silent-under-send failure this area is built to avoid.
  if (new Set(produtoIds).size > MANUAL_PUSH_MAX_PRODUTOS) {
    return NextResponse.json(
      {
        error:
          `Selecione no máximo ${String(MANUAL_PUSH_MAX_PRODUTOS)} produtos para enviar o ` +
          'estoque. O envio periódico cobre o restante do catálogo.',
        code: 'ML_SELECAO_EXCEDE_LIMITE',
        limite: MANUAL_PUSH_MAX_PRODUTOS,
        solicitados: new Set(produtoIds).size,
      },
      { status: 400 },
    );
  }

  if (body.reenviarComErro !== undefined && typeof body.reenviarComErro !== 'boolean') {
    return NextResponse.json({ error: 'reenviarComErro deve ser booleano.' }, { status: 400 });
  }
  const reenviarComErro = body.reenviarComErro === true;

  const db = getAdminFirestore();
  const nowMs = Date.now();

  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);

    // Pause pre-check. The send handler's own gate is the backstop for a 429
    // stamped by a concurrent queue task mid-request; checking here first saves
    // up to 50 pointless calls and gives the operator the real message.
    const stateSnap = await estoqueMercadoLivreSyncCollection.docRef(db, {}, integracaoId).get();
    const pausedUntilUs = (stateSnap.data() ?? {}).pausedUntilUs as unknown;
    if (
      typeof pausedUntilUs === 'number' &&
      Number.isFinite(pausedUntilUs) &&
      pausedUntilUs > millisToMicros(nowMs)
    ) {
      return NextResponse.json(
        {
          error:
            'O Mercado Livre limitou as requisições desta conta. Tente novamente em alguns ' +
            'minutos.',
          code: 'ML_CONTA_PAUSADA',
          pausadoAte: new Date(Math.floor(pausedUntilUs / 1000)).toISOString(),
        },
        { status: 409 },
      );
    }

    const channelCtx = await ctx.resolveChannelContext(nowMs);
    const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

    const resposta = await enviarEstoqueManual(
      db,
      { integracaoId, produtoIds, reenviarComErro },
      {
        nowMs,
        conta: ctx.conta,
        contaNome: typeof ctx.conta.nome === 'string' ? ctx.conta.nome : null,
        // Memoized: every send in this request reuses the ONE context already
        // resolved above instead of re-reading the integração + token per task.
        contextLoader: () => Promise.resolve(ctx),
        api,
      },
    );
    return NextResponse.json(resposta);
  } catch (err) {
    if (err instanceof ManualPushGuardError) {
      return NextResponse.json(
        { error: err.message, code: err.code, ...err.extra },
        { status: err.status },
      );
    }
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}
