/**
 * `POST /api/marketplace/shopee/reclamacao/acao` — run ONE seller action on a
 * Shopee return (#1525, step 17): `confirmar` (`confirm`), `ofertar` (`offer`)
 * or `aceitar-oferta` (`accept_offer`). Body — strict:
 * `{ integracaoId, pedidoId, returnSn, acao, solucao?, valorReembolsoMinor?,
 * valorExibidoMinor?, solucaoExibida? }`. Answers 200
 * `{ ok: true, acao, returnSn, atualizacao: 'enfileirada' | 'nao-enfileirada' }`.
 * The ML twin is `apps/mercado-livre/app/api/marketplace/mercado-livre/reclamacao/acao/route.ts`.
 *
 * ## ⚠️ Writes NOTHING to Firestore — the importer is the single writer
 *
 * The domain half (`devolucoes/acoesDevolucao.ts`) holds no `db`: it re-reads
 * the return LIVE, runs THE gate (`devolucoes/estadoDevolucao.ts`) on that read
 * and makes exactly one Shopee write. The incidente is the code-29 importer's
 * alone (rule 7, tier 0), so after a successful action this route enqueues ONE
 * synthetic code 29 (`origem: 'acao-vendedor'`, R-13) and the importer reflects
 * the action under its own watermark — an offer moves `negotiation_status`,
 * which no push ever reports. Its envelope stamp is the CLICK, in raw
 * milliseconds — never the day-floored stamp the poller uses: two actions on
 * one return in one day are two pointers.
 *
 * ⚠️ **A failed enqueue never 5xx's a DONE action.** Shopee already executed
 * it, so a 500 here would report a done action as a failure — at best an
 * uncertain one — and invite a second click. The known enqueue failures — the `SHOPEE_TASKS_DISABLED` valve, a
 * missing region (`SHOPEE_TASKS_REGION` ships blank until the functions
 * codebase deploys), a transient Cloud Tasks failure (the real scheduler names
 * it `ShopeeTasksTransientError`, #1759), a DEPLOY-shaped Admin SDK error the
 * scheduler hands back raw (`FirebaseFunctionsError` / `FirebaseAppError`:
 * a missing IAM grant, no queue in that region) and a gRPC-coded transport
 * failure — answer 200 `atualizacao: 'nao-enfileirada'` with one log line; the
 * 6-hourly `sweepShopeeReturns` is the backstop. Any other failure is a bug and
 * rethrows (rule 6) — even after the action.
 *
 * ## Auth — `PERM.incidenteResolucao.write`
 *
 * The ML route's bit, for the ML route's reason: these verbs move money and are
 * irreversible on Shopee's side, so they are not `pedido.write`.
 *
 * ## The ladder — every body rung before the conta loads
 *
 * 1. `verifyCaller` (401/403/500 from the helper) → 2. a JSON body → 3. an
 * object → 4. `integracaoId` and 5. `pedidoId` non-blank document ids → 6. `returnSn`
 * through `ehReturnSnShopee` (alphanumeric, 1..64, NOT trimmed — the one
 * shared predicate, R-18) → 7. `acao` ∈ the three → 8. the per-action keys:
 * `solucao` REQUIRED with `ofertar`, forbidden otherwise; `valorReembolsoMinor`
 * (integer centavos > 0, R-14) only with `ofertar`, absent ⇒ no amount is
 * proposed; `valorExibidoMinor` (centavos >= 0, or `null`) REQUIRED with
 * `confirmar` and `aceitar-oferta`, forbidden with `ofertar`; `solucaoExibida`
 * (a solution, or `null`) REQUIRED with `aceitar-oferta`, forbidden otherwise.
 * "Forbidden" means the KEY, whatever its value — `null` included → 9. no OTHER
 * key: the module's request is built BY NAME, so an unknown key is refused,
 * never ignored → 10. ONE clock read (the click). Every rung answers 400
 * `SHOPEE_RECLAMACAO_BODY_INVALIDO`, and no sentence carries a value.
 *
 * ⚠️ The module re-validates the same contract and throws `RangeError` on a
 * violation; this ladder is at least as strict, so a body that passed it never
 * reaches that throw (a test walks every valid shape to the write). Reaching
 * one is a bug and surfaces as a 500, never as a 409 read as Shopee's answer.
 *
 * ## Errors
 *
 * - `DevolucaoAcaoRecusadaError` (OUR gate on the live read, drift included —
 *   R-15) ⇒ 409 `SHOPEE_RECLAMACAO_ACAO_RECUSADA` `{ motivo, acoesDisponiveis }`.
 *   ⚠️ For `confirmar` / `aceitar-oferta` the list never names `ofertar` (the
 *   solutions are read only on the `ofertar` path); the panel refetches anyway.
 * - A Shopee refusal (`ShopeeApiError` of kind `other`) through
 *   `classificarRecusaDevolucaoShopee`: `devolucao-inexistente` ⇒ 404
 *   `SHOPEE_RECLAMACAO_INEXISTENTE`; any other motivo ⇒ 409
 *   `SHOPEE_RECLAMACAO_RECUSADA_PELA_SHOPEE` `{ motivo, codigoShopee }`;
 *   unclassified ⇒ 502 `SHOPEE_RECLAMACAO_FALHA_SHOPEE` `{ codigoShopee }` —
 *   a DEFINITE Shopee refusal, which the panel does not read as `incerto`.
 *   `error` is always OUR sentence (`FRASE_RECUSA_DEVOLUCAO`), never Shopee's.
 * - The other `ShopeeApiError` kinds (re-auth, rate limits, Shopee's
 *   transients) keep `shopeeErrorResponse`'s status and code, through
 *   `devolucoes/respostaReclamacao.ts`'s `semFraseDaShopee`: the package puts Shopee's sentence
 *   into EVERY envelope error's `message`, and the mapper logs and returns it.
 * - Everything else `isShopeeError` names (the network, a non-envelope HTTP
 *   answer, a schema drift, the conta and its credential) carries OUR sentence
 *   only ⇒ `shopeeErrorResponse` unchanged; anything else rethrows (rule 6).
 *
 * `codigoShopee` is the code VERBATIM — trimmed, NEVER segment-stripped (the
 * classifier's fold is for lookup only) — through `codigoSeguro`, the app's
 * one gate for a code that reaches a log or a body: a value that is not
 * token-shaped, or carries seven or more digits, is `null` rather than echoed.
 *
 * ⚠️ PII: the logs carry ids, the action, the motivo, the code and the write's
 * raw envelope `error` (`erroEnvelope`, register 231's instrument) — never a
 * Shopee sentence, an amount or anything about the buyer. The mapper's own
 * `[shopee/api]` line included: what it is handed carries no sentence.
 */
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { NextResponse } from 'next/server';
import { centavosDeReais, roundReais } from '@delfrance/core/money';
import { MissingRegionError } from '@delfrance/core/region';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  shopeeReturnSolutionSchema,
} from '@delfrance/integrations-shopee';
import { RETURN_SN_SHOPEE_MAX, ehReturnSnShopee } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { naoDocId } from '@/lib/shopee/anuncios/corpoPublicacao';
import { isGrpcCodedError } from '@/lib/shopee/core/containment';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import {
  DevolucaoAcaoRecusadaError,
  executarAcaoDevolucaoShopee,
  type PedidoDeAcaoDevolucao,
  type ResultadoAcaoDevolucao,
} from '@/lib/shopee/devolucoes/acoesDevolucao';
import {
  ACAO_DEVOLUCAO_SHOPEE,
  acaoDevolucaoShopeeSchema,
  type AcaoDevolucaoShopee,
} from '@/lib/shopee/devolucoes/estadoDevolucao';
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
import { notificacaoSinteticaDeDevolucao } from '@/lib/shopee/notificacoes/notificacaoSintetica';
import { MSG_BODY_INVALIDO, lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';
import {
  ShopeeTasksDisabledError,
  ShopeeTasksTransientError,
  createShopeeTaskScheduler,
} from '@/lib/shopee/shopeeTasks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* -------------------------------------------------------------------------- */
/*                              codes and sentences                            */
/* -------------------------------------------------------------------------- */

/** Every 400 of the body ladder. */
export const CODIGO_BODY_INVALIDO = 'SHOPEE_RECLAMACAO_BODY_INVALIDO';

/**
 * The 404 (Shopee does not know the return) and the 502 (a Shopee refusal the
 * classifier does NOT know) — ONE spelling each, shared with the `estado`
 * route through `devolucoes/respostaReclamacao.ts`.
 */
export { CODIGO_FALHA_SHOPEE, CODIGO_INEXISTENTE };

/** The 409 of OUR gate (drift included). */
export const CODIGO_ACAO_RECUSADA = 'SHOPEE_RECLAMACAO_ACAO_RECUSADA';

/** The 409 of a Shopee refusal the classifier knows. */
export const CODIGO_RECUSADA_PELA_SHOPEE = 'SHOPEE_RECLAMACAO_RECUSADA_PELA_SHOPEE';

export const MSG_INTEGRACAO_ID_INVALIDO =
  'integracaoId deve ser um id de documento não vazio (sem "/" nem "..").';

export const MSG_PEDIDO_ID_INVALIDO =
  'pedidoId deve ser um id de documento não vazio (sem "/" nem "..").';

export const MSG_RETURN_SN_INVALIDO = `returnSn deve ser o número da devolução na Shopee (letras e dígitos, de 1 a ${String(RETURN_SN_SHOPEE_MAX)} caracteres).`;

export const MSG_ACAO_INVALIDA = 'acao deve ser "confirmar", "ofertar" ou "aceitar-oferta".';

export const MSG_SOLUCAO_INVALIDA =
  'solucao é obrigatória com "ofertar" e deve ser "RETURN_REFUND" ou "REFUND".';

export const MSG_VALOR_REEMBOLSO_INVALIDO =
  'valorReembolsoMinor, quando informado, deve ser um número inteiro de centavos maior que zero.';

export const MSG_VALOR_EXIBIDO_INVALIDO =
  'valorExibidoMinor é obrigatório com "confirmar" e "aceitar-oferta" e deve ser um número inteiro de centavos (zero ou mais) ou null.';

export const MSG_SOLUCAO_EXIBIDA_INVALIDA =
  'solucaoExibida é obrigatória com "aceitar-oferta" e deve ser "RETURN_REFUND", "REFUND" ou null.';

/** A key the chosen action does not take — named, never its value. */
function msgCampoForaDaAcao(campo: string, acao: AcaoDevolucaoShopee): string {
  return `${campo} não é aceito com a ação "${acao}".`;
}

/** The sentence a body with any other key gets — the module's request is built by name. */
export const MSG_CAMPO_NAO_ACEITO =
  'O corpo aceita apenas integracaoId, pedidoId, returnSn, acao, solucao, valorReembolsoMinor, valorExibidoMinor e solucaoExibida.';

/** The 502's sentence — ours; Shopee's own text never reaches the operator. */
function msgFalhaShopee(codigoShopee: string | null): string {
  return codigoShopee === null
    ? 'A Shopee recusou a ação (código não informado).'
    : `A Shopee recusou a ação (código ${codigoShopee}).`;
}

/** The only keys the body may carry. */
const CHAVES_DO_CORPO: ReadonlySet<string> = new Set([
  'integracaoId',
  'pedidoId',
  'returnSn',
  'acao',
  'solucao',
  'valorReembolsoMinor',
  'valorExibidoMinor',
  'solucaoExibida',
]);

/** The log tag of this route — the importer's, so one grep follows a return end to end. */
const TAG_LOG = '[shopee/devolucao]';

/* -------------------------------------------------------------------------- */
/*                                 the body                                    */
/* -------------------------------------------------------------------------- */

type LeituraDoCorpo =
  | { readonly ok: true; readonly pedido: PedidoDeAcaoDevolucao }
  | { readonly ok: false; readonly erro: string };

const invalido = (erro: string): LeituraDoCorpo => ({ ok: false, erro });

/** Is the KEY present — whatever its value, `null` included? */
function tem(body: Record<string, unknown>, chave: string): boolean {
  return Object.hasOwn(body, chave);
}

/**
 * Not a usable document id: `naoDocId`'s rule PLUS a blank one. ⚠️ The blank arm
 * is load-bearing — `naoDocId(' ')` is false (Firestore accepts it), while the
 * module refuses a blank id with its `RangeError`, so without it a `pedidoId` of
 * spaces passed this ladder and answered 500 after the conta loaded.
 */
function idInvalido(v: unknown): boolean {
  return naoDocId(v) || (v as string).trim() === '';
}

/**
 * Integer centavos > 0 that survive the module's ONE conversion (R-14) —
 * `roundReais(minor / 100)` asserted back through `centavosDeReais`. Only past
 * ~3.5 × 10¹⁵ centavos does a safe integer fail it, and such a body is a 400
 * here rather than the module's `RangeError` (a 500).
 */
function ehValorDeReembolso(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isSafeInteger(v) &&
    v > 0 &&
    centavosDeReais(roundReais(v / 100)) === v
  );
}

