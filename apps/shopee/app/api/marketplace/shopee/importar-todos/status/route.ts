/**
 * `GET /api/marketplace/shopee/importar-todos/status?integracaoId=…&jobId=…` —
 * poll one mass-import job. Requires `PERM.integracao.read`.
 *
 * ## ⚠️ Four stored fields are NOT echoed
 *
 * `fila`, `filaKits`, `nextOffset` and `options` stay inside the document. The
 * two queues are unbounded arrays of item ids — a job over a large catalogue
 * would ship tens of thousands of provider ids through a polling endpoint that
 * the UI hits every few seconds — and `nextOffset` is a live scan cursor into
 * somebody's catalogue. What the operator actually needs from the queues is
 * their SIZE, which is `restante`, and what they need from the cursor is
 * whether the scan finished, which is `varreduraExaurida`.
 *
 * ## ⚠️ A missing job and another conta's job get the SAME answer
 *
 * Both are 404 with one sentence. Splitting them would turn this endpoint into
 * an oracle for "does this job id exist at all", which is a fact about another
 * account.
 */
import { NextResponse } from 'next/server';
import { importacaoShopeeCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { lerIntegracaoId, lerTextoObrigatorio } from '@/lib/shopee/taxonomia/params';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** One sentence for both leaks, because they are the same leak. */
const MSG_NAO_ENCONTRADA = 'Importação não encontrada.';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = lerIntegracaoId(params);
  if (!integracaoId.ok) return NextResponse.json({ error: integracaoId.erro }, { status: 400 });
  const jobId = lerTextoObrigatorio(params, 'jobId');
  if (!jobId.ok) return NextResponse.json({ error: jobId.erro }, { status: 400 });

  const db = getAdminFirestore();
  const snap = await importacaoShopeeCollection.docRef(db, {}, jobId.valor).get();
  if (!snap.exists) return NextResponse.json({ error: MSG_NAO_ENCONTRADA }, { status: 404 });

  const job = importacaoShopeeCollection.parseRead(
    snap.data(),
    importacaoShopeeCollection.docPath({}, jobId.valor),
  );
  if (job.integracaoId !== integracaoId.valor) {
    return NextResponse.json({ error: MSG_NAO_ENCONTRADA }, { status: 404 });
  }

  return NextResponse.json({
    status: job.status,
    scanned: job.scanned,
    imported: job.imported,
    created: job.created,
    skipped: job.skipped,
    kits: job.kits,
    failureCount: job.failureCount,
    failures: job.failures,
    /** How many listings are still queued — the queues' size, never their contents. */
    restante: job.fila.length + job.filaKits.length,
    /**
     * ⚠️ `nextOffset === null` is exactly "the scan is not going to ask for
     * another page", which covers both "never scanned" and "exhausted" — the two
     * collapse safely because a dispatch with empty queues always scans before
     * testing for completion.
     */
    varreduraExaurida: job.nextOffset === null,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    erro: job.erro,
  });
}
