/**
 * `POST /api/marketplace/shopee/importar-todos` — start a full catalogue import
 * ("Importar todos os anúncios") for one Shopee conta. Body:
 * `{ integracaoId, options? }`. Requires `PERM.integracao.write`.
 *
 * The route creates the `importacoesShopee` job document and enqueues the FIRST
 * dispatch; `processarImportacaoShopee` drives the rest a bounded batch at a
 * time and re-enqueues itself. Progress is polled at
 * `importar-todos/status?integracaoId=…&jobId=…`.
 *
 * ## ⚠️ The valve is read BEFORE anything is created
 *
 * `SHOPEE_TASKS_DISABLED=1` is knowable in advance, so it is checked first and
 * answers 503 with NO job document written. Mercado Livre's route creates the
 * job and stamps it `failed` when the enqueue throws — correct for an outage
 * nobody can predict, and wrong for a valve we can simply read: a closed valve
 * would otherwise mint a `running` job with no worker, and
 * `iniciarImportacaoShopee` blocks on any `running` job with no staleness
 * bound, so the button would answer 409 for ever until somebody cancelled a job
 * that never started. The create-then-stamp path stays for the real outage,
 * which is the case below.
 *
 * ## Outcomes
 *
 * 202 `{jobId}` · 400 body inválido · 404 conta inexistente ou de outro tipo ·
 * 409 `SHOPEE_MASS_IMPORT_RUNNING` · 503
 * `SHOPEE_MASS_IMPORT_ENQUEUE_FAILED` (valve, or a genuine enqueue outage with
 * the fresh job stamped `failed`).
 */
import { NextResponse } from 'next/server';
import { ShopeeError } from '@delfrance/integrations-shopee';
import { IMPORTACAO_SHOPEE_STATUS } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import {
  corpoDeErro,
  lerCorpoImportarTodos,
  lerJsonDoCorpo,
} from '@/lib/shopee/produtos/corpoImportacao';
import { ShopeeMassImportTasksDisabledError } from '@/lib/shopee/produtos/errosImportacao';
import {
  finalizarImportacaoShopee,
  iniciarImportacaoShopee,
  MSG_VALVULA_FECHADA,
  ShopeeImportacaoEmAndamentoError,
} from '@/lib/shopee/produtos/importacaoMassa';
import { createShopeeMassImportScheduler } from '@/lib/shopee/produtos/shopeeMassImportTasks';
import { shopeeTasksDesabilitado } from '@/lib/shopee/shopeeTasks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The code both 503 arms carry — from the operator's side the action is the same. */
const CODIGO_ENQUEUE_FALHOU = 'SHOPEE_MASS_IMPORT_ENQUEUE_FAILED';

/**
 * A class name, never a message and never a payload: it is persisted in the
 * job's `erro` field and rendered to the operator.
 *
 * Module-level on purpose — inside a `catch` this would be `Error` as the sole
 * narrowed class, which narrows nothing (root `CLAUDE.md` rule 6).
 */
function nomeDoErro(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return NextResponse.json(corpoDeErro(json), { status: 400 });
  const corpo = lerCorpoImportarTodos(json.valor);
  if (!corpo.ok) return NextResponse.json(corpoDeErro(corpo), { status: 400 });
  const { integracaoId, options } = corpo.valor;

  // ⚠️ FIRST, and before `iniciarImportacaoShopee`. See the header.
  if (shopeeTasksDesabilitado()) {
    return NextResponse.json(
      { error: MSG_VALVULA_FECHADA, code: CODIGO_ENQUEUE_FALHOU },
      { status: 503 },
    );
  }

  const nowMs = Date.now();
  const db = getAdminFirestore();

  let jobId: string;
  try {
    // Purely to prove the conta exists and is a Shopee integração — the token is
    // resolved later, inside the task. It is what turns a bad `integracaoId`
    // into a 404 instead of a `running` job with no shop to scan.
    await loadShopeeContext(db, integracaoId);
    jobId = await iniciarImportacaoShopee(db, { integracaoId, options, now: nowMs });
  } catch (err) {
    // ⚠️ EXPLICIT, and ABOVE the generic arm. `ShopeeImportacaoEmAndamentoError`
    // extends `ShopeeError` but `respond.ts` does not know it, so the generic
    // arm would report a perfectly ordinary "already running" as a 500 outage.
    if (err instanceof ShopeeImportacaoEmAndamentoError) {
      return NextResponse.json(
        { error: err.message, code: 'SHOPEE_MASS_IMPORT_RUNNING' },
        { status: 409 },
      );
    }
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }

  try {
    await createShopeeMassImportScheduler().enqueue({ jobId, integracaoId });
  } catch (err) {
    // ⚠️ TOTAL by design, and the one place in this app where that is right: the
    // job document already exists, so anything that stops the first dispatch —
    // a closed valve that opened between the check above and here, a missing
    // region, an IAM refusal, a transport failure — must leave a `failed` job
    // the operator can see instead of a `running` one with no worker.
    const motivo =
      err instanceof ShopeeMassImportTasksDisabledError
        ? MSG_VALVULA_FECHADA
        : `Não foi possível enfileirar o primeiro despacho da importação (${nomeDoErro(err)}).`;

    try {
      await finalizarImportacaoShopee(db, jobId, {
        status: IMPORTACAO_SHOPEE_STATUS.failed,
        erro: motivo,
        finishedAt: nowMs,
        updatedAt: nowMs,
      });
    } catch (erroDoCarimbo) {
      // Best effort: a Firestore outage here must still produce the 503 rather
      // than an unhandled throw, so the stamp failure is only logged.
      const detalhe =
        erroDoCarimbo instanceof ShopeeError ? erroDoCarimbo.message : nomeDoErro(erroDoCarimbo);
      console.warn('[shopee/importar-todos] falha ao carimbar o job recém-criado como failed', {
        jobId,
        integracaoId,
        detalhe,
      });
    }

    return NextResponse.json({ error: motivo, code: CODIGO_ENQUEUE_FALHOU }, { status: 503 });
  }

  return NextResponse.json({ jobId }, { status: 202 });
}
