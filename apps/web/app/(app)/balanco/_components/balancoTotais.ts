'use client';

import {
  documentId,
  getDoc,
  getDocs,
  orderBy,
  query,
  startAfter,
  limit as qLimit,
  where,
  type DocumentSnapshot,
  type Firestore,
  type QuerySnapshot,
} from 'firebase/firestore';
import { and, equal, execute, field, sum } from 'firebase/firestore/pipelines';
import { isPipelineSupported } from '@delfrance/data/pipeline-queries';
import { makeEstoqueUid, type ItemRelatorioBalanco } from '@delfrance/schemas';
import { estoqueProdutoCollection } from '@/lib/data/estoqueProdutoCollection';
import { movimentoBalancoCollection } from '@/lib/data/movimentoBalancoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { relatorioBalancoCollection } from '@/lib/data/relatorioBalancoCollection';

/** One line of the review table / CSV, whatever its source. */
export interface LinhaRevisao {
  produtoId: string;
  sku: string | null;
  nome: string | null;
  /** Stock at the moment the row was produced — live, or frozen at finalize. */
  estoque: number | null;
  /** Units counted. `null` = never counted (only appears on a finalized report). */
  contado: number | null;
  /** Extra estoque docs found for this produto+depósito (finalized reports only). */
  estoquesExtras: number | null;
}

const PAGINA = 300;

/** Fold aggregate/raw rows into produtoId → units. Pure, so it is unit-testable. */
export function reduzirTotais(linhas: Array<{ produtoId: unknown; total: unknown }>) {
  const totais = new Map<string, number>();
  for (const { produtoId, total } of linhas) {
    if (typeof produtoId !== 'string' || produtoId === '') continue;
    if (typeof total !== 'number' || !Number.isFinite(total)) continue;
    totais.set(produtoId, (totais.get(produtoId) ?? 0) + total);
  }
  return totais;
}

/**
 * Units counted per produto, for a balanço still open.
 *
 * One pipeline aggregate grouped by the denormalized `produtoId` when the SDK
 * exposes pipelines, otherwise a paged read reduced in memory. Legacy walked
 * distinct produtos with a cursor and ran one `sum()` per produto — 2 round
 * trips each, and the review screen re-did the whole walk on every open.
 *
 * ⚠️ The fallback is not dead code: pipelines do not run against the Firestore
 * emulator, which is where the balanço e2e lane runs.
 */
export async function carregarTotaisLancados(
  db: Firestore,
  balancoId: string,
): Promise<Map<string, number>> {
  const caminho = movimentoBalancoCollection.resolvePath({ balancoId });

  if (isPipelineSupported(db)) {
    const snap = await execute(
      db
        .pipeline()
        .collection(caminho)
        .where(and(equal(field('error'), false), equal(field('removido'), false)))
        .aggregate({
          accumulators: [sum('quantidade').as('total')],
          groups: ['produtoId'],
        }),
    );
    return reduzirTotais(
      snap.results.map((r) => r.data() as { produtoId: unknown; total: unknown }),
    );
  }

  const linhas: Array<{ produtoId: unknown; total: unknown }> = [];
  const base = movimentoBalancoCollection.ref(db, { balancoId });
  let cursor: DocumentSnapshot | null = null;
  for (;;) {
    const pagina: QuerySnapshot = await getDocs(
      cursor
        ? query(
            base,
            where('error', '==', false),
            where('removido', '==', false),
            orderBy(documentId()),
            startAfter(cursor),
            qLimit(PAGINA),
          )
        : query(
            base,
            where('error', '==', false),
            where('removido', '==', false),
            orderBy(documentId()),
            qLimit(PAGINA),
          ),
    );
    if (pagina.empty) break;
    for (const doc of pagina.docs) {
      const dados = doc.data();
      linhas.push({ produtoId: dados.produtoId, total: dados.quantidade });
    }
    if (pagina.size < PAGINA) break;
    cursor = pagina.docs[pagina.size - 1] ?? null;
    if (!cursor) break;
  }
  return reduzirTotais(linhas);
}

