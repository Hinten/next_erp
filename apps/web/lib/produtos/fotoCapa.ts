'use client';

import { useMemo } from 'react';
import { getDoc, type Firestore } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import type { Produto } from '@delfrance/schemas';
import { arquivoCollection } from '@delfrance/storage';

/**
 * Lazy cover-photo URL resolution for produto rows. A produto's `fotos` carry
 * only arquivo REFS (`arquivos/<id>`); the public download `url` lives on the
 * arquivo doc, so a row cannot render a photo from the projected produto alone.
 *
 * Resolved per row with a ONE-SHOT cached `useQuery` keyed by arquivo id — not
 * a realtime listener per row. That matters on a list: `/produtos` paints 50
 * rows at a time, and `ProdutoThumbnail` (`components/ProdutoThumbnail.tsx`)
 * would open 50 `onSnapshot` listeners for data that does not change while you
 * look at it. Keying by arquivo id also means two produtos sharing a photo share
 * one fetch, and `enabled` gates the query so produtos WITHOUT a photo never
 * read at all.
 *
 * Shared home (#159): the checkout panes and the /produtos Foto column both use
 * it. Typed structurally on `fotos` so `Produto` and the checkout engine's
 * `EngineProduto` (whose `fotos` is `Produto['fotos'] | null`) both fit.
 */

/** Bare `<id>` from a `Foto` ref string (`arquivos/<id>` or `documents/arquivos/<id>`). */
function arquivoIdFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const segs = ref.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  return last && last.length > 0 ? last : null;
}

/** The cover foto's small-derivative ref (200 → 400 → original), or null. */
export function coverArquivoId(produto: Pick<Produto, 'fotos'> | null | undefined): string | null {
  const foto = produto?.fotos?.[0];
  if (!foto) return null;
  return arquivoIdFromRef(
    foto.arquivo200pxOuterRef ?? foto.arquivo400pxOuterRef ?? foto.arquivoOuterRef,
  );
}

/**
 * The public URL of a produto's cover photo, or `null` while loading / when the
 * produto has none. Keyed by arquivo id so two rows sharing a photo share one
 * fetch; `enabled` gates the query so produtos without a foto never read.
 */
export function useProdutoFotoUrl(
  db: Firestore,
  produto: Pick<Produto, 'fotos'> | null | undefined,
): string | null {
  const arquivoId = useMemo(() => coverArquivoId(produto), [produto]);
  const query = useQuery({
    queryKey: ['produto-foto-capa', arquivoId],
    enabled: arquivoId !== null,
    // Photos are immutable within a session — cache aggressively.
    staleTime: Infinity,
    queryFn: async (): Promise<string | null> => {
      const snap = await getDoc(arquivoCollection.docRef(db, {}, arquivoId!));
      return snap.exists() ? (snap.data().url ?? null) : null;
    },
  });
  return query.data ?? null;
}
