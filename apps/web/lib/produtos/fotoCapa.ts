'use client';

import { useEffect, useMemo, useState } from 'react';
import { getDoc, onSnapshot, type Firestore } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import type { Produto } from '@delfrance/schemas';
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

/** Separator for the candidate-list dep key. NUL cannot occur in a Firestore id. */
const KEY_SEP = '\u0000';

/**
 * Mirrors `SERVER_SYNC_LISTEN_OPTIONS` in `packages/data/src/hooks/useSnapshot.ts`
 * (module-private there), and here it is **load-bearing, not a formality**.
 *
 * With the IndexedDB persistent cache, `onSnapshot` emits a `fromCache: true`
 * snapshot FIRST, and for a document the cache has never seen, that snapshot
 * says the document does not exist. Advancing on it would release the rung and
 * permanently pick a LOWER-quality photo for a derivative that IS present on
 * the server — a choice this hook cannot walk back, because the rung is already
 * released. Without these options the SDK also drops the cache→server
 * transition whenever the data is unchanged, so `fromCache` would never flip
 * and the mistake would be undetectable. Enforced repo-wide by
 * `packages/config-eslint/rules/snapshot-metadata-changes.test.js`.
 */
const SERVER_SYNC_LISTEN_OPTIONS = { includeMetadataChanges: true } as const;

/**
 * The first of `ids` whose `arquivos` document exists AND carries a `url`, read
 * live — walking the ladder with **exactly one `onSnapshot` open at a time**.
 * The winning rung stays subscribed, so a later edit to that document still
 * updates the thumbnail; every rung it rejected is released.
 *
 * ⚠️ **This is deliberately ONE effect, not a chain of `useDocSnapshot` calls
 * gated on each other.** That shape was tried and is measurably wrong, twice
 * over: `useDocSnapshot` starts at `{ data: undefined, loading: true }` and only
 * subscribes in an effect, so gating rung N+1 on "rung N has no url" opens ALL
 * of them on the first render (null reads as "still loading" and as "settled
 * empty"); and adding `&& !loading` does not fix it either, because a listener
 * that was just handed a new ref sits at `{ data: undefined, loading: false }`
 * for one render and reads as "settled empty" again. A correct chain needs to
 * know which ref the state belongs to — which is what walking the list inside a
 * single effect gives for free. The release is also one-directional in the
 * chained form: an EARLIER rung producing a url releases the later ones, but a
 * later rung producing it releases nothing, so the degraded case this whole PR
 * exists for held three permanent listeners per thumbnail. Reviewed on #1315.
 */
export function useFirstExistingArquivoUrl(
  db: Firestore,
  ids: readonly string[],
): { url: string | null; resolved: boolean } {
  // Depend on the CONTENT of `ids`, not its identity — callers rebuild the array
  // every render. Split back inside the effect so the dep list stays honest.
  const key = useMemo(() => ids.join(KEY_SEP), [ids]);
  const [state, setState] = useState<{ url: string | null; resolved: boolean; key: string }>(
    () => ({ url: null, resolved: false, key }),
  );

  useEffect(() => {
    // Nothing to resolve — answered at the return below, so the effect never
    // has to setState synchronously (react-hooks/set-state-in-effect).
    if (key === '') return;
    const lista = key.split(KEY_SEP);
    let cancelado = false;
    let unsub: (() => void) | undefined;

    // ⚠️ Advancing is deferred a microtask so that `unsub` is always assigned
    // before the next rung tries to release it. A snapshot callback can fire
    // BEFORE `onSnapshot` returns, and advancing inline from inside it would
    // read a stale `unsub` and leak the listener it meant to close.
    const percorrer = (i: number) => {
      if (cancelado) return;
      // Release the rung we are leaving BEFORE opening the next one.
      unsub?.();
      unsub = undefined;
      if (i >= lista.length) {
        setState({ url: null, resolved: true, key });
        return;
      }
      unsub = onSnapshot(
        arquivoCollection.docRef(db, {}, lista[i]!),
        SERVER_SYNC_LISTEN_OPTIONS,
        (snap) => {
          if (cancelado) return;
          // A missing doc AND a doc whose `url` is still null (the transient
          // state of a create-first upload) both fall through to the next rung.
          const url = snap.data()?.url ?? null;
          if (url === null) {
            // ⚠️ Only SERVER truth may advance. A `fromCache` snapshot reports
            // a never-cached document as absent, and advancing on that would
            // release this rung for good and settle on a lower-quality photo
            // that the server could have answered better. Holding costs a
            // skeleton for one round trip; advancing costs the right photo.
            if (snap.metadata.fromCache) return;
            queueMicrotask(() => percorrer(i + 1));
            return;
          }
          // `includeMetadataChanges` means re-emissions carrying identical data;
          // returning the previous object lets React bail out of the re-render.
          setState((anterior) =>
            anterior.key === key && anterior.url === url && anterior.resolved
              ? anterior
              : { url, resolved: true, key },
          );
        },
        // A denied/failed read is a resolved absence for this rung, not a stall.
        () => queueMicrotask(() => percorrer(i + 1)),
      );
    };
    percorrer(0);

    return () => {
      cancelado = true;
      unsub?.();
    };
  }, [db, key]);

  // No candidates at all — settled, with nothing to show. Derived rather than
  // stored so a produto swapped to one WITHOUT a photo settles immediately
  // instead of waiting for a state write the effect no longer makes.
  if (key === '') return { url: null, resolved: true };
  // Between a candidate change and the effect running, `state` still describes
  // the PREVIOUS list — report pending rather than the wrong photo.
  return state.key === key
    ? { url: state.url, resolved: state.resolved }
    : { url: null, resolved: false };
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
