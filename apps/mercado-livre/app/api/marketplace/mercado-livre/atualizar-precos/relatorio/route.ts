/**
 * `GET /api/marketplace/mercado-livre/atualizar-precos/relatorio?integracaoId=…&jobId=…&depois=…&limite=…`
 * — one page of a run's COMPLETE per-item report, for the CSV download.
 * Requires `PERM.integracao.read`.
 *
 * Pages the `relatorios` subcollection by `__name__`. The shard ids are
 * zero-padded, so lexical order IS shard order and this needs **no index** —
 * unlike the `historico` route beside it.
 *
 * ⚠️ Paged rather than materialised, and the budget is the APP HOSTING
 * backend's, not the worker's 540s: `apphosting.yaml` pins `timeoutSeconds: 180`,
 * `memoryMiB: 512` and `concurrency: 80` — about 6 MiB of heap per in-flight
 * request. A 10k-row report is several MB of JSON plus parsed objects, so two
 * concurrent downloads would OOM the instance and take every webhook ack with
 * them; `minInstances: 0` makes the restart a cold start.
 *
 * ⚠️ `mensagem` is RENDERED here, never stored. Rows carry the `motivo` code and
 * `mensagemDe` turns it into pt-BR at read time, so fixing a wording applies
 * retroactively to runs already recorded — the convention `envioPrecoListingSchema`
 * already sets on the manual push.
 *
 * ⚠️ `produtoNome`/`sku` are JOINED here, deliberately not denormalised onto the
 * row. Carrying them to the drain loop would mean carrying them through `fila`,
 * which is rewritten after every item: +43% per draft, ~0.8 GB of extra writes
 * per run, to save this one batched read per download. See the schema's own ⚠️.
 */
import { FieldPath } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import type { Firestore } from 'firebase-admin/firestore';
import type { LinhaRelatorioEnvioPreco } from '@delfrance/schemas';
import {
  envioPrecoMercadoLivreCollection,
  produtoCollection,
  relatorioEnvioPrecoMercadoLivreCollection,
} from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { mensagemDe } from '@/lib/marketplace/preco/precoMotivos';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Shards per page. 4 × 500 ≈ 2000 rows ≈ 500 KB of JSON — inside the ~6 MiB budget. */
const LIMITE_PADRAO = 4;

/** Hard ceiling: 8 shards ≈ 4000 rows, still comfortably under the per-request budget. */
const LIMITE_MAXIMO = 8;

/** Firestore's `getAll` is unbounded but the request has a size limit; chunk the join. */
const PRODUTOS_POR_LOTE = 300;

/**
 * The job-doc fields this route reads, applied as a `fieldMask` so the rest never
 * leaves Firestore.
 *
 * ⚠️ `fila` is the reason this exists, exactly as on the sibling `historico`
 * route. It holds up to `PLAN_PAGE_DRAFTS_CAP` (2000) drafts — ~344 KB at the
 * schema's own 176 B/draft — and it is NOT empty on the jobs this download is
 * for: `failJob` stamps `filaRestante` without clearing `fila`, so a run that
 * died with a full queue keeps every draft. An unprojected read pulled all of it
 * on EVERY page of the loop, up to `MAX_PAGINAS` (100) times per download, for
 * job facts that cannot change between pages of a finished run.
 *
 * ⚠️ `updatedAt` is masked in although the response never returns it: the schema
 * has no default for it, so `parseRead` would throw without it. The other three
 * in that class — `integracaoId`, `status`, `startedAt` — are returned anyway.
 * `projecao.test.ts` pins the whole set against the schema.
 */
