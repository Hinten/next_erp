/**
 * `POST /api/marketplace/shopee/importar-todos/cancelar` — stop one Shopee mass
 * import. Body: `{ integracaoId, jobId }`. Requires `PERM.integracao.write`.
 *
 * The cancel is a single terminal stamp on the job document; there is nothing to
 * tell the queue. `processarImportacaoShopee` re-reads the job at the top of
 * every dispatch and answers `noop` the moment the status is not `running`, and
 * it re-checks once more before re-enqueuing — so an in-flight dispatch finishes
 * at most its current batch and schedules nothing further, and tasks already in
 * the queue drain as no-ops.
 *
 * ⚠️ It is also the recovery for a job that is `running` with NO worker — an
 * enqueue that succeeded and never dispatched (a region mismatch, a missing
 * `run.invoker` grant). `iniciarImportacaoShopee` blocks on any `running` job
 * with no staleness bound, so without this route such a job answers 409 for ever.
 *
 * 200 `{status:'cancelled'}` · 409 `SHOPEE_MASS_IMPORT_NOT_RUNNING` for a job
 * that already reached a terminal state · 404 for a missing job AND for one
 * belonging to another conta (one leak, one answer — `status/route.ts`'s rule).
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  corpoDeErro,
  lerCorpoCancelar,
  lerJsonDoCorpo,
} from '@/lib/shopee/produtos/corpoImportacao';
import { cancelarImportacaoShopee } from '@/lib/shopee/produtos/importacaoMassa';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return NextResponse.json(corpoDeErro(json), { status: 400 });
  const corpo = lerCorpoCancelar(json.valor);
  if (!corpo.ok) return NextResponse.json(corpoDeErro(corpo), { status: 400 });
  const { integracaoId, jobId } = corpo.valor;

  // ⚠️ ONE clock read, handed down as the terminal stamp's instant.
  const nowMs = Date.now();

  const resultado = await cancelarImportacaoShopee(getAdminFirestore(), {
    jobId,
    integracaoId,
    now: nowMs,
  });

  switch (resultado) {
    case 'stamped':
      return NextResponse.json({ status: 'cancelled' });
    case 'not-running':
      return NextResponse.json(
        {
          error: 'Esta importação já foi finalizada.',
          code: 'SHOPEE_MASS_IMPORT_NOT_RUNNING',
        },
        { status: 409 },
      );
    // Both leaks are the same leak: whether this id exists at all.
    case 'not-found':
    case 'wrong-integracao':
      return NextResponse.json({ error: 'Importação não encontrada.' }, { status: 404 });
  }
}
