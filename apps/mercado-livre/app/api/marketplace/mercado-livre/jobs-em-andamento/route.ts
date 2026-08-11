/**
 * `GET /api/marketplace/mercado-livre/jobs-em-andamento?integracaoIds=a,b,c`
 * — the RUNNING mass-import (#621) and bulk price-sync (Step 11) jobs for a
 * set of contas, in one round trip. Requires `PERM.integracao.read`.
 *
 * Why it exists (#816): both jobs are durable server-side checkpoints, but the
 * two `…/status` routes are keyed by an explicit `jobId` that only ever lived
 * in React state — so a page reload orphaned the only handle the UI had on a
 * running job. The channel list page calls this for the contas it is showing,
 * re-attaches its pollers to whatever comes back, and progress survives a
 * refresh.
 *
 * Deliberately RUNNING-only. "The most recent job whatever its status" would
 * need an `(integracaoId, startedAt DESC)` index; these two equality filters
 * ride the `(integracaoId ASC, status ASC)` indexes that
 * `firestore.indexes.json` already declares for the start-time
 * already-running guards — no new index, so nothing here waits on an index
 * deploy. The consequence, and it is the intended trade: a job that FINISHED
 * while the page was closed is not resurfaced. Once a caller has a `jobId` it
 * polls `…/status` with it, which does return terminal jobs — that is what
 * keeps a completed card on screen.
 *
 * The caller must name the contas: no unfiltered "every running job" mode, so
 * the response can never widen past the accounts the caller already sees.
 */
import { NextResponse } from 'next/server';
import {
  envioPrecoMercadoLivreCollection,
  importacaoMercadoLivreCollection,
} from '@delfrance/data/admin/collections';
import type { Firestore } from 'firebase-admin/firestore';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Firestore's `in` cap. A longer selection is queried in several chunks. */
const IN_CHUNK = 30;

/** Upper bound on the accounts one request may ask about (10 chunked queries). */
const MAX_IDS = 300;

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const raw = new URL(req.url).searchParams.get('integracaoIds');
  const integracaoIds = [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (integracaoIds.length === 0) {
    return NextResponse.json({ error: 'integracaoIds é obrigatório.' }, { status: 400 });
  }
  if (integracaoIds.length > MAX_IDS) {
    return NextResponse.json(
      { error: `integracaoIds aceita no máximo ${MAX_IDS} contas por consulta.` },
      { status: 400 },
    );
  }

  const db = getAdminFirestore();
  const [importacoes, enviosPreco] = await Promise.all([
    runningMassImports(db, integracaoIds),
    runningPriceSyncs(db, integracaoIds),
  ]);

  return NextResponse.json({ importacoes, enviosPreco });
}

function chunk(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(ids.slice(i, i + IN_CHUNK));
  return out;
}

async function runningMassImports(db: Firestore, integracaoIds: readonly string[]) {
  const pages = await Promise.all(
    chunk(integracaoIds).map((ids) =>
      importacaoMercadoLivreCollection
        .ref(db, {})
        .where('integracaoId', 'in', ids)
        .where('status', '==', 'running')
        .get(),
    ),
  );
  return pages.flatMap((page) =>
    page.docs.map((doc) => {
      const job = importacaoMercadoLivreCollection.parseRead(
        doc.data(),
        importacaoMercadoLivreCollection.docPath({}, doc.id),
      );
      // Same projection the by-jobId status route returns, plus the identity
      // the caller needs to place the row — so the UI can paint progress from
      // this response alone, without a second round trip.
      return {
        jobId: doc.id,
        integracaoId: job.integracaoId,
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
      };
    }),
  );
}

async function runningPriceSyncs(db: Firestore, integracaoIds: readonly string[]) {
  const pages = await Promise.all(
    chunk(integracaoIds).map((ids) =>
      envioPrecoMercadoLivreCollection
        .ref(db, {})
        .where('integracaoId', 'in', ids)
        .where('status', '==', 'running')
        .get(),
    ),
  );
  return pages.flatMap((page) =>
    page.docs.map((doc) => {
      const job = envioPrecoMercadoLivreCollection.parseRead(
        doc.data(),
        envioPrecoMercadoLivreCollection.docPath({}, doc.id),
      );
      return {
        jobId: doc.id,
        integracaoId: job.integracaoId,
        status: job.status,
        baixarPreco: job.baixarPreco,
        planejados: job.planejados,
        enviados: job.enviados,
        pulados: job.pulados,
        falhas: job.falhas,
        pausas: job.pausas,
        skips: job.skips,
        failures: job.failures,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt,
        erro: job.erro,
      };
    }),
  );
}