/** Produto sku/nome for a set of ids, read in parallel chunks. */
async function carregarDetalhes(db: Firestore, ids: string[]) {
  const detalhes = new Map<string, { sku: string | null; nome: string | null }>();
  for (let i = 0; i < ids.length; i += 20) {
    const fatia = ids.slice(i, i + 20);
    const snaps = await Promise.all(
      fatia.map((id) => getDoc(produtoCollection.docRef(db, {}, id))),
    );
    snaps.forEach((snap, j) => {
      const id = fatia[j];
      if (id === undefined) return;
      const p = snap.exists() ? snap.data() : null;
      detalhes.set(id, { sku: p?.sku ?? null, nome: p?.nome ?? null });
    });
  }
  return detalhes;
}

/**
 * The live review table: what was counted, against the stock as it stands right
 * now. Read per produto at the canonical `est-<produtoId>-<depositoId>` id, so
 * the cost is O(distinct produtos counted) rather than the whole depósito.
 *
 * ⚠️ This is a LIVE read, not a snapshot of what the finalize will apply — the
 * server re-reads every estoque inside its own transaction. A difference shown
 * here can be stale by the time Finalizar runs, which is exactly why the stored
 * report records the value the transaction actually replaced.
 */
export async function carregarRevisaoAoVivo(
  db: Firestore,
  balancoId: string,
  depositoId: string,
): Promise<LinhaRevisao[]> {
  const totais = await carregarTotaisLancados(db, balancoId);
  const ids = [...totais.keys()];
  const detalhes = await carregarDetalhes(db, ids);

  const linhas: LinhaRevisao[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const fatia = ids.slice(i, i + 20);
    const snaps = await Promise.all(
      fatia.map((produtoId) =>
        getDoc(
          estoqueProdutoCollection.docRef(db, { produtoId }, makeEstoqueUid(produtoId, depositoId)),
        ),
      ),
    );
    snaps.forEach((snap, j) => {
      const produtoId = fatia[j];
      if (produtoId === undefined) return;
      linhas.push({
        produtoId,
        sku: detalhes.get(produtoId)?.sku ?? null,
        nome: detalhes.get(produtoId)?.nome ?? null,
        // No estoque doc means no stock in this depósito — 0, not unknown.
        estoque: snap.exists() ? (snap.data().quantidade ?? 0) : 0,
        contado: totais.get(produtoId) ?? 0,
        estoquesExtras: null,
      });
    });
  }
  return linhas.sort((a, b) => (a.nome ?? '').localeCompare(b.nome ?? ''));
}

/**
 * The finalized report, read straight from the stored `relatorios` shards.
 *
 * Zero produto reads and zero estoque reads: each shard item already carries
 * `sku`, `nome` and the `estoque` value the applying transaction replaced.
 * Legacy re-fetched every produto in batches of 30 to render the same table,
 * and read live estoque — which by then no longer matched what was applied.
 */
export async function carregarRelatorioFinalizado(
  db: Firestore,
  balancoId: string,
): Promise<LinhaRevisao[]> {
  const shards = await getDocs(relatorioBalancoCollection.ref(db, { balancoId }));
  const linhas: LinhaRevisao[] = [];
  for (const shard of shards.docs) {
    const itens = shard.data().itens as Record<string, ItemRelatorioBalanco>;
    for (const [produtoId, item] of Object.entries(itens ?? {})) {
      linhas.push({
        produtoId,
        sku: item?.sku ?? null,
        nome: item?.nome ?? null,
        estoque: item?.estoque ?? null,
        contado: item?.contado ?? null,
        estoquesExtras: item?.estoquesExtras ?? null,
      });
    }
  }
  return linhas.sort((a, b) => (a.nome ?? '').localeCompare(b.nome ?? ''));
}

/** `contado − estoque`, or null when either side is unknown. */
export function diferenca(linha: LinhaRevisao): number | null {
  if (linha.estoque == null) return null;
  return (linha.contado ?? 0) - linha.estoque;
}
