/**
 * `POST /api/marketplace/shopee/enviar-precos` — push the CURRENT tabela price
 * of a hand-picked set of produtos to their Shopee listings, right now (#1521,
 * step 13). Body: `{ integracaoId, produtoIds[1..50], baixarPreco? }`. Requires
 * `PERM.integracao.write`, the same bit as `enviar-estoque` and `publicar`.
 *
 * SYNCHRONOUS by design, the twin of step 12's `enviar-estoque`: the work is
 * bounded at 50 produtos and the acceptance is a per-MODEL outcome, so it needs
 * neither a job document nor a poll route. The account-wide price update is a
 * separate, job-shaped route.
 *
 * ## ⚠️ A per-item refusal is DATA, not an error
 *
 * A well-formed request answers **200 even when every row failed** — and even
 * when the run was cut short by a quota pause or a conta-wide fatal (a dead
 * grant, a penalty): the rows that already landed keep their outcome, the rest
 * answer `nao-tentado` with the reason, and a pause stamps `pausadoAte`. The 4xx
 * ladder below is only for what stops the WHOLE request before any item.
 *
 * ## The ladder, in order — and why each rung sits where it does
 *
 * 1. `verifyCaller` → 2. a JSON body → 3. an object → 4. `integracaoId` a
 * document id → 5. `produtoIds` non-empty, each a document id (400
 * `SHOPEE_SELECAO_INVALIDA`) → 6. DEDUPE, request order kept → 7. over
 * `SHOPEE_ENVIO_PRECO_MAX_PRODUTOS` on the DEDUPED count ⇒ 400
 * `SHOPEE_SELECAO_EXCEDE_LIMITE` with `limite` and `solicitados` — REJECTED,
 * never truncated, and 51 ids of which 50 are distinct are ACCEPTED → 8.
 * `baixarPreco` a boolean or absent — absent is `false`: lowering a price is an
 * explicit act, the web dialog sends `true` itself → 9. ONE clock read → 10.
 * the conta (404 when missing or not a Shopee conta) → 11. a blank
 * `tabelaNormalOuterRef` ⇒ 400 `SHOPEE_CONTA_SEM_TABELA_NORMAL` → 12. the
 * conta's QUOTA pause ⇒ 409 `SHOPEE_CONTA_PAUSADA` + `pausadoAte` → 13. the
 * conta verdict ⇒ 422 `SHOPEE_PRECO_CONTA_RECUSADA` `{motivo, mensagem,
 * regiao?}` (its `sem-tabela-normal` rung is the 400 of rung 11) → 14. the run
 * ⇒ 200, built BY NAME at every level.
 *
 * Rungs 10–13 are ONE call, `exigirContaParaPreco` (`precos/regiaoPreco.ts`) —
 * the conta ladder the job's start (`atualizar-precos`) runs too. It lives in
 * one place so the two buttons cannot drift apart on the same conta; this
 * route keeps only its body rungs, its catch and the run.
 *
 * ⚠️ **Rungs 11–12 cost ZERO provider calls and build NO client.** The pause is
 * the stock sync's, READ and never written, and only its two QUOTA motives stop
 * a price push (a holiday stock pause does not). The verdict (rung 13) is where
 * the one cached `get_shop_info` happens — so a paused conta mints no token and
 * a refused conta reaches no item.
 *
 * ## ⚠️ 422 for the verdict, where step 12 answers rows
 *
 * The stock push reports a cross-border or holiday shop per listing, because it
 * force-sends by design. The price region gate is different in kind: an
 * ERP-side, pre-call refusal that no force-send may bypass — a reais figure sent
 * to a shop pricing in another currency is a wrong price Shopee accepts with a
 * 200. So a refused conta answers ONE 422 with the motivo, rendered, and never
 * fifty identical rows.
 *
 * ## Errors
 *
 * `ShopeeEnvioPrecoGuardError` FIRST, at its derived status (it extends the
 * package's base, and the generic arm would answer it as a generic failure); then
 * `isShopeeError` ⇒ `shopeeErrorResponse`; anything else rethrows (rule 6).
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  CODIGO_SELECAO_EXCEDE_LIMITE,
  CODIGO_SELECAO_INVALIDA,
  MSG_SELECAO_INVALIDA,
  naoDocId,
} from '@/lib/shopee/anuncios/corpoPublicacao';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { SHOPEE_ENVIO_PRECO_MAX_PRODUTOS } from '@/lib/shopee/precos/constantesPreco';
import { enviarPrecoManualShopee } from '@/lib/shopee/precos/enviarPrecoManual';
import { ShopeeEnvioPrecoGuardError } from '@/lib/shopee/precos/errosPreco';
import { avaliarContaParaPreco, exigirContaParaPreco } from '@/lib/shopee/precos/regiaoPreco';
import { MSG_BODY_INVALIDO, lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The one sentence an unusable `integracaoId` gets — `enviar-estoque`'s, and
 * written here for that route's reason: only {@link naoDocId}, the RULE, is
 * shared.
 */