export const CAMPOS_JOB = [
  'integracaoId',
  'status',
  'updatedAt',
  'relatorioLinhas',
  'relatorioShards',
  'relatorioCompleto',
  'filaRestante',
  'planejados',
  'enviados',
  'pulados',
  'falhas',
  'startedAt',
  'finishedAt',
] as const;

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;

  const searchParams = new URL(req.url).searchParams;
  const integracaoId = searchParams.get('integracaoId');
  const jobId = searchParams.get('jobId');
  if (!integracaoId || !jobId) {
    return NextResponse.json({ error: 'integracaoId e jobId são obrigatórios.' }, { status: 400 });
  }

  const limite = parseLimite(searchParams.get('limite'));
  if (limite === null) {
    return NextResponse.json(
      { error: `limite deve ser um inteiro entre 1 e ${String(LIMITE_MAXIMO)}.` },
      { status: 400 },
    );
  }
  const depois = searchParams.get('depois');
  if (depois != null && depois !== '' && !SHARD_ID.test(depois)) {
    // ⚠️ Validated for the same reason `limite` is refused rather than clamped,
    // and for one more: the admin SDK throws SYNCHRONOUSLY on a `__name__`
    // cursor containing a slash ("must be a plain document ID"), so an unchecked
    // `?depois=a/b` handed an authed caller a 500 with a stack where every other
    // bad param here gets a 400.
    return NextResponse.json({ error: 'depois deve ser um id de shard válido.' }, { status: 400 });
  }

  const db = getAdminFirestore();

  // Same 404 ladder as the status route: a jobId belonging to another conta is
  // indistinguishable from one that does not exist. Projected — see CAMPOS_JOB.
  const [jobSnap] = await db.getAll(envioPrecoMercadoLivreCollection.docRef(db, {}, jobId), {
    fieldMask: [...CAMPOS_JOB],
  });
  if (!jobSnap?.exists) {
    return NextResponse.json({ error: 'Envio de preços não encontrado.' }, { status: 404 });
  }
  const job = envioPrecoMercadoLivreCollection.parseRead(
    jobSnap.data(),
    envioPrecoMercadoLivreCollection.docPath({}, jobId),
  );
  if (job.integracaoId !== integracaoId) {
    return NextResponse.json({ error: 'Envio de preços não encontrado.' }, { status: 404 });
  }

  let query = relatorioEnvioPrecoMercadoLivreCollection
    .ref(db, { envioId: jobId })
    .orderBy(FieldPath.documentId());
  if (depois != null && depois !== '') query = query.startAfter(depois);
  const snap = await query.limit(limite).get();

  const linhas: LinhaRelatorioEnvioPreco[] = [];
  for (const doc of snap.docs) {
    const shard = relatorioEnvioPrecoMercadoLivreCollection.parseRead(
      doc.data(),
      relatorioEnvioPrecoMercadoLivreCollection.docPath({ envioId: jobId }, doc.id),
    );
    linhas.push(...Object.values(shard.linhas));
  }

  const nomes = await lerNomes(
    db,
    linhas.map((l) => l.produtoId),
  );

  return NextResponse.json({
    linhas: linhas.map((l) => ({
      ...l,
      produtoNome: nomes.get(l.produtoId)?.nome ?? null,
      sku: nomes.get(l.produtoId)?.sku ?? null,
      // Rendered, never stored — see the module docblock.
      mensagem: l.motivo == null ? null : mensagemDe(l.motivo),
    })),
    /** `null` = last page. The caller loops until it sees this. */
    proximoDepois: snap.docs.length === limite ? (snap.docs.at(-1)?.id ?? null) : null,
    // The job-level facts the CSV's completeness trailer needs. Without them a
    // truncated report is indistinguishable from a clean one.
    status: job.status,
    relatorioLinhas: job.relatorioLinhas,
    relatorioShards: job.relatorioShards,
    relatorioCompleto: job.relatorioCompleto,
    filaRestante: job.filaRestante,
    planejados: job.planejados,
    enviados: job.enviados,
    pulados: job.pulados,
    falhas: job.falhas,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  });
}

/**
 * Batched `nome`/`sku` for the distinct anchors on this page. A family
 * contributes many rows per anchor, so the distinct set is far smaller than the
 * row count.
 */
async function lerNomes(
  db: Firestore,
  produtoIds: readonly string[],
): Promise<Map<string, { nome: string | null; sku: string | null }>> {
  const distintos = [...new Set(produtoIds)];
  const out = new Map<string, { nome: string | null; sku: string | null }>();
  for (let i = 0; i < distintos.length; i += PRODUTOS_POR_LOTE) {
    const lote = distintos.slice(i, i + PRODUTOS_POR_LOTE);
    const snaps = await db.getAll(...lote.map((id) => produtoCollection.docRef(db, {}, id)), {
      fieldMask: ['nome', 'sku'],
    });
    for (const snap of snaps) {
      // ⚠️ A missing produto is DATA, not an error: the reconciliation phase
      // exists precisely because a row can point at a produto that no longer
      // exists. It reads back as blank columns, never as a failed download.
      if (!snap.exists) continue;
      const raw = (snap.data() ?? {}) as { nome?: unknown; sku?: unknown };
      out.set(snap.id, {
        nome: typeof raw.nome === 'string' ? raw.nome : null,
        sku: typeof raw.sku === 'string' ? raw.sku : null,
      });
    }
  }
  return out;
}

/** Same discipline as the historico route: refuse an out-of-range value, never clamp it. */
function parseLimite(raw: string | null): number | null {
  if (raw === null || raw === '') return LIMITE_PADRAO;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= LIMITE_MAXIMO ? n : null;
}

/** A shard id as `relatorioEnvioPrecoShardId` mints them — `String(i).padStart(4, '0')`. */
const SHARD_ID = /^\d{4,}$/;
