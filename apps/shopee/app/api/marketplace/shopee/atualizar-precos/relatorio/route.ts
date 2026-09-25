/**
 * `GET /api/marketplace/shopee/atualizar-precos/relatorio?integracaoId=…&jobId=…&depois=…`
 * — one PAGE of a run's complete per-model report, as JSON (#1521, step 13).
 * Requires `PERM.integracao.write`, like every route of the job. The CSV is
 * step 21's; this route is what it will page over.
 *
 * Pages the run's `relatorios` subcollection by `__name__`,
 * {@link SHARDS_POR_PAGINA} shards at a time, after the shard id `depois`. The
 * shard ids are zero-padded, so lexical order IS shard order and this needs
 * **no index**. `proximoDepois` is the id to pass next, `null` on the last
 * page. `depois` is VALIDATED (`/^\d{4,}$/`, else 400): the Admin SDK throws
 * SYNCHRONOUSLY on a `__name__` cursor containing a slash, so an unchecked
 * `?depois=a/b` would hand an authed caller a 500 with a stack.
 *
 * ⚠️ `mensagem` is RENDERED here, never stored: each row carries its motivo and
 * `mensagemDoMotivoDePreco` turns it into pt-BR at read time — a clean send
 * included — so a fixed wording applies to runs already recorded.
 *
 * ⚠️ `produtoNome` / `sku` are JOINED here, never denormalised onto the row:
 * the row is written from the drain loop, which sees only the queue's
 * identities, and carrying names through a queue rewritten after every item
 * would cost far more than one batched read per page. The join key is the
 * produto that PRICED the row — `variacaoProdutoId ?? produtoId` — so a
 * per-model row names its variation. A missing produto (or a run's synthetic
 * `job-*` row, whose id names the conta) reads back as blank columns, never as
 * a failed page.
 *
 * ⚠️ The job is read through a `fieldMask` ({@link CAMPOS_JOB}): a run that
 * stopped short keeps its whole `fila`, and every page of a download would
 * otherwise pull it again for facts that cannot change between pages. Same
 * 404 ladder as `…/status` — another conta's run is indistinguishable from
 * one that does not exist.
 */
import { FieldPath } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import {
  envioPrecoShopeeCollection,
  produtoCollection,
  relatorioEnvioPrecoShopeeCollection,
} from '@delfrance/data/admin/collections';
import type { LinhaRelatorioEnvioPreco } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { naoDocId } from '@/lib/shopee/anuncios/corpoPublicacao';
import { mensagemDoMotivoDePreco } from '@/lib/shopee/precos/errosPreco';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Shards per page: 4 × 500 rows ≈ 2 000 rows, a few hundred KB of JSON —
 * inside one App Hosting request's heap share with room to spare.
 */
export const SHARDS_POR_PAGINA = 4;

/** `getAll` is unbounded but a request is not; the name join is chunked. */
const PRODUTOS_POR_LOTE = 300;

/** A shard id as `relatorioEnvioPrecoShardId` mints them — `String(i).padStart(4, '0')`. */
const SHARD_ID = /^\d{4,}$/;

/** One sentence for both leaks, because they are the same leak. */
const MSG_NAO_ENCONTRADO = 'Atualização de preços não encontrada.';

const MSG_INTEGRACAO_ID_INVALIDO = 'integracaoId deve ser um id de documento (sem "/" nem "..").';
const MSG_JOB_ID_INVALIDO = 'jobId deve ser um id de documento (sem "/" nem "..").';
const MSG_DEPOIS_INVALIDO = 'depois deve ser um id de shard válido.';

/**
 * The job fields this route reads, as a `fieldMask`. `updatedAt` is masked in
 * although the body never returns it: the schema has no default for it, so
 * the parse would throw without it — the same holds for `startedAt`.
 */
