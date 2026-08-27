'use client';

import { useMemo } from 'react';
import { getDoc, type Firestore } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import type { Produto } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { arquivoCollection } from '@delfrance/storage';
import { coverArquivoIds } from './fotoRefs';

/**
 * Lazy cover-photo URL resolution for produto rows. A produto's `fotos` carry
 * only arquivo REFS (`arquivos/<id>`); the public download `url` lives on the
 * arquivo doc, so a row cannot render a photo from the projected produto alone.
 *
 * Resolved per row with a ONE-SHOT cached `useQuery` keyed by the candidate
 * list — not a realtime listener per row. That matters on a list: `/produtos`
 * paints 50 rows at a time, and `ProdutoThumbnail`
 * (`components/ProdutoThumbnail.tsx`) would open 50 `onSnapshot` listeners for
 * data that does not change while you look at it. Keying by the ids also means
 * two produtos sharing a photo share one fetch, and `enabled` gates the query
 * so produtos WITHOUT a photo never read at all.
 *
 * Shared home (#159): the checkout panes and the /produtos Foto column both use
 * it. Typed structurally on `fotos` so `Produto` and the checkout engine's
 * `EngineProduto` (whose `fotos` is `Produto['fotos'] | null`) both fit.
 *
 * ⚠️ Which documents to try, and why the ladder is on document EXISTENCE rather
 * than on a non-null ref string, lives in the React-free `./fotoRefs` — the
 * print assembler needs the same ladder without pulling in React.
 */

export {
  type FotoVariante,
  PREFERENCIA_MINIATURA,
  arquivoIdFromRef,
  coverArquivoId,
  coverArquivoIds,
  fotoArquivoIdCandidates,
} from './fotoRefs';

/**
 * The first of `ids` whose `arquivos` document exists AND carries a `url`, read
 * live. Subscribes to one candidate at a time: the next listener only opens
 * once the one before it has resolved to nothing, and every later one is
 * released as soon as an earlier rung produces a url — so the steady state is
 * ONE listener per thumbnail, and the thumbnail still upgrades automatically
 * when the resize function later writes the derivative.
 *
 * ⚠️ Covers the first three candidates, because hooks cannot be called in a
 * loop. That is the whole ladder in practice: `PREFERENCIA_MINIATURA` has three
 * rungs and the last one is the original, which always exists.
 */
export function useFirstExistingArquivoUrl(
  db: Firestore,
  ids: readonly string[],
): { url: string | null; resolved: boolean } {
  const [id0, id1, id2] = ids;
  const ref0 = useMemo(() => (id0 ? arquivoCollection.docRef(db, {}, id0) : null), [db, id0]);
  const ref1 = useMemo(() => (id1 ? arquivoCollection.docRef(db, {}, id1) : null), [db, id1]);
  const ref2 = useMemo(() => (id2 ? arquivoCollection.docRef(db, {}, id2) : null), [db, id2]);

  // Each rung is gated on the one before it having produced no url — a missing
  // doc AND a doc whose `url` is still null (the transient state of the
  // create-first upload) both fall through. Passing `null` releases the listener.
  const snap0 = useDocSnapshot(ref0);
  const url0 = snap0.data?.data?.url ?? null;
  const snap1 = useDocSnapshot(url0 === null ? ref1 : null);
  const url1 = snap1.data?.data?.url ?? null;
  const snap2 = useDocSnapshot(url0 === null && url1 === null ? ref2 : null);
  const url2 = snap2.data?.data?.url ?? null;

  const url = url0 ?? url1 ?? url2;
  // Only the rung currently being read can hold us pending; a rung whose ref is
  // null is settled by definition (no candidate left to try).
  const pending =
    (ref0 !== null && snap0.loading) ||
    (ref1 !== null && url0 === null && snap1.loading) ||
    (ref2 !== null && url0 === null && url1 === null && snap2.loading);

  return { url, resolved: url !== null || !pending };
}

/**
 * The public URL of a produto's cover photo. Keyed by the candidate ids so two
 * rows sharing a photo share one fetch; `enabled` gates the query so produtos
 * without a foto never read.
 *
 * Returns `{ url, resolved }` rather than a bare `string | null` because a
 * caller has to tell PENDING from RESOLVED-TO-NOTHING. `url` is null in four
 * different situations — still fetching, the produto has no foto at all, every
 * arquivo doc it names is gone, and none of them carries a `url` — and a list
 * cell that reads null as "loading" skeletons forever on the last three.
 * `resolved` is true once there is nothing left to wait for.
 */
export function useProdutoFotoUrl(
  db: Firestore,
  produto: Pick<Produto, 'fotos'> | null | undefined,
): { url: string | null; resolved: boolean } {
  const arquivoIds = useMemo(() => coverArquivoIds(produto), [produto]);
  const query = useQuery({
    queryKey: ['produto-foto-capa', arquivoIds],
    enabled: arquivoIds.length > 0,
    // Photos are immutable within a session — cache aggressively.
    staleTime: Infinity,
    queryFn: async (): Promise<string | null> => {
      // Best first, stopping at the first candidate that actually resolves — a
      // missing derivative degrades to the original instead of to nothing.
      for (const id of arquivoIds) {
        const snap = await getDoc(arquivoCollection.docRef(db, {}, id));
        const url = snap.exists() ? (snap.data().url ?? null) : null;
        if (url !== null) return url;
      }
      return null;
    },
  });
  // No refs to resolve → already settled. Otherwise wait for success OR error:
  // a failed read is a resolved absence, not a permanent pending state.
  const resolved = arquivoIds.length === 0 || query.isSuccess || query.isError;
  return { url: query.data ?? null, resolved };
}
