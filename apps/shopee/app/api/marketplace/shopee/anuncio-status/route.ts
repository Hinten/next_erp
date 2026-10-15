/**
 * `POST /api/marketplace/shopee/anuncio-status` — PAUSE or REACTIVATE Shopee
 * listings on the operator's command. Body:
 * `{ integracaoId, produtoIds[1..50], acao: 'pausar'|'reativar', linkDocId? }`.
 * Requires `PERM.integracao.write`, the same bit as `publicar` and
 * `reverificar-anuncio`.
 *
 * `linkDocId` narrows the run to ONE listing — the produto tab's per-anúncio
 * button — and requires exactly one `produtoId`. Without it the run covers every
 * listing the selected produtos hold on that conta, which is the produtos-table
 * bulk action.
 *
 * SYNCHRONOUS by design: the work is bounded at `unlist_item`'s own `item_list`
 * size by construction, so it needs neither a job document nor a poll route.
 *
 * ## ⚠️ A per-listing refusal is DATA, not an error
 *
 * A well-formed request answers **200 even when every single listing was
 * refused** — a listing already paused, one Shopee has banned, one locked by a
 * running promotion. The 4xx ladder below is only for what stops the WHOLE
 * request. Collapsing the two would hide fifty different reasons behind one
 * status code the operator cannot act on.
 *
 * ## ⚠️ Oversize and the one-produto rule are refused HERE, by the body reader
 *
 * The orchestrator asserts both as caller bugs and raises a config-class error,
 * which `respond.ts` maps to a 500 — the wrong answer for an operator who
 * selected too many rows. So `lerCorpoAnuncioStatus` refuses first, on the
 * DEDUPED count, and never truncates.
 *
 * ## ⚠️ Shopee's DAILY quota is a 200, not a 5xx
 *
 * A burst rate limit propagates and `shopeeErrorResponse` maps it. A daily quota
 * does not: the orchestrator turns it into `pausadoAte`, the instant the quota
 * rolls over, on an otherwise ordinary response — because "try again in a
 * moment" and "try again tomorrow" are different instructions.
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  corpoDeErroAnuncioStatus,
  lerCorpoAnuncioStatus,
} from '@/lib/shopee/anuncios/corpoPublicacao';
import { definirStatusAnunciosShopee } from '@/lib/shopee/anuncios/pausarAnuncio';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return NextResponse.json(corpoDeErroAnuncioStatus(json), { status: 400 });
  const corpo = lerCorpoAnuncioStatus(json.valor);
  if (!corpo.ok) return NextResponse.json(corpoDeErroAnuncioStatus(corpo), { status: 400 });
  const { integracaoId, produtoIds, acao, linkDocId } = corpo.valor;

  // ONE clock read for the whole request, handed down. `pausadoAte` is derived
  // from it by pure arithmetic, so the instant a caller is told to wait for and
  // the instant the run was stamped with cannot disagree.
  const nowMs = Date.now();

  try {
    const resposta = await definirStatusAnunciosShopee(
      getAdminFirestore(),
      { integracaoId, produtoIds, acao, linkDocId },
      // `increment` is wrapped rather than passed by reference so the sentinel
      // is built at call time by the caller that owns the firebase-admin import
      // — the `functions/src/index.ts` idiom, kept identical here.
      { increment: (by: number) => FieldValue.increment(by), nowMs },
    );

    // Built by NAME at BOTH levels. The top-level envelope alone is not enough:
    // a key added to a per-listing row would still leave through the body, and
    // these rows carry the listing's raw read-back status and its motivo
    // vocabulary. Every field below is one the operator's table renders.
    return NextResponse.json({
      canal: resposta.canal,
      integracaoId: resposta.integracaoId,
      acao: resposta.acao,
      solicitados: resposta.solicitados,
      familias: resposta.familias,
      resumo: {
        aplicados: resposta.resumo.aplicados,
        pulados: resposta.resumo.pulados,
        falhas: resposta.resumo.falhas,
        naoTentados: resposta.resumo.naoTentados,
      },
      listings: resposta.listings.map((l) => ({
        produtoId: l.produtoId,
        produtoNome: l.produtoNome,
        anuncioId: l.anuncioId,
        linkDocId: l.linkDocId,
        outcome: l.outcome,
        motivo: l.motivo,
        mensagem: l.mensagem,
        statusFinal: l.statusFinal,
        estadoAnuncio: l.estadoAnuncio,
        membros: l.membros,
      })),
      produtosSemAnuncio: resposta.produtosSemAnuncio.map((p) => ({
        produtoId: p.produtoId,
        produtoNome: p.produtoNome,
        motivo: p.motivo,
        mensagem: p.mensagem,
      })),
      pausadoAte: resposta.pausadoAte,
    });
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}
