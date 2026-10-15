/**
 * `GET /api/marketplace/shopee/reclamacao/estado?integracaoId=&returnSn=` — the
 * LIVE state of one Shopee return for the pedido's reclamação panel (#1525,
 * step 17): status, amounts, deadlines (ms), the offerable solutions, and
 * `acoesDisponiveis` from THE gate (`devolucoes/estadoDevolucao.ts`) — the web
 * holds no copy of that rule (#1369). The ML twin is
 * `apps/mercado-livre/app/api/marketplace/mercado-livre/reclamacao/estado/route.ts`.
 *
 * ⚠️ **Live on every call, never cached** — `Cache-Control: no-store` on EVERY
 * answer, errors included. What the seller may do moves as the buyer and
 * Shopee act; a cached list would offer a button for an action Shopee already
 * withdrew. At most TWO Shopee reads (`get_return_detail`, then
 * `get_available_solutions` only while a status leaves the actions open), ZERO
 * Firestore writes — the code-29 importer is the incidente's single writer.
 *
 * ⚠️ Gated on `PERM.incidenteResolucao.read`, not `pedido.read`: it reaches
 * Shopee on the seller's account and answers return detail (the ML route's
 * reasoning).
 *
 * ## The ladder
 *
 * 1. `verifyCaller` → 2. `integracaoId` given ONCE and a non-blank document id → 3.
 * `returnSn` given ONCE and `ehReturnSnShopee` (alphanumeric, 1..64, NOT
 * trimmed — the one shared predicate, R-18). Either refusal is 400
 * `SHOPEE_RECLAMACAO_QUERY_INVALIDA` before the conta loads; a repeated
 * parameter is refused rather than resolved by position.
 *
 * ## Errors — Shopee's own sentence reaches no body and no log
 *
 * - A Shopee refusal (`ShopeeApiError` of kind `other`) that
 *   `classificarRecusaDevolucaoShopee` reads as `devolucao-inexistente` ⇒ 404
 *   `SHOPEE_RECLAMACAO_INEXISTENTE` with OUR sentence.
 * - ANY other kind-`other` refusal — an unknown code, `error_param`, an
 *   `error_data` sentence the table does not know — ⇒ 502
 *   `SHOPEE_RECLAMACAO_FALHA_SHOPEE` `{ codigoShopee }`, the `acao` route's
 *   code and shape, with OUR sentence. A read has no remedy to offer, so the
 *   classifier's other motivos are logged, never answered as a 409.
 * - The other kinds (re-auth, rate limits, Shopee's transients) keep
 *   `shopeeErrorResponse`'s status and code, but through
 *   `devolucoes/respostaReclamacao.ts`'s `semFraseDaShopee`: the package builds EVERY envelope error's
 *   `message` as `Shopee <path> respondeu <code> (HTTP n) — <Shopee's
 *   sentence>`, and the mapper logs and returns `message` verbatim.
 * - Every other class `isShopeeError` names (the network, a non-envelope HTTP
 *   answer, a schema drift, the conta and its credential) carries OUR sentence
 *   only ⇒ `shopeeErrorResponse` unchanged. Anything else rethrows (rule 6).
 *
 * The side read's "no offer is possible" refusals already degrade to
 * `solucoes: []` inside `lerEstadoDevolucaoShopee`.
 *
 * Logs: `lerEstadoDevolucaoShopee` writes the ONE line of a healthy read (ids,
 * the status token, each envelope's raw `error`); this route adds one line for
 * the 404 and the 502 — ids, the motivo and the code through `codigoSeguro`,
 * never Shopee's sentence.
 */
import { NextResponse } from 'next/server';
import { SHOPEE_ERROR_KIND, ShopeeApiError } from '@delfrance/integrations-shopee';
import { RETURN_SN_SHOPEE_MAX, ehReturnSnShopee } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { naoDocId } from '@/lib/shopee/anuncios/corpoPublicacao';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { lerEstadoDevolucaoShopee } from '@/lib/shopee/devolucoes/acoesDevolucao';
import {
  FRASE_RECUSA_DEVOLUCAO,
  MOTIVO_RECUSA_DEVOLUCAO,
  classificarRecusaDevolucaoShopee,
} from '@/lib/shopee/devolucoes/recusaDevolucao';
import {
  CODIGO_FALHA_SHOPEE,
  CODIGO_INEXISTENTE,
  semFraseDaShopee,
} from '@/lib/shopee/devolucoes/respostaReclamacao';
import { codigoSeguro } from '@/lib/shopee/nfe/redacaoNfe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Both 400s of the query ladder. */
export const CODIGO_QUERY_INVALIDA = 'SHOPEE_RECLAMACAO_QUERY_INVALIDA';

