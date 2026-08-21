/**
 * `POST /api/marketplace/mercado-livre/importar-todos/cancelar` — stop a mass
 * import ("Importar todos os anúncios") for one Mercado Livre account.
 * Body: `{ integracaoId, jobId }`. Requires `PERM.integracao.write`.
 *
 * The cancel is a single terminal stamp on the job doc — there is nothing to
 * tell the queue. `processMassImportJob` re-reads the job at the top of every
 * dispatch and stops the moment the status is not `running`, and it re-checks
 * once more before re-enqueuing, so an in-flight dispatch finishes its current
 * batch (at most `MASS_IMPORT_ITEMS_PER_DISPATCH` items) and schedules nothing
 * further. Already-queued tasks drain as no-ops.
 *
 * It is also the recovery for a job that is `running` but has NO worker — an
 * enqueue that succeeded and then never dispatched, e.g. a queue/function
 * region mismatch or a missing `run.invoker` grant. `startMassImportJob` blocks
 * on any `running` job with no staleness bound, so without a cancel such a job
 * keeps the button answering 409 `ML_MASS_IMPORT_RUNNING` indefinitely.
 *
 * A `jobId` that doesn't exist, or that belongs to a different `integracaoId`,
 * both 404 — matching `status/route.ts`, so a stray id never reveals whether it
 * belongs to someone else's account. A job that already reached a terminal
 * state gets 409 `ML_MASS_IMPORT_NOT_RUNNING`.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { cancelMassImportJob } from '@/lib/marketplace/mass-import/massImport';

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
  const outcome = await cancelMassImportJob(db, {
    jobId: body.jobId,
    integracaoId: body.integracaoId,
  });

  switch (outcome) {
    case 'stamped':
      return NextResponse.json({ status: 'cancelled' });
    case 'not-running':
      return NextResponse.json(
        {
          error: 'Esta importação já foi finalizada.',
          code: 'ML_MASS_IMPORT_NOT_RUNNING',
        },
        { status: 409 },
      );
    // Both leaks are the same leak: whether this id exists at all.
    case 'not-found':
    case 'wrong-integracao':
      return NextResponse.json({ error: 'Importação não encontrada.' }, { status: 404 });
  }
}