/** An echo of what the panel showed: integer centavos >= 0, or `null` (nothing shown). */
function ehEcoDeValor(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
}

/**
 * Rungs 3–9 — the strict body, refused rung by rung with one sentence each,
 * and the module's request rebuilt BY NAME (an absent optional is no key at all).
 */
function lerCorpo(bruto: unknown): LeituraDoCorpo {
  // `req.json()` legally yields null, arrays and scalars — those are 400s.
  if (bruto === null || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return invalido(MSG_BODY_INVALIDO);
  }
  const body = bruto as Record<string, unknown>;

  // TYPE-checked, never truthiness-checked: a `/` would address another
  // document, and a non-string would throw deep inside `.doc(id)` as a 500.
  const integracaoId = body['integracaoId'];
  if (idInvalido(integracaoId)) return invalido(MSG_INTEGRACAO_ID_INVALIDO);
  const pedidoId = body['pedidoId'];
  if (idInvalido(pedidoId)) return invalido(MSG_PEDIDO_ID_INVALIDO);
  const returnSn = body['returnSn'];
  if (!ehReturnSnShopee(returnSn)) return invalido(MSG_RETURN_SN_INVALIDO);
  const acaoLida = acaoDevolucaoShopeeSchema.safeParse(body['acao']);
  if (!acaoLida.success) return invalido(MSG_ACAO_INVALIDA);
  const acao = acaoLida.data;

  const base = {
    integracaoId: integracaoId as string,
    pedidoId: pedidoId as string,
    returnSn,
    acao,
  };
  const proibida = (campo: string): LeituraDoCorpo | null =>
    tem(body, campo) ? invalido(msgCampoForaDaAcao(campo, acao)) : null;

  let pedido: PedidoDeAcaoDevolucao;
  switch (acao) {
    case ACAO_DEVOLUCAO_SHOPEE.confirmar: {
      const recusa =
        proibida('solucao') ?? proibida('valorReembolsoMinor') ?? proibida('solucaoExibida');
      if (recusa !== null) return recusa;
      // REQUIRED by construction: an absent key reads `undefined`, which the
      // reader refuses (JSON carries no `undefined` value of its own).
      const eco = body['valorExibidoMinor'];
      if (!ehEcoDeValor(eco)) return invalido(MSG_VALOR_EXIBIDO_INVALIDO);
      pedido = { ...base, valorExibidoMinor: eco };
      break;
    }
    case ACAO_DEVOLUCAO_SHOPEE.ofertar: {
      const recusa = proibida('valorExibidoMinor') ?? proibida('solucaoExibida');
      if (recusa !== null) return recusa;
      const solucao = shopeeReturnSolutionSchema.safeParse(body['solucao']);
      if (!solucao.success) return invalido(MSG_SOLUCAO_INVALIDA);
      if (!tem(body, 'valorReembolsoMinor')) {
        pedido = { ...base, solucao: solucao.data };
        break;
      }
      const valor = body['valorReembolsoMinor'];
      if (!ehValorDeReembolso(valor)) return invalido(MSG_VALOR_REEMBOLSO_INVALIDO);
      pedido = { ...base, solucao: solucao.data, valorReembolsoMinor: valor };
      break;
    }
    case ACAO_DEVOLUCAO_SHOPEE.aceitarOferta: {
      const recusa = proibida('solucao') ?? proibida('valorReembolsoMinor');
      if (recusa !== null) return recusa;
      // Both REQUIRED by construction, as under `confirmar`: `undefined` fails
      // each reader.
      const eco = body['valorExibidoMinor'];
      if (!ehEcoDeValor(eco)) return invalido(MSG_VALOR_EXIBIDO_INVALIDO);
      const solucaoExibida = body['solucaoExibida'];
      if (solucaoExibida === null) {
        pedido = { ...base, valorExibidoMinor: eco, solucaoExibida: null };
        break;
      }
      const exibida = shopeeReturnSolutionSchema.safeParse(solucaoExibida);
      if (!exibida.success) return invalido(MSG_SOLUCAO_EXIBIDA_INVALIDA);
      pedido = { ...base, valorExibidoMinor: eco, solucaoExibida: exibida.data };
      break;
    }
  }

  // STRICT: a key outside the contract is refused, never ignored.
  if (Object.keys(body).some((chave) => !CHAVES_DO_CORPO.has(chave))) {
    return invalido(MSG_CAMPO_NAO_ACEITO);
  }
  return { ok: true, pedido };
}

