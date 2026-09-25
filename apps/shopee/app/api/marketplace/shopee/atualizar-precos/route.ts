/**
 * `POST /api/marketplace/shopee/atualizar-precos` — start the ACCOUNT-WIDE
 * price update ("Atualizar preços") for one Shopee conta (#1521, step 13, the
 * second PR). Body: `{ integracaoId, baixarPreco? }`. Requires
 * `PERM.integracao.write`, the bit the manual push and the stock push carry.
 *
 * The route creates the `enviosPrecoShopee` job document and enqueues the
 * FIRST dispatch; `processarEnvioPrecoShopee` (the `processShopeePriceSync`
 * queue, in the functions codebase) drives the rest a page and a few listings
 * at a time and re-enqueues itself. Beside this route: `…/status` (poll one
 * run), `…/cancelar` (stop it), `…/historico` (the conta's past runs) and
 * `…/relatorio` (one run's per-model report).
 *
 * ## The ladder, in order — and why each rung sits where it does
 *
 * 1. `verifyCaller` → 2. a JSON body → 3. an object → 4. `integracaoId` a
 * document id → 5. `baixarPreco` a boolean or absent — absent is `false`:
 * lowering a price is an explicit act → 6. the Tasks VALVE ⇒ 503
 * `SHOPEE_PRICE_SYNC_ENQUEUE_FAILED` with NO document written → 7. ONE clock
 * read → 8. the conta (404 when missing or not a Shopee conta) → 9. a blank
 * `tabelaNormalOuterRef` ⇒ 400 `SHOPEE_CONTA_SEM_TABELA_NORMAL` → 10. the
 * conta's QUOTA pause ⇒ 409 `SHOPEE_CONTA_PAUSADA` + `pausadoAte` → 11. the
 * conta verdict ⇒ 422 `SHOPEE_PRECO_CONTA_RECUSADA` `{motivo, mensagem,
 * regiao?}` → 12. the job (409 `SHOPEE_PRICE_SYNC_RUNNING` when a live run
 * exists) → 13. the first enqueue → 202 `{jobId}`.
 *
 * Rungs 9–11 are the manual push's own (`enviar-precos/route.ts`), in its
 * order and with its codes: one conta answers the same refusal whichever of
 * the two buttons the operator pressed.
 *
 * ## ⚠️ The valve is read BEFORE anything else (rung 6)
 *
 * `SHOPEE_TASKS_DISABLED=1` is knowable in advance, so it answers 503 before
 * the conta is read, before the shop read the verdict spends, and before any
 * document exists. `iniciarEnvioPrecoShopee` refuses on its own as well — the
 * valve may close between this rung and that call — and its class is answered
 * by the same 503 below. A job created with no worker would read as a live run
 * and answer every start with 409 until the six-hour orphan reclaim.
 *
 * ## ⚠️ The verdict BEFORE the job (reconcile C-j)
 *
 * A refused conta creates nothing: the job takes the verdict's BRANDED context,
 * so a job cannot be created for a conta that did not pass. Rungs 9–10 cost
 * ZERO provider calls and build NO client; the verdict (rung 11) is where the
 * one cached `get_shop_info` happens. The job re-evaluates the conta on its
 * first drain — the verdict here is the operator's immediate answer, not the
 * job's licence to send.
 *
 * ## ⚠️ The first enqueue runs AFTER the job exists
 *
 * So an enqueue that fails has a document to stamp `failed` — through the job's
 * ONE terminal transaction, with one `job-interrompido` report row — instead
 * of a 503 and nothing to look at. The stamped `erro` names the error's CLASS,
 * never its message: the field is persisted and rendered to the operator, and
 * a transport message can carry a URL, a body or a credential. A known enqueue
 * outage answers 503; anything else is stamped the same way and then RETHROWN
 * (root `CLAUDE.md` rule 6) — a bug must not read as an outage.
 *
 * ## Errors
 *
 * `ShopeeEnvioPrecoGuardError`, `ShopeeEnvioPrecoEmAndamentoError` and
 * `ShopeePriceSyncTasksDisabledError` FIRST, each at its own status — the first
 * two extend the package's base, and the generic arm would answer them as a
 * generic failure; then `isShopeeError` ⇒ `shopeeErrorResponse`; anything else
 * rethrows.
 */
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import type { Firestore } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { MissingRegionError } from '@delfrance/core/region';
import { ENVIO_PRECO_SHOPEE_STATUS } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { naoDocId } from '@/lib/shopee/anuncios/corpoPublicacao';
import { isGrpcCodedError } from '@/lib/shopee/core/containment';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import { lerEstadoEstoque } from '@/lib/shopee/estoque/estadoEstoque';
import {
  finalizarEnvioPrecoShopee,
  iniciarEnvioPrecoShopee,
} from '@/lib/shopee/precos/atualizarPrecos';
import { pausaDeCotaParaPreco } from '@/lib/shopee/precos/enviarPrecoManual';
import {
  CODIGO_ENVIO_PRECO_EM_ANDAMENTO,
  CODIGO_ENVIO_PRECO_ENFILEIRAMENTO_FALHOU,
  CODIGO_GUARDA_PRECO,
  MOTIVO_PRECO_SHOPEE,
  ShopeeEnvioPrecoEmAndamentoError,
  ShopeeEnvioPrecoGuardError,
  ShopeePriceSyncTasksDisabledError,
  mensagemDoMotivoDePreco,
} from '@/lib/shopee/precos/errosPreco';
import { avaliarContaParaPreco } from '@/lib/shopee/precos/regiaoPreco';
import { createShopeePriceSyncScheduler } from '@/lib/shopee/precos/shopeePriceSyncTasks';
import { MSG_BODY_INVALIDO, lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';
import { shopeeTasksDesabilitado } from '@/lib/shopee/shopeeTasks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The one sentence an unusable `integracaoId` gets — the manual push's, and
 * written here for that route's reason: only {@link naoDocId}, the RULE, is
 * shared.
 */
const MSG_INTEGRACAO_ID_INVALIDO = 'integracaoId deve ser um id de documento (sem "/" nem "..").';

/** The sentence a non-boolean `baixarPreco` gets — the manual push's. */
const MSG_BAIXAR_PRECO_INVALIDO = 'baixarPreco deve ser booleano.';

/** The operator's sentence for a closed valve — every 503 arm that meets one. */
export const MSG_FILA_DE_PRECO_DESABILITADA =
  'A fila da atualização de preços está desabilitada neste ambiente (SHOPEE_TASKS_DISABLED); nenhuma atualização foi iniciada.';

/** The operator's sentence for a conta that already has a live run. */
export const MSG_ENVIO_PRECO_EM_ANDAMENTO =
  'Já existe uma atualização de preços em andamento para esta conta.';

/** The log tag of this route. */
const TAG_LOG = '[shopee/precos] atualizar-precos';

/**
 * A class name, never a message and never a payload: it is persisted in the
 * job's `erro` and rendered to the operator.
 *
 * Module-level on purpose — inside a `catch` this would be `Error` as the sole
 * narrowed class, which narrows nothing (root `CLAUDE.md` rule 6).
 */
function nomeDoErro(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * The failures an enqueue is KNOWN to raise — each an outage the operator can
 * only retry later, answered 503: the valve closed after rung 6, a missing
 * region (`requireRegion`), the Admin SDK's own task-queue and app errors, and
 * a gRPC-coded transport failure — the set `apps/melhor-envio`'s
 * `isMelhorEnvioEnqueueError` names (EVIDENCE, not imported), plus the gRPC
 * arm. Anything else is a bug and rethrows after the job is stamped.
 */
function ehFalhaDeEnfileiramento(err: unknown): err is Error {
  return (
    err instanceof ShopeePriceSyncTasksDisabledError ||
    err instanceof MissingRegionError ||
    err instanceof FirebaseFunctionsError ||
    err instanceof FirebaseAppError ||
    isGrpcCodedError(err)
  );
}

/**
 * Stamp the fresh job `failed` because its first dispatch never got queued —
 * through the ONE terminal transaction, with one `job-interrompido` row.
 *
 * Best effort against a Firestore outage: a gRPC-coded failure of the stamp is
 * only logged, so the caller still answers; anything else rethrows. A job left
 * `running` here is the six-hour orphan reclaim's to take.
 */
async function carimbarFalhaDoEnfileiramento(
  db: Firestore,
  jobId: string,
  integracaoId: string,
  erro: string,
  nowMs: number,
): Promise<void> {
  try {
    await finalizarEnvioPrecoShopee(
      db,
      jobId,
      {
        status: ENVIO_PRECO_SHOPEE_STATUS.failed,
        erro,
        relatorioCompleto: false,
        finishedAt: nowMs,
        updatedAt: nowMs,
      },
      { linhaTerminal: MOTIVO_PRECO_SHOPEE.jobInterrompido },
    );
  } catch (erroDoCarimbo) {
    if (!isGrpcCodedError(erroDoCarimbo)) throw erroDoCarimbo;
    console.warn(`${TAG_LOG}: falha ao carimbar o job recém-criado como failed`, {
      jobId,
      integracaoId,
      erro: nomeDoErro(erroDoCarimbo),
    });
  }
}

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

  // Absent ⇒ FALSE: a lower price is sent only when the caller says so.
  const baixar = body['baixarPreco'];
  if (baixar !== undefined && typeof baixar !== 'boolean') {
    return NextResponse.json({ error: MSG_BAIXAR_PRECO_INVALIDO }, { status: 400 });
  }
  const baixarPreco = baixar === true;

  // ⚠️ FIRST, before the conta, the shop read and any document. See the header.
  if (shopeeTasksDesabilitado()) {
    return NextResponse.json(
      { error: MSG_FILA_DE_PRECO_DESABILITADA, code: CODIGO_ENVIO_PRECO_ENFILEIRAMENTO_FALHOU },
      { status: 503 },
    );
  }

  // ONE clock read for the whole request: the pause verdict, the shop-info
  // cache, the job's `startedAt` (and so its TTL) and any failure stamp agree.
  const nowMs = Date.now();
  const db = getAdminFirestore();

  let jobId: string;
  try {
    const ctx = await loadShopeeContext(db, integracaoId);

    const tabelaRef = ctx.conta.tabelaNormalOuterRef;
    if (typeof tabelaRef !== 'string' || tabelaRef.trim() === '') {
      throw new ShopeeEnvioPrecoGuardError(
        CODIGO_GUARDA_PRECO.contaSemTabelaNormal,
        mensagemDoMotivoDePreco(MOTIVO_PRECO_SHOPEE.semTabelaNormal),
      );
    }

    const pausadoAte = pausaDeCotaParaPreco(await lerEstadoEstoque(db, integracaoId), nowMs);
    if (pausadoAte !== null) {
      throw new ShopeeEnvioPrecoGuardError(
        CODIGO_GUARDA_PRECO.contaPausada,
        mensagemDoMotivoDePreco(MOTIVO_PRECO_SHOPEE.contaPausada),
        { pausadoAte: new Date(pausadoAte).toISOString() },
      );
    }

    const veredito = await avaliarContaParaPreco(
      db,
      {
        integracaoId,
        shopId: ctx.conta.shop_id ?? null,
        tabelaNormalOuterRef: tabelaRef,
      },
      {
        nowMs,
        // The context already loaded is the client's source — built lazily by
        // the verdict, only when the shop read needs it.
        clientFor: () => Promise.resolve().then(() => ctx.createShopClient()),
        config: ctx.config,
      },
    );
    if (!veredito.ok) {
      const mensagem = mensagemDoMotivoDePreco(veredito.motivo);
      if (veredito.erro !== null) {
        // The class and message are for the log — never for the body.
        console.warn(`${TAG_LOG}: conta recusada (${veredito.motivo})`, {
          integracaoId,
          erro: veredito.erro,
        });
      }
      if (veredito.motivo === MOTIVO_PRECO_SHOPEE.semTabelaNormal) {
        throw new ShopeeEnvioPrecoGuardError(CODIGO_GUARDA_PRECO.contaSemTabelaNormal, mensagem);
      }
      throw new ShopeeEnvioPrecoGuardError(CODIGO_GUARDA_PRECO.contaRecusada, mensagem, {
        motivo: veredito.motivo,
        mensagem,
        ...(veredito.regiao === null ? {} : { regiao: veredito.regiao }),
      });
    }

    jobId = await iniciarEnvioPrecoShopee(db, {
      contexto: veredito.contexto,
      baixarPreco,
      startedBy: auth.caller.uid,
      nowMs,
    });
  } catch (err) {
    // ⚠️ FIRST, all three: two extend the package's base, and the arm below
    // would answer them as a generic Shopee failure instead of their status.
    if (err instanceof ShopeeEnvioPrecoGuardError) {
      return NextResponse.json(
        { error: err.message, code: err.code, ...err.extra },
        { status: err.status },
      );
    }
    if (err instanceof ShopeeEnvioPrecoEmAndamentoError) {
      return NextResponse.json(
        { error: MSG_ENVIO_PRECO_EM_ANDAMENTO, code: CODIGO_ENVIO_PRECO_EM_ANDAMENTO },
        { status: err.status },
      );
    }
    if (err instanceof ShopeePriceSyncTasksDisabledError) {
      // The valve closed between rung 6 and the start — nothing was created.
      return NextResponse.json(
        { error: MSG_FILA_DE_PRECO_DESABILITADA, code: CODIGO_ENVIO_PRECO_ENFILEIRAMENTO_FALHOU },
        { status: err.status },
      );
    }
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }

  try {
    await createShopeePriceSyncScheduler().enqueue({ jobId, integracaoId });
  } catch (err) {
    // ⚠️ The job already exists, so EVERY failure stamps it before anything
    // else — a `running` job with no worker would answer the next start with
    // 409. Only the ANSWER depends on the class. See the header.
    const erro =
      err instanceof ShopeePriceSyncTasksDisabledError
        ? MSG_FILA_DE_PRECO_DESABILITADA
        : `Não foi possível enfileirar o primeiro despacho da atualização de preços (${nomeDoErro(err)}).`;
    await carimbarFalhaDoEnfileiramento(db, jobId, integracaoId, erro, nowMs);
    if (!ehFalhaDeEnfileiramento(err)) throw err;
    console.warn(`${TAG_LOG}: o primeiro despacho não foi enfileirado`, {
      jobId,
      integracaoId,
      erro: nomeDoErro(err),
    });
    return NextResponse.json(
      { error: erro, code: CODIGO_ENVIO_PRECO_ENFILEIRAMENTO_FALHOU },
      { status: 503 },
    );
  }

  return NextResponse.json({ jobId }, { status: 202 });
}
