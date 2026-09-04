/**
 * `POST /api/marketplace/mercado-livre/atualizar-precos/cancelar` — stop an
 * "Atualizar preços" bulk price push for one Mercado Livre account.
 * Body: `{ integracaoId, jobId }`. Requires `PERM.integracao.write`.
 *
 * The cancel is a single terminal stamp on the job doc — there is nothing to
 * tell the queue. `processPriceSyncJob` re-reads the job at the top of every
 * dispatch and stops the moment the status is not `running`, and it re-checks
 * once more before re-enqueuing, so an in-flight dispatch finishes its current
 * batch (at most `precoItemsPerDispatch()` drafts) and schedules nothing
 * further. Already-queued tasks drain as no-ops.
 *
 * ⚠️ Unlike `importar-todos/cancelar`, this is NOT what unblocks the button.
 * `startMassImportJob` blocks on a `running` job with no staleness bound, so
 * there the cancel is the only way out; `startPriceSyncJob` already stamps an
 * orphan `failed` once its `updatedAt` passes `PRICE_SYNC_STALE_RUNNING_MS` (6h)
 * and lets the fresh job through. What this buys is not making the operator wait
 * those six hours, and stopping a job that is still doing work — a distinction
 * worth keeping, because it is the reason not to copy the mass import's argument
 * for a staleness bound it does not need.
 *
 * A `jobId` that doesn't exist, or that belongs to a different `integracaoId`,
 * both 404 — matching `status/route.ts` and `relatorio/route.ts`, so a stray id
 * never reveals whether it belongs to someone else's account. A job that already
 * reached a terminal state gets 409 `ML_PRICE_SYNC_NOT_RUNNING`.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { cancelPriceSyncJob } from '@/lib/marketplace/preco/precoSync';

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
  const body = parsed as { integracaoId?: string; jobId?: string };
  if (!body.integracaoId || !body.jobId) {
    return NextResponse.json({ error: 'integracaoId e jobId são obrigatórios.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  const outcome = await cancelPriceSyncJob(db, {
    jobId: body.jobId,
    integracaoId: body.integracaoId,
  });

  switch (outcome) {
    case 'stamped':
      return NextResponse.json({ status: 'cancelled' });
    case 'not-running':
      return NextResponse.json(
        {
          error: 'Este envio de preços já foi finalizado.',
          code: 'ML_PRICE_SYNC_NOT_RUNNING',
        },
        { status: 409 },
      );
    // Both leaks are the same leak: whether this id exists at all.
    case 'not-found':
    case 'wrong-integracao':
      return NextResponse.json({ error: 'Envio de preços não encontrado.' }, { status: 404 });
  }
}