/** A 400 with one sentence and the route's code. */
function corpoInvalido(error: string): NextResponse {
  return NextResponse.json({ error, code: CODIGO_BODY_INVALIDO }, { status: 400 });
}

/* -------------------------------------------------------------------------- */
/*                                 the errors                                  */
/* -------------------------------------------------------------------------- */

/**
 * The failure of the action → its answer, or `null` for a failure this route
 * does not know — which the caller's catch RETHROWS (rule 6). Each arm logs ONE
 * line of ids and tokens.
 */
function respostaDaFalha(err: unknown, pedido: PedidoDeAcaoDevolucao): NextResponse | null {
  const ids = {
    integracaoId: pedido.integracaoId,
    pedidoId: pedido.pedidoId,
    returnSn: pedido.returnSn,
    acao: pedido.acao,
  };

  if (err instanceof DevolucaoAcaoRecusadaError) {
    console.warn(`${TAG_LOG} ação recusada pelo ERP`, { ...ids, motivo: err.motivo });
    return NextResponse.json(
      {
        error: err.message,
        code: CODIGO_ACAO_RECUSADA,
        motivo: err.motivo,
        acoesDisponiveis: [...err.acoesDisponiveis],
      },
      { status: 409 },
    );
  }

  // ⚠️ Kind `other` ONLY: a dead grant, a rate limit and Shopee's own
  // transients are `ShopeeApiError`s too, and each already has its answer in
  // `shopeeErrorResponse` (409 re-auth, 502) — read as a refusal, a dead grant
  // would never tell the operator to reconnect.
  if (err instanceof ShopeeApiError && err.kind === SHOPEE_ERROR_KIND.other) {
    const motivo = classificarRecusaDevolucaoShopee(err);
    const codigoShopee = codigoSeguro(err.code);
    console.warn(`${TAG_LOG} ação recusada pela Shopee`, { ...ids, motivo, codigo: codigoShopee });
    if (motivo === MOTIVO_RECUSA_DEVOLUCAO.devolucaoInexistente) {
      return NextResponse.json(
        { error: FRASE_RECUSA_DEVOLUCAO[motivo], code: CODIGO_INEXISTENTE },
        { status: 404 },
      );
    }
    if (motivo !== null) {
      return NextResponse.json(
        {
          error: FRASE_RECUSA_DEVOLUCAO[motivo],
          code: CODIGO_RECUSADA_PELA_SHOPEE,
          motivo,
          codigoShopee,
        },
        { status: 409 },
      );
    }
    // Unclassified: the datum the table must learn — a 502, never a 409 the
    // operator would read as a known refusal with a remedy.
    return NextResponse.json(
      { error: msgFalhaShopee(codigoShopee), code: CODIGO_FALHA_SHOPEE, codigoShopee },
      { status: 502 },
    );
  }

  // The other kinds keep the mapper's status and code, never Shopee's sentence.
  if (err instanceof ShopeeApiError) return shopeeErrorResponse(semFraseDaShopee(err));
  return isShopeeError(err) ? shopeeErrorResponse(err) : null;
}

