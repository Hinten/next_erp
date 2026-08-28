/**
 * `GET /api/marketplace/mercado-livre/atualizar-precos/historico?integracaoId=…&limite=…`
 * — the conta's PAST price-sync runs, newest first. Requires
 * `PERM.integracao.read`.
 *
 * Why it exists: the job docs were already durable and are never deleted (no TTL
 * policy, no purge sweep), but nothing could reach a FINISHED one. `…/status` is
 * keyed by an explicit `jobId` that only ever lived in React state, and
 * `…/jobs-em-andamento` is deliberately RUNNING-only — its docblock spells out
 * the trade it accepted ("a job that FINISHED while the page was closed is not
 * resurfaced") and names the index that would be needed to lift it. This route
 * is that index being paid for: `(integracaoId ASC, startedAt DESC)`, declared
 * in `firestore.indexes.json`. That trade is unchanged for `jobs-em-andamento`
 * itself, which still rides the `(integracaoId, status)` composite.
 *
 * ⚠️ On Firestore ENTERPRISE a missing composite index does NOT throw — the
 * query silently full-scans and the scan is billed. So the index is not an
 * optimisation here and its absence has no runtime signal; the backstop is
 * `historicoIndex.test.ts`, which derives the requirement from this file.
 *
 * ⚠️ `fila` is deliberately NOT projected. It holds up to `PLAN_PAGE_DRAFTS_CAP`
 * (2000) drafts — hundreds of KB per job — and a history page returns many jobs
 * at once. The rest of the projection is `…/status`'s, key for key, plus the
 * `jobId` the caller needs to open one.
 */
import { NextResponse } from 'next/server';
import { envioPrecoMercadoLivreCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Runs returned when the caller names no `limite`. */
const LIMITE_PADRAO = 20;

/**
 * Hard ceiling on one page. Each entry carries the capped `skips`/`failures`
 * samples (200 + 100 rows), so the response grows fast even without `fila`.
 */
const LIMITE_MAXIMO = 50;

/**
 * The document fields this route reads — the response projection, applied at the
 * QUERY so the unread ones never leave Firestore. Exported so its own test can
 * assert the set round-trips through `envioPrecoMercadoLivreSchema`: a field
 * dropped from here that has no schema default would fail every parse, and one
 * added to the response but not here would silently read as its default.
 */
export const CAMPOS_PROJETADOS = [
  'integracaoId',
  'status',
  'baixarPreco',
  'planejados',
  'enviados',
  'pulados',
  'naoEnumerados',
  'falhas',
  'pausas',
  'skips',
  'failures',
  'startedAt',
  'updatedAt',
  'finishedAt',
  'erro',
] as const;

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const searchParams = new URL(req.url).searchParams;
  const integracaoId = searchParams.get('integracaoId');
  if (!integracaoId) {
    return NextResponse.json({ error: 'integracaoId é obrigatório.' }, { status: 400 });
  }

  const limite = parseLimite(searchParams.get('limite'));
  if (limite === null) {
    return NextResponse.json(
      { error: `limite deve ser um inteiro entre 1 e ${String(LIMITE_MAXIMO)}.` },
      { status: 400 },
    );
  }

  const db = getAdminFirestore();
  const snap = await envioPrecoMercadoLivreCollection
    .ref(db, {})
    .where('integracaoId', '==', integracaoId)
    .orderBy('startedAt', 'desc')
    // ⚠️ Projected SERVER-side, not just dropped from the response body. Without
    // this the whole document crosses the wire — up to 50 of them, each carrying
    // a `fila` of up to `PLAN_PAGE_DRAFTS_CAP` (2000) drafts — to be discarded
    // here. It does NOT reduce Enterprise's data-scanned bill (the documents are
    // still read); what it cuts is payload and deserialisation, which for these
    // documents is the dominant cost.
    //
    // ⚠️ Every field with no schema default must be listed or `parseRead` fails:
    // `integracaoId`, `status`, `startedAt`, `updatedAt`. The unprojected ones
    // (`fila`, `afterAnchorId`, `afterLinkPath`, `startedBy`, both `*Concluido`
    // flags, `linksReconciliados`, `reconciliacaoPaginas`) all default, so the
    // parse stays on its success path. `projecao.test.ts` pins that.
    .select(...CAMPOS_PROJETADOS)
    .limit(limite)
    .get();

  const envios = snap.docs.map((doc) => {
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
      naoEnumerados: job.naoEnumerados,
      falhas: job.falhas,
      pausas: job.pausas,
      skips: job.skips,
      failures: job.failures,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      erro: job.erro,
    };
  });

  return NextResponse.json({ envios });
}

/**
 * `null` = the caller sent something we refuse. An ABSENT `limite` is not that —
 * it takes the default — but a present-and-nonsense one is rejected rather than
 * coerced, so a caller asking for 500 learns the ceiling instead of silently
 * receiving 50 and reading it as "that is all there is".
 */
function parseLimite(raw: string | null): number | null {
  if (raw === null || raw === '') return LIMITE_PADRAO;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= LIMITE_MAXIMO ? n : null;
}
