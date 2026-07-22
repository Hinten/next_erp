import { FirebaseError } from 'firebase/app';
import { updateDoc, type Firestore } from 'firebase/firestore';
import { ZodError } from 'zod';
import type { PrecosMap } from '@delfrance/schemas';
import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { produtoCollection } from '@/lib/data/produtoCollection';
import type { ApplyOutcome, ApplyProgress } from './types';

/**
 * Chunk size for the apply phase of the bulk price-recalculation screen
 * (#544) — both the `getDocsByIds` batch size and the write concurrency
 * within a chunk (writes inside a chunk run via `Promise.all`).
 */
export const APPLY_CONCURRENCY = 5;

/** The slice of a fresh produto read that `applyPrecoAlteracoes` needs. */
export interface ProdutoPrecosSnapshot {
  precos: PrecosMap;
}

export interface ApplyPrecoAlteracoesArgs {
  /** The lista de preços id whose `precos[targetListaId]` entry is being written. */
  targetListaId: string;
  rows: ReadonlyArray<{ produtoId: string; novoValor: number }>;
  /**
   * Optional last-mile gate re-checked against the FRESH price right before
   * writing (e.g. re-apply the chosen `AplicarMode` against a price that may
   * have moved since the results table was computed). Returning `false` skips
   * the row (`'pulado'`) without writing.
   */
  gate?: (precoAtualFresco: number | null, novo: number) => boolean;
  onProgress?: (p: ApplyProgress) => void;
  chunkSize?: number;
  signal?: AbortSignal;
  /** DI seam for tests — defaults to a real `getDocsByIds` re-read. */
  fetchFresh?: (
    db: Firestore,
    ids: readonly string[],
  ) => Promise<Map<string, ProdutoPrecosSnapshot>>;
  /** DI seam for tests — defaults to the real Firestore `updateDoc` write. */
  write?: (db: Firestore, produtoId: string, precos: PrecosMap) => Promise<void>;
}

async function defaultFetchFresh(
  db: Firestore,
  ids: readonly string[],
): Promise<Map<string, ProdutoPrecosSnapshot>> {
  const fresh = await getDocsByIds(db, produtoCollection, ids);
  const out = new Map<string, ProdutoPrecosSnapshot>();
  for (const [id, produto] of fresh) out.set(id, { precos: produto.precos });
  return out;
}

/**
 * Write ONLY the parent produto's `precos` map. History (`historicoDePrecos`)
 * and parent→children propagation are owned server-side by the
 * `onProdutoPrecoCustoChanged` Cloud Function trigger — this never touches
 * either.
 *
 * Uses the collection handle's `docRef` + Firestore's `updateDoc`, not the
 * handle's `merge()`: `merge()` writes via `setDoc(..., { merge: true })`,
 * which CREATES the document if it no longer exists — exactly the "resurrect
 * a deleted produto" failure mode this apply step must not have. `updateDoc`
 * fails loud (`not-found`) on a doc deleted mid-run instead, and never runs
 * the ref's converter (converters apply to set/add only), so the patch is a
 * plain whole-map field replace of `precos`.
 */
async function defaultWrite(db: Firestore, produtoId: string, precos: PrecosMap): Promise<void> {
  await updateDoc(produtoCollection.docRef(db, {}, produtoId), { precos });
}

async function processRow(
  db: Firestore,
  targetListaId: string,
  row: { produtoId: string; novoValor: number },
  fresh: Map<string, ProdutoPrecosSnapshot>,
  gate: ((precoAtualFresco: number | null, novo: number) => boolean) | undefined,
  write: (db: Firestore, produtoId: string, precos: PrecosMap) => Promise<void>,
): Promise<ApplyOutcome> {
  const produto = fresh.get(row.produtoId);
  if (!produto) {
    return { produtoId: row.produtoId, status: 'erro', erro: 'Produto não encontrado' };
  }

  const freshAtual = produto.precos?.[targetListaId]?.valor ?? null;

  // No-op BEFORE the gate: a gate that rejects equality (e.g.
  // `deveAplicar('aplicarTudo', …)` returns false when atual === novo) must not
  // reclassify an unchanged row as 'pulado' — it was never going to be written
  // either way, and the concluído summary distinguishes the two buckets
  // (Copilot review, PR #610).
  if (row.novoValor === freshAtual) {
    return { produtoId: row.produtoId, status: 'semAlteracao', erro: null };
  }

  if (gate && !gate(freshAtual, row.novoValor)) {
    return { produtoId: row.produtoId, status: 'pulado', erro: null };
  }

  try {
    const novoPrecos: PrecosMap = {
      ...(produto.precos ?? {}),
      [targetListaId]: { valor: row.novoValor },
    };
    await write(db, row.produtoId, novoPrecos);
    return { produtoId: row.produtoId, status: 'aplicado', erro: null };
  } catch (err) {
    if (err instanceof FirebaseError) {
      return { produtoId: row.produtoId, status: 'erro', erro: `${err.code}: ${err.message}` };
    }
    if (err instanceof ZodError) {
      return { produtoId: row.produtoId, status: 'erro', erro: err.message };
    }
    throw err;
  }
}

/**
 * Apply a set of precomputed `{ produtoId, novoValor }` rows to the target
 * lista de preços, in chunks of `chunkSize` (default {@link APPLY_CONCURRENCY}).
 * Each chunk does a FRESH `getDocsByIds` re-read before writing — the results
 * table may be stale by the time the user hits "Aplicar" — and writes within
 * the chunk run concurrently. `signal` is checked between chunks only: an
 * abort stops issuing further chunks and returns the outcomes collected so
 * far (partial), it never cancels an in-flight chunk.
 */
export async function applyPrecoAlteracoes(
  db: Firestore,
  args: ApplyPrecoAlteracoesArgs,
): Promise<ApplyOutcome[]> {
  const {
    targetListaId,
    rows,
    gate,
    onProgress,
    chunkSize = APPLY_CONCURRENCY,
    signal,
    fetchFresh = defaultFetchFresh,
    write = defaultWrite,
  } = args;

  const outcomes: ApplyOutcome[] = [];
  const total = rows.length;
  let sucesso = 0;
  let erro = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    if (signal?.aborted) break;

    const chunk = rows.slice(i, i + chunkSize);
    const fresh = await fetchFresh(
      db,
      chunk.map((r) => r.produtoId),
    );
    const chunkOutcomes = await Promise.all(
      chunk.map((row) => processRow(db, targetListaId, row, fresh, gate, write)),
    );

    for (const outcome of chunkOutcomes) {
      outcomes.push(outcome);
      if (outcome.status === 'aplicado') sucesso += 1;
      if (outcome.status === 'erro') erro += 1;
    }

    onProgress?.({ done: outcomes.length, total, sucesso, erro });
  }

  return outcomes;
}