/* -------------------------------------------------------------------------- */
/*                         the post-action refresh (R-13)                      */
/* -------------------------------------------------------------------------- */

/**
 * The failures an enqueue is KNOWN to raise: the valve, a missing region, a
 * transient Cloud Tasks failure — which the real scheduler names
 * `ShopeeTasksTransientError` (#1759) —, a gRPC-coded transport failure, and
 * the Admin SDK's two REST classes, which since #1759 arrive here ONLY with a
 * deploy-shaped code (`permission-denied`: the enqueuer grant
 * `functions/DEPLOY.md` says to apply first; `not-found`: no queue in that
 * region yet; `invalid-credential`; the no-response config error), because the
 * scheduler names every transient one. Anything else is a bug and rethrows.
 *
 * ⚠️ The deploy-shaped ones stay contained HERE although the per-conta boundary
 * (`core/containment.ts`) rethrows them, and the asymmetry is deliberate. There
 * a rethrow fails a sweep TICK — the loud signal #778 wants, at no cost. Here
 * it would land AFTER an irreversible Shopee write, as a 500 for an action that
 * is DONE — which the panel (`falhaDaAcaoShopee` in `apps/web`) can at best show
 * as an uncertain outcome, never as the success it is: the doubt that invites
 * the second click on a refund this route exists to prevent. The
 * push receiver on this same backend contains a missing IAM grant for the same
 * reason (a 5xx costs more than the failure). It stays loud: the line is
 * `console.error`, and the operator still gets `nao-enfileirada`.
 */
