/**
 * `POST /api/marketplace/shopee/enviar-estoque` — push the CURRENT stock of a
 * hand-picked set of produtos to their Shopee listings, right now. Body:
 * `{ integracaoId, produtoIds[1..50], reenviarComErro? }`. Requires
 * `PERM.integracao.write`, the same bit as `publicar`, `anuncio-status` and
 * `reverificar-anuncio`.
 *
 * Until this route existed the only thing that ever sent a quantity to Shopee
 * was the `sendShopeeStock` queue, fed exclusively by the three scheduled
 * sweeps: a wrong number could only be fixed by waiting a quarter of an hour,
 * or until the nightly pass.
 *
 * SYNCHRONOUS by design: the acceptance is a per-LISTING outcome and the work is
 * bounded at 50 produtos by construction, so it needs neither a job document nor
 * a poll route.
 *
 * ## ⚠️ A per-listing refusal is DATA, not an error
 *
 * A well-formed request answers **200 even when every single listing failed** —
 * a listing Shopee has removed, one a promotion holds, one whose models were
 * refused. The 4xx ladder below is only for what stops the WHOLE request.
 * Collapsing the two hides fifty different reasons behind one status code the
 * operator cannot act on.
 *
 * ## ⚠️ Oversize is refused HERE, on the DEDUPED count, and never truncated
 *
 * The module asserts the bound and raises a config-class error above it, which
 * `respond.ts` maps to a 500 — "server misconfig", the wrong answer for an
 * operator who selected too many rows. So the count is checked first, and 51 ids
 * of which 50 are distinct is a request this ACCEPTS.
 *
 * ## ⚠️ Three different 50s exist and collapsing them is the trap
 *
 * The per-call model bound, the batch bound of the listing-lifecycle route and
 * this one — produtos per request — are numerically equal today and semantically
 * unrelated. This route reads `SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS` and nothing
 * else.
 *
 * ## ⚠️ The pause pre-check runs BEFORE any Shopee call
 *
 * A paused conta must cost zero provider calls, so the state document is read —
 * and the client is built — only after it. The send handler's own gate remains
 * the backstop for a pause armed by a concurrent queue task mid-request.
 *
 * ## ⚠️ Shopee's DAILY quota is a 200, not a 5xx
 *
 * A burst rate limit that escapes the run propagates and `shopeeErrorResponse`
 * maps it; a daily one does not — the run turns it into `pausadoAte` on an
 * otherwise ordinary response, because "try again in a moment" and "try again
 * tomorrow" are different instructions.
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  CODIGO_SELECAO_EXCEDE_LIMITE,
  CODIGO_SELECAO_INVALIDA,
  MSG_SELECAO_INVALIDA,
  naoDocId,
} from '@/lib/shopee/anuncios/corpoPublicacao';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS } from '@/lib/shopee/estoque/constantesEstoque';
import { enviarEstoqueManualShopee } from '@/lib/shopee/estoque/enviarEstoqueManual';
import {
  CODIGO_GUARDA_ENVIO,
  MENSAGEM_POR_MOTIVO,
  MOTIVO_ESTOQUE_SHOPEE,
  ShopeeEnvioEstoqueGuardError,
} from '@/lib/shopee/estoque/errosEstoque';
import { estaPausada, lerEstadoEstoque } from '@/lib/shopee/estoque/estadoEstoque';
import { MSG_BODY_INVALIDO, lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The one sentence an unusable `integracaoId` gets.
 *
 * ⚠️ Written here rather than imported: the listing-lifecycle reader builds the
 * same sentence from a module-private helper, and exporting that helper to share
 * one string would widen a shipped surface. Only {@link naoDocId} — the RULE —
 * is shared, which is the half that can actually drift into a security problem.
 */
const MSG_INTEGRACAO_ID_INVALIDO = 'integracaoId deve ser um id de documento (sem "/" nem "..").';

