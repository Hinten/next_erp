'use client';

import { httpsCallable } from 'firebase/functions';
import type { FinalizarBalancoComando, FinalizarBalancoResult } from '@delfrance/data/balanco';
import { getFirebaseFunctions } from '@/lib/firebase/client';

/**
 * Invoke the server-owned `finalizarBalanco` callable (apps/functions).
 *
 * ⚠️ Note what this does NOT send: no quantities, no produto list, no motivo.
 * The whole point of the callable is that every number landing on stock is
 * derived server-side from the balanço's own movimentos — the legacy Flutter
 * finalize applied client-supplied values with no server validation at all.
 *
 * Returns as soon as the job is QUEUED, not when it is done. The caller follows
 * `finalizacao.shardCursor` / `finalizacao.shards` on the balanço doc for
 * progress. Failures arrive as a `FirebaseError` (FunctionsError) the callers
 * narrow on — `failed-precondition` means the balanço was already applied.
 */
export async function finalizarBalanco(
  comando: FinalizarBalancoComando,
): Promise<FinalizarBalancoResult> {
  const fn = httpsCallable<FinalizarBalancoComando, FinalizarBalancoResult>(
    getFirebaseFunctions(),
    'finalizarBalanco',
  );
  const { data } = await fn(comando);
  return data;
}