function ehFalhaDeEnfileiramento(err: unknown): err is Error {
  return (
    err instanceof ShopeeTasksDisabledError ||
    err instanceof MissingRegionError ||
    err instanceof ShopeeTasksTransientError ||
    err instanceof FirebaseFunctionsError ||
    err instanceof FirebaseAppError ||
    isGrpcCodedError(err)
  );
}

/** `<service>/<code>`, lower-case — the only shape an SDK code has. */
const FORMA_DO_CODIGO_DO_SDK = /^[a-z]+\/[a-z-]+$/;

/**
 * A known enqueue failure as a log token: the CLASS, plus the SDK's closed-set
 * code when it has one — never a message, which may carry a URL or a body.
 * ⚠️ firebase-admin's two classes leave `name` at `'Error'`, so they are named
 * by class here. `ShopeeTasksTransientError` carries the SDK's code as
 * `codigo` (and the status Cloud Tasks answered, when it answered).
 */
function rotuloDaFalha(err: Error): string {
  if (err instanceof ShopeeTasksTransientError) {
    const status = err.httpStatus === null ? '' : ` HTTP ${String(err.httpStatus)}`;
    return `${err.name} ${err.codigo}${status}`;
  }
  const classe =
    err instanceof FirebaseFunctionsError
      ? 'FirebaseFunctionsError'
      : err instanceof FirebaseAppError
        ? 'FirebaseAppError'
        : err.name;
  const codigo = (err as { code?: unknown }).code;
  return typeof codigo === 'string' && FORMA_DO_CODIGO_DO_SDK.test(codigo)
    ? `${classe} ${codigo}`
    : classe;
}

