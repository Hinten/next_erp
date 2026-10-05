/**
 * `POST /api/marketplace/shopee/enviar-nfe` — re-drive the NF-e upload of ONE
 * Shopee pedido (#1522, step 14): re-run the upload's pre-network gates and
 * ENQUEUE one task on the NF-e queue. Body: `{ pedidoId, nfeId? }` — strict.
 * Answers 202 `{ enfileirado, pedidoId, nfeId, atrasoSegundos }`.
 *
 * It exists for the documents the approval trigger never enqueued: the queue
 * valve was shut, the trigger's delivery was lost, the NF-e arrived with the
 * migrated corpus (an import fires no trigger), or step 15 met
 * `lack_of_invoice_data` at `ship_order`. There is no NF-e sweep, so this route
 * and the `enviar:nfe` CLI are the only ways back.
 *
 * ## ⚠️ Enqueue-only: zero writes, zero Shopee calls, no client, no token
 *
 * Every Shopee decision — what the order already holds, the upload, the
 * read-back, the recheck — is the TASK's (`nfe/processarNfe.ts`). The route
 * reads three things (the pedido, the conta through the cached reader, the NF-e
 * slot) and never `loadShopeeContext`: that reads the partner configuration,
 * and a later refactor would build a client from it. An eligible document
 * ALWAYS answers 202, even when Shopee already holds our key — the task's
 * pre-read answers `ja-enviado` and closes any open aviso, the clean no-op a
 * repeated re-drive needs.
 *
 * ## Auth — `PERM.pedido.write`, not the `integracao` bit every other route uses
 *
 * `verifyCaller(req, PERM.pedido.write)` enforces it (`lib/auth/verifyCaller.ts`,
 * the app's one bearer-token helper). The callers are expedição staff on a
 * pedido screen and step 15's label flow, and the action is pedido-scoped —
 * send THIS pedido's note. Mercado Livre's `enviar-nfe` made the same choice
 * for the same population.
 *
 * ## The ladder — every body rung before any read
 *
 * 1. `verifyCaller` (401/403/500 from the helper) → 2. a JSON body → 3. an
 * object → 4. `pedidoId` a document id → 5. `nfeId` absent/`null` or a document
 * id → 6. no OTHER key: the task payload is BUILT BY NAME, so a body `fase` (or
 * a counter) is refused here rather than silently dropped → 7. ONE clock read.
 *
 * ## The re-drive — `nfe/reenvioNfe.ts`, shared with the label route
 *
 * Everything after the clock read is `reenviarNfeDoPedidoShopee` (step 15,
 * #1523, extracted it VERBATIM so the label route runs the same ladder); this
 * route maps its union to the HTTP answers below, and its unedited
 * `route.test.ts` is the proof the move changed nothing.
 *
 * The gates run in the handler's own order (ownership BEFORE the NF-e — the
 * reconcile's R-n), each through the SAME pure predicate the trigger and the
 * handler run; `nao-elegivel` answers 409 `SHOPEE_NFE_NAO_ELEGIVEL` with the
 * motivo and its one sentence from `nfe/errosNfe.ts`:
 *
 * 8. the pedido, raw, and `avaliarPedidoParaNfeShopee` — the id must recompute
 *    from `(conta, order_sn)`; `emissao-bloqueada` refuses too;
 * 9. the conta through `readConta` + `avaliarContaParaNfeShopee` (missing or of
 *    another tipo, or `ativo !== true`);
 * 10. the slot. An explicit `nfeId` is read (absent ⇒ 404
 *    `SHOPEE_NFE_NAO_ENCONTRADA`, with the route's OWN sentence — nothing was
 *    scheduled, so the handler's P1 wording would mislead) and judged by the
 *    shared LEVEL predicate — never the transition one: a re-drive is for a
 *    document that is ALREADY ready, exactly the population a transition gate
 *    would refuse — and then by the sale gate. Without one, the pedido's NF-e
 *    documents are LISTED and `escolherNfeParaEnvioShopee` picks the slot (the
 *    same rule the CLI runs). A proc ILLEGIBLE TO THE SALE GATE passes on
 *    purpose: the handler answers it with an aviso and the frete stamp the
 *    operator sees, and a 409 here would hide both. That is the sale gate only:
 *    an unreadable `<tpAmb>` is refused one rung earlier by the shared level
 *    predicate, as `tpamb-homologacao`.
 *
 * ## The SERPRO wait — only when the authorization instant is KNOWN
 *
 * Shopee checks the note against the federal record, which lags SEFAZ by
 * minutes. A re-drive of a note whose authorization instant is RECORDED and
 * seconds old is held for what is left of the window (`atrasoSerproS`); an
 * older one is dispatched now. ⚠️ Only the migrated corpus records it: the
 * legacy app wrote `data_autorizacao`, while this ERP's NF-e app writes `null`
 * and never fills it (review 2, S1-1), so every post-cutover note is an UNKNOWN
 * instant. An unknown instant (null, absent or unreadable) is dispatched now,
 * and never refused: the helper would read it as "just authorized" and hold
 * every re-drive of it six minutes. An early upload of a fresh note is covered
 * by the handler instead — Shopee's case 5 ("not yet valid") becomes the #5
 * delayed self re-enqueue (`[600, 1800, 3600]`, no attempt spent). A zero wait
 * OMITS the option.
 *
 * ## Errors
 *
 * `ShopeeNfeUploadTasksDisabledError` (the NF-e queue's OWN valve class) ⇒
 * `desligado` ⇒ 503 `SHOPEE_NFE_ENFILEIRAMENTO_DESLIGADO` — there is no sweep
 * behind the queue, so the caller must see the outage. Anything else rethrows
 * out of the re-drive (rule 6): a Firestore failure on a read, a missing region,
 * a payload the schema refuses.
 *
 * ⚠️ PII: no response or log line carries the access key, the XML, the order
 * number or Shopee's text — the route never reads the key, and it has no
 * Shopee text to carry.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { naoDocId } from '@/lib/shopee/anuncios/corpoPublicacao';
import { mensagemDoMotivoNfe, type MotivoNfeShopee } from '@/lib/shopee/nfe/errosNfe';
import { reenviarNfeDoPedidoShopee } from '@/lib/shopee/nfe/reenvioNfe';
import { MSG_BODY_INVALIDO, lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The code of every eligibility refusal; the body carries the motivo. */
export const CODIGO_NFE_NAO_ELEGIVEL = 'SHOPEE_NFE_NAO_ELEGIVEL';

