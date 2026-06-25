'use client';

/**
 * Batch helpers for the comum (warehouse) print: build many pedidos' print
 * models in bounded concurrent waves (the dominant cost is Firestore + image
 * I/O, so a wave of ~10 keeps the connection busy without a thundering herd),
 * and mark the printed pedidos with `foiImpresso` + `dtImpressao` in chunked
 * writes. Port of the Flutter `printPedidos` stream (waves of 10 + a final
 * WriteBatch).
 */
import { writeBatch, type Firestore } from 'firebase/firestore';

import { pedidoCollection } from '@/lib/data/pedidoCollection';

import { buildPrintModel, type AssembleOptions } from './assemble';
import type { PedidoPrintModel } from './model';

const WAVE_SIZE = 10;
/** Firestore caps a WriteBatch at 500 ops; stay under it. */
const BATCH_LIMIT = 450;

export interface BuildModelsResult {
  readonly models: PedidoPrintModel[];
  readonly failures: ReadonlyArray<{ pedidoId: string; message: string }>;
}

/**
 * Build print models for many pedidos in concurrent waves, reporting progress.
 * A pedido that fails to load is collected in `failures` (so one bad doc never
 * kills a 500-pedido batch) instead of rejecting the whole run.
 */
export async function buildModelsInWaves(
  db: Firestore,
  pedidoIds: readonly string[],
  opts: AssembleOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<BuildModelsResult> {
  const models: PedidoPrintModel[] = [];
  const failures: { pedidoId: string; message: string }[] = [];
  let done = 0;

  for (let i = 0; i < pedidoIds.length; i += WAVE_SIZE) {
    const wave = pedidoIds.slice(i, i + WAVE_SIZE);
    const settled = await Promise.allSettled(wave.map((id) => buildPrintModel(db, id, opts)));
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        models.push(r.value);
      } else {
        failures.push({
          pedidoId: wave[idx]!,
          message: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    });
    done += wave.length;
    onProgress?.(done, pedidoIds.length);
  }

  return { models, failures };
}

/**
 * Mark pedidos as printed — `foiImpresso = true` + `dtImpressao = nowMicros`
 * (microseconds since epoch) — in chunked WriteBatches.
 */
export async function markPedidosPrinted(
  db: Firestore,
  pedidoIds: readonly string[],
  nowMicros: number,
): Promise<void> {
  for (let i = 0; i < pedidoIds.length; i += BATCH_LIMIT) {
    const chunk = pedidoIds.slice(i, i + BATCH_LIMIT);
    const batch = writeBatch(db);
    for (const id of chunk) {
      batch.update(pedidoCollection.docRef(db, {}, id), {
        foiImpresso: true,
        dtImpressao: nowMicros,
      });
    }
    await batch.commit();
  }
}
