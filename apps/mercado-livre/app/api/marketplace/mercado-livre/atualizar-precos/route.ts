/**
 * `POST /api/marketplace/mercado-livre/atualizar-precos` — kick off the manual
 * bulk price sync ("Atualizar preços") for a Mercado Livre account: pushes
 * each linked produto's price (the conta's tabela normal) to its ML listings,
 * checkpointed in an admin-only `enviosPrecoMercadoLivre` job doc processed
 * asynchronously by a Cloud Tasks queue (see `lib/marketplace/precoSync.ts` +
 * `lib/marketplace/mlPriceSyncTasks.ts`). Body: `{ integracaoId,
 * baixarPreco? }` — `baixarPreco` defaults to false, i.e. price DECREASES are
 * skipped unless the user opts in. Requires `PERM.integracao.write`.
 *
 * The conta must have a tabela normal configured — without one there is no
 * price source, so the route fails fast with 400 `SEM_TABELA_NORMAL` BEFORE
 * creating a job. Only one job may run per integração at a time — a second
 * call while one is already `running` gets 409 `ML_PRICE_SYNC_RUNNING`. If the
 * queue can't be reached the freshly-created job is marked `failed` so no
 * `running` doc is left orphaned with no worker, and the caller gets 503
 * `ML_PRICE_SYNC_ENQUEUE_FAILED`. Success: 202 `{ jobId }` — poll progress at
 * `atualizar-precos/status?integracaoId=…&jobId=…`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { envioPrecoMercadoLivreCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { isMercadoLivreError, mercadoLivreErrorResponse } from '@/lib/marketplace/respond';
import { PriceSyncAlreadyRunningError, startPriceSyncJob } from '@/lib/marketplace/precoSync';
import { createMlPriceSyncScheduler } from '@/lib/marketplace/mlPriceSyncTasks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Tolerant of an absent `baixarPreco` (→ false); rejects wrong types. */
const bodySchema = z.object({
  integracaoId: z.string().min(1),
  baixarPreco: z.boolean().default(false),
});

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
  const body = bodySchema.safeParse(parsed);
  if (!body.success) {
    return NextResponse.json(
      { error: 'Body inválido: integracaoId é obrigatório; baixarPreco é booleano opcional.' },
      { status: 400 },
    );
  }
  const { integracaoId, baixarPreco } = body.data;

  const db = getAdminFirestore();
  try {
    // Validates the account exists and is a Mercado Livre integração (throws
    // MercadoLivreContaNotConfiguredError otherwise — mapped below, mirroring
    // /importar-todos). The token itself is only resolved later, inside the task.
    const ctx = await loadMercadoLivreContext(db, integracaoId);

    // No tabela normal → no price source for the whole job. Fail fast BEFORE
    // creating a job doc, so a misconfigured conta never burns a running slot.
    if (asStringOrNull(ctx.conta.tabelaNormalOuterRef) === null) {
      return NextResponse.json(
        {
          error: 'A conta não tem uma tabela de preços normal configurada.',
          code: 'SEM_TABELA_NORMAL',
        },
        { status: 400 },
      );
    }

    let jobId: string;
    try {
      const started = await startPriceSyncJob(db, {
        integracaoId,
        baixarPreco,
        startedBy: auth.caller.uid,
      });
      jobId = started.jobId;
    } catch (err) {
      if (err instanceof PriceSyncAlreadyRunningError) {
        return NextResponse.json(
          {
            error: 'Já existe uma sincronização de preços em andamento para esta conta.',
            code: 'ML_PRICE_SYNC_RUNNING',
          },
          { status: 409 },
        );
      }
      throw err;
    }

    try {
      await createMlPriceSyncScheduler().enqueue({ jobId, integracaoId });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Falha ao enfileirar a sincronização de preços.';
      // Best-effort: mark the job failed so the status route/UI surfaces the
      // outage instead of leaving an orphaned `running` doc with no worker. The
      // stamp itself is guarded (same boundary shape as the webhook receiver's
      // enqueue fallback) so a concurrent Firestore outage still yields the 503
      // instead of an unhandled throw — the stamp failure is only logged.
      const failedAt = Date.now();
      try {
        await envioPrecoMercadoLivreCollection.merge(db, {}, jobId, {
          status: 'failed',
          erro: message,
          finishedAt: failedAt,
          updatedAt: failedAt,
        });
      } catch (stampErr) {
        if (!(stampErr instanceof Error)) throw stampErr;
        console.warn('[mercado-livre/atualizar-precos] failure-stamp falhou', {
          jobId,
          message: stampErr.message,
        });
      }
      return NextResponse.json(
        { error: message, code: 'ML_PRICE_SYNC_ENQUEUE_FAILED' },
        { status: 503 },
      );
    }

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (err) {
    if (isMercadoLivreError(err)) return mercadoLivreErrorResponse(err);
    throw err;
  }
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