/**
 * The 404 and the 502 — ONE spelling each, shared with the `acao` route
 * through `devolucoes/respostaReclamacao.ts`.
 */
export { CODIGO_FALHA_SHOPEE, CODIGO_INEXISTENTE };

/** The 502's sentence on this READ — ours; Shopee's own text never reaches the operator. */
export function msgFalhaNaLeitura(codigoShopee: string | null): string {
  return codigoShopee === null
    ? 'A Shopee recusou a leitura da devolução (código não informado).'
    : `A Shopee recusou a leitura da devolução (código ${codigoShopee}).`;
}

export const MSG_INTEGRACAO_ID_INVALIDO =
  'integracaoId é obrigatório (uma vez só) e deve ser um id de documento não vazio (sem "/" nem "..").';

export const MSG_RETURN_SN_INVALIDO = `returnSn é obrigatório (uma vez só) e deve ser o número da devolução na Shopee (letras e dígitos, de 1 a ${String(RETURN_SN_SHOPEE_MAX)} caracteres).`;

/** The value of a parameter given EXACTLY once, else `null`. */
function umValor(params: URLSearchParams, nome: string): string | null {
  const valores = params.getAll(nome);
  return valores.length === 1 ? (valores[0] ?? null) : null;
}

function queryInvalida(error: string): NextResponse {
  return NextResponse.json({ error, code: CODIGO_QUERY_INVALIDA }, { status: 400 });
}

async function responder(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.incidenteResolucao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = umValor(params, 'integracaoId');
  // ⚠️ Blank too: `naoDocId(' ')` is false, while the module refuses a blank id
  // with a `RangeError` (a 500) — the ladder must be at least as strict.
  if (integracaoId === null || naoDocId(integracaoId) || integracaoId.trim() === '') {
    return queryInvalida(MSG_INTEGRACAO_ID_INVALIDO);
  }
  const returnSn = umValor(params, 'returnSn');
  if (!ehReturnSnShopee(returnSn)) return queryInvalida(MSG_RETURN_SN_INVALIDO);

  const db = getAdminFirestore();
  try {
    const client = (await loadShopeeContext(db, integracaoId)).createShopClient();
    return NextResponse.json(
      await lerEstadoDevolucaoShopee({ client }, { integracaoId, returnSn }),
    );
  } catch (err) {
    // ⚠️ Kind `other` ONLY: a dead grant, a rate limit and Shopee's transients
    // are `ShopeeApiError`s too, and each keeps the mapper's answer below (409
    // re-auth, 502) — read as a refusal, a dead grant would never tell the
    // operator to reconnect.
    if (err instanceof ShopeeApiError && err.kind === SHOPEE_ERROR_KIND.other) {
      const motivo = classificarRecusaDevolucaoShopee(err);
      const codigoShopee = codigoSeguro(err.code);
      if (motivo === MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente) {
        console.warn('[shopee/devolucao] devolução inexistente na Shopee', {
          integracaoId,
          returnSn,
          codigo: codigoShopee,
        });
        return NextResponse.json(
          { error: FRASE_RECUSA_DEVOLUCAO[motivo], code: CODIGO_INEXISTENTE },
          { status: 404 },
        );
      }
      console.warn('[shopee/devolucao] leitura recusada pela Shopee', {
        integracaoId,
        returnSn,
        motivo,
        codigo: codigoShopee,
      });
      return NextResponse.json(
        { error: msgFalhaNaLeitura(codigoShopee), code: CODIGO_FALHA_SHOPEE, codigoShopee },
        { status: 502 },
      );
    }
    if (err instanceof ShopeeApiError) return shopeeErrorResponse(semFraseDaShopee(err));
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const res = await responder(req);
  // EVERY answer — a cached 409 or 404 would outlive the state it describes.
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