/** The sentence a non-boolean `reenviarComErro` gets. */
const MSG_REENVIAR_INVALIDO = 'reenviarComErro deve ser booleano.';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return NextResponse.json({ error: json.erro }, { status: 400 });

  // `req.json()` legally yields null, arrays and scalars — those are 400s, not
  // 500s.
  const bruto = json.valor;
  if (bruto === null || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return NextResponse.json({ error: MSG_BODY_INVALIDO }, { status: 400 });
  }
  const body = bruto as Record<string, unknown>;

  // TYPE-checked and never truthiness-checked: a non-string that happens to be
  // truthy sails past a `!value` guard and then throws deep inside `.doc(id)` —
  // a 500 for what is plainly a client error.
  if (naoDocId(body['integracaoId'])) {
    return NextResponse.json({ error: MSG_INTEGRACAO_ID_INVALIDO }, { status: 400 });
  }
  const integracaoId = body['integracaoId'] as string;

  const ids = body['produtoIds'];
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => naoDocId(id))) {
    return NextResponse.json(
      { error: MSG_SELECAO_INVALIDA, code: CODIGO_SELECAO_INVALIDA },
      { status: 400 },
    );
  }

  // DEDUPED, request order KEPT: the per-listing rows come back in this order
  // and `solicitados` counts exactly this list.
  const vistos = new Set<string>();
  const produtoIds: string[] = [];
  for (const id of ids as string[]) {
    if (vistos.has(id)) continue;
    vistos.add(id);
    produtoIds.push(id);
  }

  // ⚠️ REJECT, never truncate, and on the DEDUPED count. Silently dropping the
  // tail under a green summary is the failure this whole area exists to prevent.
  if (produtoIds.length > SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS) {
    return NextResponse.json(
      {
        error: `Selecione no máximo ${String(SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS)} produtos para enviar o estoque.`,
        code: CODIGO_SELECAO_EXCEDE_LIMITE,
        limite: SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS,
        solicitados: produtoIds.length,
      },
      { status: 400 },
    );
  }

  const reenviar = body['reenviarComErro'];
  if (reenviar !== undefined && typeof reenviar !== 'boolean') {
    return NextResponse.json({ error: MSG_REENVIAR_INVALIDO }, { status: 400 });
  }
  const reenviarComErro = reenviar === true;

  // ONE clock read for the whole request, handed down as the logical instant.
  // Everything derived from it — the per-link skip set, the task stamps, the
  // pause verdict — therefore agrees with itself. The ELAPSED clock is a
  // separate, injected reader: the run's deadline must not be measured against a
  // value tests pin.
  const nowMs = Date.now();
  const db = getAdminFirestore();

  try {
    const ctx = await loadShopeeContext(db, integracaoId);

    const estado = await lerEstadoEstoque(db, integracaoId);
    if (estaPausada(estado, nowMs)) {
      throw new ShopeeEnvioEstoqueGuardError(
        CODIGO_GUARDA_ENVIO.contaPausada,
        MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.contaPausada],
        { pausadoAte: new Date(estado.pausadoAte ?? nowMs).toISOString() },
      );
    }

    const depositoRef = ctx.conta.depositoOuterRef;
    if (typeof depositoRef !== 'string' || depositoRef.trim() === '') {
      throw new ShopeeEnvioEstoqueGuardError(
        CODIGO_GUARDA_ENVIO.contaSemDeposito,
        MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.semDeposito],
      );
    }

    const resposta = await enviarEstoqueManualShopee(
      db,
      { integracaoId, produtoIds, reenviarComErro },
      {
        nowMs,
        agora: () => Date.now(),
        esperar: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        conta: ctx.conta as unknown as Readonly<Record<string, unknown>>,
        contaNome: typeof ctx.conta.nome === 'string' ? ctx.conta.nome : null,
        // Built AFTER the pause pre-check: a paused conta must not even mint a
        // shop-signed client.
        client: ctx.createShopClient(),
        // Wrapped rather than passed by reference so the sentinel is built at
        // call time by the caller that owns the firebase-admin import.
        increment: (by: number) => FieldValue.increment(by),
      },
    );

    // Built by NAME at BOTH levels. The envelope alone is not enough: a key
    // added to a per-listing row would still leave through the body, and these
    // rows carry the provider's own per-model attribution.
    return NextResponse.json({
      canal: resposta.canal,
      integracaoId: resposta.integracaoId,
      contaNome: resposta.contaNome,
      solicitados: resposta.solicitados,
      familias: resposta.familias,
      resumo: {
        enviados: resposta.resumo.enviados,
        pulados: resposta.resumo.pulados,
        falhas: resposta.resumo.falhas,
        naoTentados: resposta.resumo.naoTentados,
      },
      listings: resposta.listings.map((l) => ({
        produtoId: l.produtoId,
        produtoNome: l.produtoNome,
        variacaoProdutoId: l.variacaoProdutoId,
        anuncioId: l.anuncioId,
        linkDocId: l.linkDocId,
        outcome: l.outcome,
        motivo: l.motivo,
        mensagem: l.mensagem,
        quantidade: l.quantidade,
        variacoes: l.variacoes.map((m) => ({
          modelId: m.modelId,
          produtoId: m.produtoId,
          varLinkDocId: m.varLinkDocId,
          quantidadeSolicitada: m.quantidadeSolicitada,
          quantidadeEnviada: m.quantidadeEnviada,
          resultado: m.resultado,
          motivo: m.motivo,
          codigo: m.codigo,
          mensagem: m.mensagem,
          clampado: m.clampado,
          piso: m.piso,
        })),
        modelosRecusados: l.modelosRecusados,
        clampados: l.clampados,
        rearme: l.rearme,
      })),
      produtosSemEnvio: resposta.produtosSemEnvio.map((p) => ({
        produtoId: p.produtoId,
        produtoNome: p.produtoNome,
        motivo: p.motivo,
        mensagem: p.mensagem,
      })),
      pausadoAte: resposta.pausadoAte,
    });
  } catch (err) {
    if (err instanceof ShopeeEnvioEstoqueGuardError) {
      return NextResponse.json(
        { error: err.message, code: err.code, ...err.extra },
        { status: err.status },
      );
    }
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}