/**
 * ONE synthetic code 29 for the return the action touched, so the importer —
 * the single writer — reflects it. A known enqueue failure is the operator's
 * `nao-enfileirada`, never an error (the module header).
 */
async function enfileirarAtualizacao(
  p: { integracaoId: string; shopId: number; orderSn: string; returnSn: string; nowMs: number },
  acao: AcaoDevolucaoShopee,
): Promise<'enfileirada' | 'nao-enfileirada'> {
  const payload = notificacaoSinteticaDeDevolucao({
    shopId: p.shopId,
    orderSn: p.orderSn,
    returnSn: p.returnSn,
    nowMs: p.nowMs,
    origem: 'acao-vendedor',
  });
  try {
    await createShopeeTaskScheduler().enqueue(payload);
    return 'enfileirada';
  } catch (err) {
    if (!ehFalhaDeEnfileiramento(err)) throw err;
    const linha = {
      integracaoId: p.integracaoId,
      returnSn: p.returnSn,
      acao,
      falha: rotuloDaFalha(err),
    };
    // The valve is a deliberate deploy state; every other arm is an outage or
    // a broken deploy, and stays loud.
    if (err instanceof ShopeeTasksDisabledError) {
      console.warn(`${TAG_LOG} atualização pós-ação não enfileirada`, linha);
    } else {
      console.error(`${TAG_LOG} atualização pós-ação não enfileirada`, linha);
    }
    return 'nao-enfileirada';
  }
}

