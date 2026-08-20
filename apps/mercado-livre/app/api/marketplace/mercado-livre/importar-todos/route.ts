/**
 * `POST /api/marketplace/mercado-livre/importar-todos` — kick off a full mass
 * import ("Importar todos os anúncios") for a Mercado Livre account: scans
 * every listing via ML's scan search and imports each one that isn't already
 * linked, checkpointed in an admin-only `importacoesMercadoLivre` job doc
 * processed asynchronously by a Cloud Tasks queue (see
 * `lib/marketplace/massImport.ts` + `lib/marketplace/mlMassImportTasks.ts`).
 * Body: `{ integracaoId, options? }`. Requires `PERM.integracao.write`.
 *
 * Only one job may run per integração at a time — a second call while one is
 * already `running` gets 409 `ML_MASS_IMPORT_RUNNING`. If the queue can't be
 * reached the freshly-created job is marked `failed` so no `running` doc is
 * left orphaned with no worker, and the caller gets 503
 * `ML_MASS_IMPORT_ENQUEUE_FAILED`. Success: 202 `{ jobId }` — poll progress at
 * `importar-todos/status?integracaoId=…&jobId=…`.
 */
import { NextResponse } from 'next/server';
import { IMPORTACAO_MERCADO_LIVRE_STATUS, type MassImportOptions } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';
import {
  finalizeMassImportJob,
  MassImportAlreadyRunningError,
  MERCADO_LIVRE_MASS_IMPORT_QUEUE,
  startMassImportJob,
} from '@/lib/marketplace/massImport';
import { createMlMassImportScheduler } from '@/lib/marketplace/mlMassImportTasks';
import { mlQueuePath } from '@/lib/marketplace/mlTasksRegion';

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
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
  }
  const body = parsed as { integracaoId?: string; options?: unknown };
  if (!body.integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }
  const integracaoId = body.integracaoId;

  const db = getAdminFirestore();
  try {
    // Validates the account exists and is a Mercado Livre integração (throws
    // MercadoLivreContaNotConfiguredError otherwise — mapped below, mirroring
    // /importar). The token itself is only resolved later, inside the task.
    await loadMercadoLivreContext(db, integracaoId);

    const options = sanitizeMassImportOptions(body.options);

    let jobId: string;
    try {
      jobId = await startMassImportJob(db, { integracaoId, options });
    } catch (err) {
      if (err instanceof MassImportAlreadyRunningError) {
        return NextResponse.json(
          {
            error: 'Já existe uma importação em andamento para esta conta.',
            code: 'ML_MASS_IMPORT_RUNNING',
          },
          { status: 409 },
        );
      }
      throw err;
    }

    try {
      await createMlMassImportScheduler().enqueue({ jobId, integracaoId });
    } catch (err) {
      // Name the queue the enqueue was AIMED at. A region misconfiguration is
      // the likeliest cause of a failure here and the bare RPC error never
      // says which location it tried — see lib/marketplace/mlTasksRegion.ts.
      const detail = err instanceof Error ? err.message : 'Falha ao enfileirar a importação.';
      const message = `${detail} (fila: ${mlQueuePath(MERCADO_LIVRE_MASS_IMPORT_QUEUE)})`;
      // Best-effort: mark the job failed so the status route/UI surfaces the
      // outage instead of leaving an orphaned `running` doc with no worker. The
      // stamp itself is guarded (same boundary shape as the webhook receiver's
      // enqueue fallback) so a concurrent Firestore outage still yields the 503
      // instead of an unhandled throw — the stamp failure is only logged.
      const failedAt = Date.now();
      try {
        await finalizeMassImportJob(db, jobId, {
          status: IMPORTACAO_MERCADO_LIVRE_STATUS.failed,
          erro: message,
          finishedAt: failedAt,
          updatedAt: failedAt,
        });
      } catch (stampErr) {
        if (!(stampErr instanceof Error)) throw stampErr;
        console.warn('[mercado-livre/importar-todos] failure-stamp falhou', {
          jobId,
          message: stampErr.message,
        });
      }
      return NextResponse.json(
        { error: message, code: 'ML_MASS_IMPORT_ENQUEUE_FAILED' },
        { status: 503 },
      );
    }

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}

/**
 * Accept the known boolean flags from the body and fill in the rest with the
 * same defaults as the single-item import modal (`ImportarMercadoLivreModal`
 * / `DEFAULT_IMPORT_OPTIONS`), plus `atualizarCadastrados: false` (a re-scan
 * skips already-linked listings unless explicitly asked to revisit them).
 * Unlike `/importar`'s `sanitizeOptions`, this always returns a FULL
 * `MassImportOptions` — the job doc has no separate default-merge step.
 */
function sanitizeMassImportOptions(v: unknown): MassImportOptions {
  const src =
    v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const bool = (key: string, fallback: boolean): boolean =>
    typeof src[key] === 'boolean' ? (src[key] as boolean) : fallback;
  return {
    importarEstoque: bool('importarEstoque', true),
    sobrescreverEstoque: bool('sobrescreverEstoque', false),
    importarPreco: bool('importarPreco', true),
    sobrescreverPreco: bool('sobrescreverPreco', true),
    atualizarProdutoPai: bool('atualizarProdutoPai', true),
    importarFotos: bool('importarFotos', true),
    importarCategorias: bool('importarCategorias', true),
    atualizarCadastrados: bool('atualizarCadastrados', false),
  };
}