const MSG_INTEGRACAO_ID_INVALIDO = 'integracaoId deve ser um id de documento (sem "/" nem "..").';

/** The sentence a non-boolean `baixarPreco` gets. */
const MSG_BAIXAR_PRECO_INVALIDO = 'baixarPreco deve ser booleano.';

/** The log tag of this route. */
const TAG_LOG = '[shopee/precos] enviar-precos';

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

  // TYPE-checked, never truthiness-checked: a truthy non-string would throw deep
  // inside `.doc(id)` — a 500 for a client error.
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

  // DEDUPED, request order KEPT: the rows come back in this order and
  // `solicitados` counts exactly this list.
  const produtoIds = [...new Set(ids as string[])];

  // ⚠️ REJECT, never truncate, and on the DEDUPED count. Silently dropping the
  // tail under a green summary is the failure this whole area exists to prevent.
  if (produtoIds.length > SHOPEE_ENVIO_PRECO_MAX_PRODUTOS) {
    return NextResponse.json(
      {
        error: `Selecione no máximo ${String(SHOPEE_ENVIO_PRECO_MAX_PRODUTOS)} produtos para enviar o preço.`,
        code: CODIGO_SELECAO_EXCEDE_LIMITE,
        limite: SHOPEE_ENVIO_PRECO_MAX_PRODUTOS,
        solicitados: produtoIds.length,
      },
      { status: 400 },
    );
  }

  // Absent ⇒ FALSE: a lower price is sent only when the caller says so.
  const baixar = body['baixarPreco'];
  if (baixar !== undefined && typeof baixar !== 'boolean') {
    return NextResponse.json({ error: MSG_BAIXAR_PRECO_INVALIDO }, { status: 400 });
  }
  const baixarPreco = baixar === true;

  // ONE clock read for the whole request, handed down as the logical instant:
  // the pause verdict, the shop-info cache and every stamp the sender writes
  // agree with themselves. The ELAPSED clock is a separate, injected reader —
  // the run's deadline must not be measured against a value tests pin.
  const nowMs = Date.now();
  const db = getAdminFirestore();

  try {
    // Rungs 10–13: the ONE conta ladder, shared with `atualizar-precos`.
    const { ctx, contexto } = await exigirContaParaPreco(db, integracaoId, {
      nowMs,
      tagLog: TAG_LOG,
      avaliar: avaliarContaParaPreco,
    });

    const resposta = await enviarPrecoManualShopee(
      db,
      { integracaoId, produtoIds, baixarPreco },
      {
        nowMs,
        agora: () => Date.now(),
        esperar: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        contexto,
        contaNome: typeof ctx.conta.nome === 'string' ? ctx.conta.nome : null,
      },
    );

    // Built by NAME at every level: a key added to a row upstream must not leave
    // through the body, and the rows carry Shopee's own words in `codigo`.
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
        preco: l.preco,
        precoAnterior: l.precoAnterior,
        variacoes: l.variacoes,
        codigo: l.codigo,
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
    // ⚠️ FIRST: the guard class extends the package's base, and the arm below
    // would answer it as a generic Shopee failure instead of its own status.
    if (err instanceof ShopeeEnvioPrecoGuardError) {
      return NextResponse.json(
        { error: err.message, code: err.code, ...err.extra },
        { status: err.status },
      );
    }
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}