/* -------------------------------------------------------------------------- */
/*                                  the route                                  */
/* -------------------------------------------------------------------------- */

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.incidenteResolucao.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return corpoInvalido(json.erro);
  const corpo = lerCorpo(json.valor);
  if (!corpo.ok) return corpoInvalido(corpo.erro);
  const { pedido } = corpo;

  // The route's ONE clock read — the click, the synthetic code 29's stamp.
  const nowMs = Date.now();
  const db = getAdminFirestore();

  let shopId: number;
  let resultado: ResultadoAcaoDevolucao;
  try {
    const ctx = await loadShopeeContext(db, pedido.integracaoId);
    // Refuses a conta without a `shop_id` (409 `SHOPEE_CONTA_SEM_SHOP_ID`)
    // before any token read, so the `shop_id` below is always present.
    const client = ctx.createShopClient();
    const shopIdDaConta = ctx.conta.shop_id;
    if (shopIdDaConta === null) {
      throw new Error('invariante: createShopClient aceitou uma conta Shopee sem shop_id.');
    }
    shopId = shopIdDaConta;
    resultado = await executarAcaoDevolucaoShopee({ client }, pedido);
  } catch (err) {
    const resposta = respostaDaFalha(err, pedido);
    if (resposta === null) throw err;
    return resposta;
  }

  // BEFORE the enqueue: the action is a fact at Shopee whatever the refresh
  // does next, and a bug rethrown from the enqueue must not take this line with
  // it. Register 231 reads the write's raw envelope `error` here.
  // eslint-disable-next-line no-console -- expected on every action; a warn nobody can act on hides the real ones
  console.info(`${TAG_LOG} ação executada`, {
    integracaoId: pedido.integracaoId,
    pedidoId: pedido.pedidoId,
    returnSn: resultado.returnSn,
    acao: resultado.acao,
    erroEnvelope: resultado.erroEnvelope,
  });

  const atualizacao = await enfileirarAtualizacao(
    {
      integracaoId: pedido.integracaoId,
      shopId,
      orderSn: resultado.orderSn,
      returnSn: resultado.returnSn,
      nowMs,
    },
    resultado.acao,
  );

  // Built by NAME: nothing the module returns leaves unless listed here.
  return NextResponse.json({
    ok: true,
    acao: resultado.acao,
    returnSn: resultado.returnSn,
    atualizacao,
  });
}
