'use client';

import { useMemo } from 'react';
import { useDocSnapshot } from '@delfrance/data/hooks';
import {
  estadoBalanco,
  idFromRef,
  type Balanco,
  type EstadoBalancoVisivel,
} from '@delfrance/schemas';
import { balancoCollection } from '@/lib/data/balancoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export interface BalancoCarregado {
  balanco: Balanco | null | undefined;
  /** `'aberto'` when `estado` is null — never compare the field by hand. */
  estado: EstadoBalancoVisivel;
  depositoId: string;
  loading: boolean;
  error: Error | undefined;
}

/**
 * Live view of one balanço. Real-time on purpose rather than a one-shot read:
 * the finalize runs server-side in a Cloud Tasks worker, so `finalizacao`'s
 * progress and the eventual `finalizado` / `erro` land on this document with no
 * client involvement — the screen has to learn about them by watching.
 */
export function useBalanco(balancoId: string): BalancoCarregado {
  const db = getFirebaseFirestore();
  const ref = useMemo(() => balancoCollection.docRef(db, {}, balancoId), [db, balancoId]);
  const { data, loading, error } = useDocSnapshot<Balanco>(ref);
  // `useDocSnapshot` wraps the doc as `{ id, data }`, `null` when it does not
  // exist and `undefined` before the first emission — three distinct states the
  // screens branch on.
  const balanco = data === undefined ? undefined : (data?.data ?? null);
  return {
    balanco,
    estado: balanco ? estadoBalanco(balanco) : 'aberto',
    depositoId: balanco ? idFromRef(balanco.depositoOuterRef) : '',
    loading,
    error,
  };
}
