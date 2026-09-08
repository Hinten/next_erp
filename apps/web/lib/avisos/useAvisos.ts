'use client';

import { useCallback, useMemo } from 'react';
import { arrayUnion, limit, orderBy, query, setDoc, where } from 'firebase/firestore';
import {
  type Aviso,
  type AvisosLeitura,
  avisoNaoLido,
  avisosLeituraSchema,
  marcarTodosComoLidos,
} from '@delfrance/schemas';
import { useDocSnapshot, useSnapshot, type SnapshotRow } from '@delfrance/data/hooks';
import { useAuth } from '@/lib/auth';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { avisoCollection, avisosLeituraCollection } from '@/lib/data/avisoCollection';

/**
 * The bell's data source: every open aviso plus this operator's read state.
 *
 * ## Why a listener and not TableView
 *
 * `TableView` prefers the Pipelines path, and `usePipelineSnapshot` is
 * explicitly ONE-SHOT — there is no `onSnapshot` analogue in `firebase@12` — so
 * a TableView-backed bell would show a count frozen at page load. `useSnapshot`
 * is the real-time path.
 *
 * ## Why the query shape is exactly `avisoMeta.defaultQuery`
 *
 * Enterprise creates no indexes, raises no `FAILED_PRECONDITION` on an unindexed
 * query, and bills data scanned — and `limit()` shrinks the RESULT, not the scan.
 * The lint rule and the index backstop only see a query declared as a
 * `meta.defaultQuery` literal; a hand-rolled shape here would be invisible to
 * both, which is exactly the gap where an unindexed full-scanning listener ships
 * green. So this mirrors the declared query and nothing else. Filtering by
 * recipient happens client-side, over rows already in the local cache, per the
 * repo's "filter client-side to use the Firebase cache" guidance.
 */
const LIMITE_AVISOS = 50;

export interface AvisoRow {
  id: string;
  aviso: Aviso;
  naoLido: boolean;
}

export interface UseAvisosResult {
  rows: AvisoRow[];
  naoLidos: number;
  loading: boolean;
  marcarComoLido: (avisoId: string) => Promise<void>;
  marcarTodosLidos: () => Promise<void>;
}

export function useAvisos(): UseAvisosResult {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const q = useMemo(() => {
    if (!uid) return null;
    const db = getFirebaseFirestore();
    return query(
      avisoCollection.ref(db, {}),
      where('resolvidoEm', '==', null),
      orderBy('criadoEm', 'desc'),
      limit(LIMITE_AVISOS),
    );
  }, [uid]);

  const leituraRef = useMemo(() => {
    if (!uid) return null;
    return avisosLeituraCollection.docRef(getFirebaseFirestore(), {}, uid);
  }, [uid]);

  const avisos = useSnapshot(q);
  const leitura = useDocSnapshot(leituraRef);

  // `useDocSnapshot` wraps the document as `{ id, data }`; `data: null` is a
  // document that does not exist yet, which is every operator's first visit —
  // and `avisoNaoLido` treats a null read state as "nothing read", so the bell
  // is correct before the first write rather than empty.
  const estadoLeitura: AvisosLeitura | null = leitura.data?.data ?? null;

  const rows = useMemo<AvisoRow[]>(() => {
    if (!uid || !avisos.data) return [];
    return avisos.data
      .map((row: SnapshotRow<Aviso>) => ({
        id: row.id,
        aviso: row.data,
        naoLido: avisoNaoLido(row.data, row.id, estadoLeitura, uid),
      }))
      .filter((row) => row.aviso.destinatarioUid === null || row.aviso.destinatarioUid === uid);
  }, [avisos.data, estadoLeitura, uid]);

  const marcarComoLido = useCallback(
    async (avisoId: string) => {
      if (!uid) return;
      // `arrayUnion`, not a read-modify-write: two tabs marking different avisos
      // read at the same instant must both stick (rule 7 tier 0 — nothing to
      // compare, nothing to lose).
      //
      // Converter-STRIPPED patch, the repo's established shape for exactly this
      // (`lib/chat/conversaActions.ts`): the converter's `toFirestore` runs a
      // full `schema.parse`, so a converted merge would fill every `.default()`
      // and the merge mask would then wipe `ultimaVisualizacaoUs` back to 0.
      // `.withConverter(null)` writes only the key we set — which a FieldValue
      // sentinel needs anyway, since `arrayUnion` is not a value Zod validates.
      await setDoc(
        avisosLeituraCollection.docRef(getFirebaseFirestore(), {}, uid).withConverter(null),
        { lidos: arrayUnion(avisoId) },
        { merge: true },
      );
    },
    [uid],
  );

  const marcarTodosLidos = useCallback(async () => {
    if (!uid || rows.length === 0) return;
    // One write, not N: the watermark covers everything already raised, and
    // clearing `lidos` in the SAME write is what keeps that array bounded.
    // Advancing one without the other either grows it forever or marks nothing.
    //
    // ⚠️ The watermark is the newest `criadoEm` the operator can SEE, not
    // `Date.now()`. The rows are stamped by a Cloud Function while this runs in a
    // browser, so a local clock reading compares two different clocks: a client a
    // few minutes fast would mark avisos read that have not been raised yet, and
    // they would arrive already counted as read with the bell never lighting.
    // Rows are ordered `criadoEm desc` and capped at the same limit, so the newest
    // visible row is also the newest that exists.
    const ateCriadoEmUs = rows.reduce((max, r) => Math.max(max, r.aviso.criadoEm), 0);
    await setDoc(
      avisosLeituraCollection.docRef(getFirebaseFirestore(), {}, uid),
      avisosLeituraSchema.parse(marcarTodosComoLidos(ateCriadoEmUs)),
    );
  }, [uid, rows]);

  return {
    rows,
    naoLidos: rows.filter((r) => r.naoLido).length,
    loading: avisos.loading || leitura.loading,
    marcarComoLido,
    marcarTodosLidos,
  };
}
