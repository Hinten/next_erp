/**
 * `GET /api/marketplace/mercado-livre/importar-todos/status?integracaoId=…&jobId=…`
 * — poll the progress of a mass-import job started by
 * `POST /importar-todos` (see `lib/marketplace/massImport.ts`). Requires
 * `PERM.integracao.read`.
 *
 * A `jobId` that doesn't exist, or that exists but belongs to a different
 * `integracaoId`, both 404 — the caller never learns whether a stray id
 * belongs to someone else's account.
 */
import { NextResponse } from 'next/server';
import { importacaoMercadoLivreCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const searchParams = new URL(req.url).searchParams;
  const integracaoId = searchParams.get('integracaoId');
  const jobId = searchParams.get('jobId');
  if (!integracaoId || !jobId) {
    return NextResponse.json({ error: 'integracaoId e jobId são obrigatórios.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  const snap = await importacaoMercadoLivreCollection.docRef(db, {}, jobId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: 'Importação não encontrada.' }, { status: 404 });
  }
  const job = importacaoMercadoLivreCollection.parseRead(
    snap.data(),
    importacaoMercadoLivreCollection.docPath({}, jobId),
  );
  if (job.integracaoId !== integracaoId) {
    return NextResponse.json({ error: 'Importação não encontrada.' }, { status: 404 });
  }

  return NextResponse.json({
    status: job.status,
    scanned: job.scanned,
    imported: job.imported,
    created: job.created,
    skipped: job.skipped,
    failureCount: job.failureCount,
    failures: job.failures,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    erro: job.erro,
  });
}