export const CAMPOS_JOB = [
  'integracaoId',
  'status',
  'startedAt',
  'updatedAt',
  'relatorioCompleto',
  'filaRestante',
] as const;

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = params.get('integracaoId');
  if (integracaoId === null || naoDocId(integracaoId)) {
    return NextResponse.json({ error: MSG_INTEGRACAO_ID_INVALIDO }, { status: 400 });
  }
  const jobId = params.get('jobId');
  if (jobId === null || naoDocId(jobId)) {
    return NextResponse.json({ error: MSG_JOB_ID_INVALIDO }, { status: 400 });
  }
  // Absent or empty ⇒ the first page. Present ⇒ a shard id, or a 400.
  const depoisBruto = params.get('depois');
  const depois = depoisBruto === null || depoisBruto === '' ? null : depoisBruto;
  if (depois !== null && !SHARD_ID.test(depois)) {
    return NextResponse.json({ error: MSG_DEPOIS_INVALIDO }, { status: 400 });
  }

  const db = getAdminFirestore();
  const [jobSnap] = await db.getAll(envioPrecoShopeeCollection.docRef(db, {}, jobId), {
    fieldMask: [...CAMPOS_JOB],
  });
  if (!jobSnap?.exists) return NextResponse.json({ error: MSG_NAO_ENCONTRADO }, { status: 404 });
  const job = envioPrecoShopeeCollection.parseRead(
    jobSnap.data(),
    envioPrecoShopeeCollection.docPath({}, jobId),
  );
  if (job.integracaoId !== integracaoId) {
    return NextResponse.json({ error: MSG_NAO_ENCONTRADO }, { status: 404 });
  }

  let consulta = relatorioEnvioPrecoShopeeCollection
    .ref(db, { envioId: jobId })
    .orderBy(FieldPath.documentId());
  if (depois !== null) consulta = consulta.startAfter(depois);
  const snap = await consulta.limit(SHARDS_POR_PAGINA).get();

  const linhas: LinhaRelatorioEnvioPreco[] = [];
  for (const doc of snap.docs) {
    const shard = relatorioEnvioPrecoShopeeCollection.parseRead(
      doc.data(),
      relatorioEnvioPrecoShopeeCollection.docPath({ envioId: jobId }, doc.id),
    );
    linhas.push(...Object.values(shard.linhas));
  }

  const nomes = await lerNomes(db, linhas.map(chaveDoNome));

  return NextResponse.json({
    // Built BY NAME: a key a newer writer adds to a stored row must not leave
    // through the body.
    linhas: linhas.map((l) => {
      const nome = nomes.get(chaveDoNome(l));
      return {
        produtoId: l.produtoId,
        variacaoProdutoId: l.variacaoProdutoId,
        anuncioId: l.anuncioId,
        linkDocId: l.linkDocId,
        resultado: l.resultado,
        fase: l.fase,
        motivo: l.motivo,
        mensagem: mensagemDoMotivoDePreco(l.motivo),
        erro: l.erro,
        preco: l.preco,
        precoAnterior: l.precoAnterior,
        produtoNome: nome?.nome ?? null,
        sku: nome?.sku ?? null,
      };
    }),
    /** `null` = the last page. The caller loops until it sees this. */
    proximoDepois: snap.docs.length === SHARDS_POR_PAGINA ? (snap.docs.at(-1)?.id ?? null) : null,
    // The job-level facts that tell a complete report from a truncated one.
    status: job.status,
    relatorioCompleto: job.relatorioCompleto,
    filaRestante: job.filaRestante,
  });
}

/** The produto whose name and SKU a row shows — the one that priced it. */
function chaveDoNome(l: LinhaRelatorioEnvioPreco): string {
  return l.variacaoProdutoId ?? l.produtoId;
}

/**
 * Batched `nome` / `sku` for the distinct produtos on this page, a field mask
 * per read. A family contributes a row per model, so the distinct set is far
 * smaller than the row count.
 */
async function lerNomes(
  db: Firestore,
  produtoIds: readonly string[],
): Promise<Map<string, { nome: string | null; sku: string | null }>> {
  const distintos = [...new Set(produtoIds)];
  const saida = new Map<string, { nome: string | null; sku: string | null }>();
  for (let i = 0; i < distintos.length; i += PRODUTOS_POR_LOTE) {
    const lote = distintos.slice(i, i + PRODUTOS_POR_LOTE);
    const snaps = await db.getAll(...lote.map((id) => produtoCollection.docRef(db, {}, id)), {
      fieldMask: ['nome', 'sku'],
    });
    for (const s of snaps) {
      // ⚠️ A missing produto is DATA, not an error: it reads back as blanks.
      if (!s.exists) continue;
      const bruto = (s.data() ?? {}) as { nome?: unknown; sku?: unknown };
      saida.set(s.id, {
        nome: typeof bruto.nome === 'string' ? bruto.nome : null,
        sku: typeof bruto.sku === 'string' ? bruto.sku : null,
      });
    }
  }
  return saida;
}
