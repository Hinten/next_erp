/**
 * `GET /api/marketplace/shopee/atualizar-precos/historico?integracaoId=…&limite=…`
 * — the conta's PAST price updates, newest first (#1521, step 13). Requires
 * `PERM.integracao.write`, like every route of the job. `limite` is an integer
 * in 1..50, 20 when absent; a present-and-invalid one is REFUSED, never
 * clamped, so a caller asking for 500 learns the ceiling instead of reading 50
 * runs as "that is all there is".
 *
 * The runs are durable — kept by the `enviosPrecoShopee` TTL policy for
 * `RETENCAO_ENVIO_PRECO_SHOPEE_DIAS` after they start, their report shards a
 * week longer — and `…/status` reaches one only by an explicit `jobId`. This
 * route is how a FINISHED run is found again.
 *
 * ⚠️ The query rides the hand-declared composite `(integracaoId ASC, startedAt
 * DESC)` in `firestore.indexes.json`. On Firestore ENTERPRISE a missing
 * composite does not throw — the query silently full-scans and the scan is
 * billed — and this collection has no `meta.defaultQuery` for the lint rule to
 * see, so the backstop is `historicoIndex.test.ts` beside this file, which
 * derives the requirement from THIS source. Deploying the index is the
 * migration window's (#1532), never ours.
 *
 * ⚠️ PROJECTED at the query ({@link CAMPOS_PROJETADOS}): `fila` (a whole plan
 * page of listings with their models) and the two capped samples never leave
 * Firestore for a page of up to fifty runs; the status route carries the
 * samples for the one run the operator opens.
 *
 * ⚠️ A run past its TTL expiry is HIDDEN, although it may still be readable:
 * the policy deletes the run and its shards independently, in no order and
 * with no bound on the lag, so an expired run can outlive its shards and would
 * be offered with a truncated report. Filtered after the limit, so an expiry at
 * the tail can return fewer than `limite` runs — the oldest are the ones that
 * expire. A run with no `expiraEm` (written before the stamp) never expires and
 * is always shown.
 */
import { NextResponse } from 'next/server';
import { envioPrecoShopeeCollection } from '@delfrance/data/admin/collections';
import { ttlExpirado } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { naoDocId } from '@/lib/shopee/anuncios/corpoPublicacao';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Runs returned when the caller names no `limite`. */
const LIMITE_PADRAO = 20;

/** Hard ceiling on one page. */
const LIMITE_MAXIMO = 50;

const MSG_INTEGRACAO_ID_INVALIDO = 'integracaoId deve ser um id de documento (sem "/" nem "..").';

/**
 * The document fields this route reads — the response projection, applied at
 * the QUERY so the unread ones never leave Firestore. The status route's
 * fields minus the two samples, plus `expiraEm`, which is read and never
 * returned: it decides whether the run is offered at all.
 *
 * Exported so its test pins the set against `envioPrecoShopeeSchema`: every
 * field with no schema default must be here or every parse fails, and a field
 * the body reads but this omits would silently answer its DEFAULT.
 */
export const CAMPOS_PROJETADOS = [
  'integracaoId',
  'status',
  'baixarPreco',
  'planejados',
  'enviados',
  'pulados',
  'falhas',
  'pausas',
  'parques',
  'retomarEm',
  'filaRestante',
  'relatorioCompleto',
  'relatorioShards',
  'startedAt',
  'updatedAt',
  'finishedAt',
  'erro',
  'expiraEm',
] as const;

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = params.get('integracaoId');
  if (integracaoId === null || naoDocId(integracaoId)) {
    return NextResponse.json({ error: MSG_INTEGRACAO_ID_INVALIDO }, { status: 400 });
  }

  const limite = lerLimite(params.get('limite'));
  if (limite === null) {
    return NextResponse.json(
      { error: `limite deve ser um inteiro entre 1 e ${String(LIMITE_MAXIMO)}.` },
      { status: 400 },
    );
  }

  // ONE clock read — the instant every run's expiry is judged against.
  const nowMs = Date.now();
  const db = getAdminFirestore();
  const snap = await envioPrecoShopeeCollection
    .ref(db, {})
    .where('integracaoId', '==', integracaoId)
    .orderBy('startedAt', 'desc')
    .select(...CAMPOS_PROJETADOS)
    .limit(limite)
    .get();

  const envios = snap.docs.flatMap((doc) => {
    const job = envioPrecoShopeeCollection.parseRead(
      doc.data(),
      envioPrecoShopeeCollection.docPath({}, doc.id),
    );
    if (ttlExpirado(job.expiraEm, nowMs)) return [];
    return [
      {
        jobId: doc.id,
        integracaoId: job.integracaoId,
        status: job.status,
        baixarPreco: job.baixarPreco,
        planejados: job.planejados,
        enviados: job.enviados,
        pulados: job.pulados,
        falhas: job.falhas,
        pausas: job.pausas,
        parques: job.parques,
        retomarEm: job.retomarEm,
        filaRestante: job.filaRestante,
        relatorioCompleto: job.relatorioCompleto,
        relatorioShards: job.relatorioShards,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt,
        erro: job.erro,
      },
    ];
  });

  return NextResponse.json({ envios });
}

/**
 * `null` = the caller sent something this route refuses. An ABSENT (or empty)
 * `limite` takes the default; digits only, so `1.5`, `-1` and `1e1` never
 * reach `Number`.
 */
function lerLimite(raw: string | null): number | null {
  if (raw === null || raw === '') return LIMITE_PADRAO;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= LIMITE_MAXIMO ? n : null;
}