/** The code of an explicit `nfeId` with no document under the pedido. */
export const CODIGO_NFE_NAO_ENCONTRADA = 'SHOPEE_NFE_NAO_ENCONTRADA';

/** The code of the 503 the queue valve answers. */
export const CODIGO_ENFILEIRAMENTO_DESLIGADO = 'SHOPEE_NFE_ENFILEIRAMENTO_DESLIGADO';

/** The sentence an unusable `pedidoId` gets. */
export const MSG_PEDIDO_ID_INVALIDO = 'pedidoId deve ser um id de documento (sem "/" nem "..").';

/** The sentence an unusable `nfeId` gets. */
export const MSG_NFE_ID_INVALIDO =
  'nfeId, quando informado, deve ser um id de documento (sem "/" nem "..").';

/** The sentence a body with any other key gets — the payload is built by name. */
export const MSG_CAMPO_NAO_ACEITO = 'O corpo aceita apenas pedidoId e nfeId.';

/**
 * The sentence of the 404 — ours: the handler's `nfe-nao-encontrada` phrase
 * speaks of a note deleted AFTER an upload was scheduled, and here nothing was.
 */
export const MSG_NFE_NAO_ENCONTRADA =
  'A NF-e informada não foi encontrada neste pedido; nada foi agendado. ' +
  'Confira o nfeId, ou omita-o para que a NF-e aprovada do pedido seja escolhida.';

/** The sentence of the 503 — ours, never the valve class's environment wording. */
export const MSG_ENFILEIRAMENTO_DESLIGADO =
  'O envio de NF-e à Shopee está desligado nesta implantação; nada foi agendado. ' +
  'Tente de novo quando a fila for religada.';

/** The only keys the body may carry. */
const CHAVES_DO_CORPO: ReadonlySet<string> = new Set(['pedidoId', 'nfeId']);

/** The 409 — the motivo and its ONE sentence, built by name. */
function naoElegivel(motivo: MotivoNfeShopee): NextResponse {
  const mensagem = mensagemDoMotivoNfe(motivo);
  return NextResponse.json(
    { error: mensagem, code: CODIGO_NFE_NAO_ELEGIVEL, motivo, mensagem },
    { status: 409 },
  );
}

/** A 400 with one sentence. */
function corpoInvalido(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.pedido.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return corpoInvalido(json.erro);

  // `req.json()` legally yields null, arrays and scalars — those are 400s.
  const bruto = json.valor;
  if (bruto === null || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return corpoInvalido(MSG_BODY_INVALIDO);
  }
  const body = bruto as Record<string, unknown>;

  // TYPE-checked, never truthiness-checked: a `/` would address another
  // document, and a non-string would throw deep inside `.doc(id)` as a 500.
  if (naoDocId(body['pedidoId'])) return corpoInvalido(MSG_PEDIDO_ID_INVALIDO);
  const pedidoId = body['pedidoId'] as string;

  // Absent or `null` ⇒ the slot rule picks; anything else must be usable.
  const nfeIdBruto = body['nfeId'];
  if (nfeIdBruto != null && naoDocId(nfeIdBruto)) return corpoInvalido(MSG_NFE_ID_INVALIDO);
  const nfeIdPedido = nfeIdBruto == null ? null : (nfeIdBruto as string);

  // STRICT: a `fase` or a counter never reaches the queue, not even ignored.
  if (Object.keys(body).some((chave) => !CHAVES_DO_CORPO.has(chave))) {
    return corpoInvalido(MSG_CAMPO_NAO_ACEITO);
  }

  // The route's ONE clock read — the SERPRO wait's "now".
  const nowMs = Date.now();
  const db = getAdminFirestore();

  const r = await reenviarNfeDoPedidoShopee(db, { pedidoId, nfeId: nfeIdPedido, nowMs });
  switch (r.tipo) {
    case 'enfileirado':
      return NextResponse.json(
        { enfileirado: true, pedidoId, nfeId: r.nfeId, atrasoSegundos: r.atrasoSegundos },
        { status: 202 },
      );
    case 'nao-elegivel':
      return naoElegivel(r.motivo);
    case 'nfe-nao-encontrada':
      return NextResponse.json(
        { error: MSG_NFE_NAO_ENCONTRADA, code: CODIGO_NFE_NAO_ENCONTRADA },
        { status: 404 },
      );
    case 'desligado':
      return NextResponse.json(
        { error: MSG_ENFILEIRAMENTO_DESLIGADO, code: CODIGO_ENFILEIRAMENTO_DESLIGADO },
        { status: 503 },
      );
    default: {
      // A fifth arm stops compiling here instead of falling through to a 2xx.
      const nunca: never = r;
      return nunca;
    }
  }
}
